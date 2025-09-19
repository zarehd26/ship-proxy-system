const net = require('net'); // TCP sockets
const tls = require('tls');  // TLS sockets
const http = require('http'); // HTTP server
const https = require('https'); // HTTPS requests
const url = require('url'); // URL parsing
const fs = require('fs'); // File system

const PORT = parseInt(process.env.PORT) || 9999;
const USE_TLS = process.env.USE_TLS === 'true';
const DEBUG = process.env.DEBUG === 'true';

function logDebug(...args) { // Debug logging
  if (DEBUG) console.log('[OffshoreProxy Debug]', ...args);
}

let clientSocket = null; // Connected ship proxy socket
let requestQueue = []; // Request queue
let processing = false; // Processing flag

function logQueueLengthWarn() { // Warn if queue length is high
  if (requestQueue.length > 100) {
    console.warn(`[OffshoreProxy WARN] Queue length is high: ${requestQueue.length}. Possible delay.`);
  }
}

function sendFramedMessage(sock, msgType, payloadBuffer) { // Send framed message
  if (!sock || sock.destroyed) return;  // Socket not connected
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payloadBuffer.length, 0); // Message length
  const type = Buffer.from([msgType]);
  sock.write(Buffer.concat([length, type, payloadBuffer])); // Send message
}

function handleRequestQueue() { // Process request queue
  if (processing || requestQueue.length === 0 || !clientSocket || clientSocket.destroyed) return;
  processing = true;

  const msg = requestQueue[0]; // Peek at first request

  try {
    const reqObj = JSON.parse(msg.toString()); // Parse request

    // CONNECT tunneling
    if (reqObj.method && reqObj.method.toUpperCase() === 'CONNECT' && reqObj.url) { // CONNECT request
      logDebug(`[OffshoreProxy] CONNECT request for ${reqObj.url}`);
      const [host, portStr] = reqObj.url.split(':'); // Split host and port
      const port = parseInt(portStr) || 443; // Default to 443 if no port

      const remoteSocket = net.connect(port, host, () => { // Connected to target
        logDebug(`[OffshoreProxy] CONNECT established to ${host}:${port}`);
        sendFramedMessage(clientSocket, 1, Buffer.from('OK')); // Send success to client
      });

      remoteSocket.on('error', (err) => { // Handle remote errors
        console.error(`[OffshoreProxy ERROR] CONNECT failed: ${err.message}`);
        sendFramedMessage(clientSocket, 1, Buffer.from('FAIL'));
        cleanupRequest(); // Clean up and process next
      });

      remoteSocket.on('close', () => { // Handle remote close
        logDebug('[OffshoreProxy] Remote socket closed (CONNECT)');
        cleanupRequest();
      });

      return; // leave processing true until remote closes
    }

    // Normal HTTP(S) request
    logDebug(`[OffshoreProxy] HTTP request: ${reqObj.method} ${reqObj.url}`); // Log request

    let requestUrl = reqObj.url || reqObj.path || '/'; // Get URL or path
    if (!/^https?:\/\//i.test(requestUrl)) { // If no scheme, add http://
      requestUrl = 'http://' + reqObj.headers.host + requestUrl; // Assume http
    }

    const parsedUrl = url.parse(requestUrl); 

    const options = { // Request options
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.path,
      method: reqObj.method,
      headers: reqObj.headers,
    };

    const lib = parsedUrl.protocol === 'https:' ? https : http; // Choose lib based on protocol

    const forwardReq = lib.request(options, (res) => { // Forward request
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { // Response ended
        const body = Buffer.concat(chunks); // Full response body
        const responseMsg = JSON.stringify({
          statusCode: res.statusCode,
          headers: res.headers,
          body: body.toString('base64'),
        });
        sendFramedMessage(clientSocket, 1, Buffer.from(responseMsg)); // Send response back
        cleanupRequest(); // Clean up and process next
      });
    });

    forwardReq.on('error', (err) => { // Handle request errors
      console.error(`[OffshoreProxy ERROR] Forwarding error: ${err.message}`); 
      const errorResp = JSON.stringify({
        statusCode: 502,
        headers: {},
        body: Buffer.from(err.message).toString('base64'),
      }); // Bad Gateway
      sendFramedMessage(clientSocket, 1, Buffer.from(errorResp));
      cleanupRequest();
    });

    if (reqObj.body) { // If there's a body, write it
      const bodyBuffer = Buffer.from(reqObj.body, 'base64'); // Decode body
      forwardReq.write(bodyBuffer);  // Write body
    }
    forwardReq.end();

  } catch (e) {
    console.error(`[OffshoreProxy ERROR] Processing failed: ${e.message}`); // JSON parse or other error
    cleanupRequest();
  }
}

function cleanupRequest() { // Clean up after request
  processing = false;
  requestQueue.shift();
  handleRequestQueue();
}

function handleClient(socket) { // Handle new client connection
  if (clientSocket) {
    console.warn('[OffshoreProxy] Rejecting extra client');
    socket.end();
    return;
  }

  clientSocket = socket;// Set current client socket
  logDebug('[OffshoreProxy] Client connected');

  let buffer = Buffer.alloc(0); // Buffer for incoming data
  socket.on('data', (chunk) => { // Data received
    buffer = Buffer.concat([buffer, chunk]); // Append to buffer
    while (buffer.length >= 5) {  // At least 4 bytes length + 1 byte type
      const len = buffer.readUInt32BE(0);
      if (buffer.length >= len + 5) { // Full message received
        const msgType = buffer.readUInt8(4); // Message type
        if (msgType !== 0) {
          console.warn(`[OffshoreProxy WARN] Unknown message type: ${msgType}`);
          buffer = buffer.slice(5 + len);
          continue;
        }
        const msg = buffer.slice(5, 5 + len); // Message payload
        requestQueue.push(msg);
        logDebug(`[OffshoreProxy] Request enqueued (queue=${requestQueue.length})`); 
        logQueueLengthWarn();
        handleRequestQueue();
        buffer = buffer.slice(5 + len); // Remove processed message
      } else break;
    }
  });

  socket.on('error', (err) => { // Handle socket errors
    console.error(`[OffshoreProxy ERROR] Client socket error: ${err.message}`);
  });

  socket.on('close', () => { // Handle socket close
    logDebug('[OffshoreProxy] Client disconnected');
    clientSocket = null;
    processing = false;
    requestQueue = [];
  });
}

const server = USE_TLS // Use TLS if configured
  ? tls.createServer({ // TLS options
      key: fs.readFileSync(process.env.TLS_KEY_PATH),
      cert: fs.readFileSync(process.env.TLS_CERT_PATH),
      rejectUnauthorized: false,
    }, handleClient) 
  : net.createServer(handleClient); // TCP server

server.listen(PORT, () => { // Start server
  console.log(`[OffshoreProxy] Listening on port ${PORT} ${USE_TLS ? 'TLS' : 'TCP'}`); 
});
