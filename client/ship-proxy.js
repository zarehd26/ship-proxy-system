const net = require('net'); //  TCP sockets 
const tls = require('tls'); // TLS sockets
const http = require('http'); // HTTP server
const { sendMessage, setupMessageReader } = require('./framing'); // message framing

const LOCAL_PORT = parseInt(process.env.LOCAL_PORT) || 8080; // Port for local HTTP proxy
const OFFSHORE_HOST = process.env.OFFSHORE_HOST || 'localhost';// Offshore server address
const OFFSHORE_PORT = parseInt(process.env.OFFSHORE_PORT) || 9999;// Offshore server port
const USE_TLS = process.env.USE_TLS === 'true';// Use TLS for offshore connection
const DEBUG = process.env.DEBUG === 'true';// Enable debug logging

const RECONNECT_MS = 5000;// Time between reconnection attempts
const OFFSHORE_RESPONSE_TIMEOUT_MS = 20000;// Time to wait for offshore response

let offshoreSocket = null;// Socket to offshore server
let reconnectTimer = null;// Timer for reconnection attempts

const queue = [];  // Request queue
let processing = false;

function logDebug(...args) {// Debug logging
  if (DEBUG) console.log(...args);
}

function logQueueLengthWarn() {// Warn if queue length is high
  if (queue.length > 100) {
    console.warn(`[ShipProxy WARN] Queue length is high: ${queue.length}. Possible request delay.`);
  }
}

function connectToOffshore() {// Connect to offshore server
  if (offshoreSocket && !offshoreSocket.destroyed) return;// Already connected

  const connectOptions = { host: OFFSHORE_HOST, port: OFFSHORE_PORT };
  if (USE_TLS) connectOptions.rejectUnauthorized = false;// Accept self-signed certs

  offshoreSocket = USE_TLS ? tls.connect(connectOptions) : net.createConnection(connectOptions);// Create socket

  offshoreSocket.on('connect', () => {// On successful connection
    console.log(`[ShipProxy] Connected to offshore server at ${OFFSHORE_HOST}:${OFFSHORE_PORT} using ${USE_TLS ? 'TLS' : 'TCP'}`);
    if (reconnectTimer) { // Clear reconnection timer
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    processingLoop();// Start processing queue
  });

  offshoreSocket.on('error', (err) => { // Handle connection errors
    console.error(`[ShipProxy ERROR] Offshore connection error: ${err.message}`);
    try { offshoreSocket.destroy(); } catch {}
    if (!reconnectTimer) reconnectTimer = setTimeout(connectToOffshore, RECONNECT_MS);
  });

  offshoreSocket.on('close', () => {// Handle disconnection
    console.warn('[ShipProxy WARN] Connection to offshore server closed');
    processing = false;
    if (!reconnectTimer) reconnectTimer = setTimeout(connectToOffshore, RECONNECT_MS);
  });

  setupMessageReader(offshoreSocket, (msgType, payload) => {// Handle incoming messages
    if (msgType !== 1) {// Expecting response messages
      console.warn(`[ShipProxy WARN] Unknown message type from offshore: ${msgType}`);
      return;
    }
    if (queue.length > 0 && queue[0].resolveResponse) {// Resolve the response promise for the current request
      queue[0].resolveResponse(payload);
    }
  });
}

// enqueue request
function enqueueRequest(req, res, isConnect = false, clientSocket = null, head = null) { // head for CONNECT
  const requestObj = { 
    req, res, isConnect, clientSocket, head,
    resolveResponse: null,
    responsePromise: null,
  };

  requestObj.responsePromise = new Promise((resolve) => { // Will be resolved when response is received
    requestObj.resolveResponse = resolve;
  });

  queue.push(requestObj);// Add to queue
  logDebug(`[ShipProxy] Request enqueued. Queue length: ${queue.length}`);
  logQueueLengthWarn();

  if (!processing) processingLoop(); // Start processing if not already
}

// main processing loop
async function processingLoop() { 
  if (processing || queue.length === 0) return;  // Already processing or nothing to do
  processing = true;
  const current = queue[0];

  try {
    if (!current.isConnect) { 
      // HTTP → forward offshore
      if (!offshoreSocket || offshoreSocket.destroyed) { // Ensure connection
        connectToOffshore();
        await new Promise(r => setTimeout(r, 200));
        if (!offshoreSocket || offshoreSocket.destroyed) { // Still not connected
          if (current.res) {
            current.res.writeHead(502);
            current.res.end('Bad Gateway: offshore unavailable');
          }
          queue.shift();
          processing = false;
          return processingLoop();
        }
      }

      const bodyChunks = []; // Read request body
      current.req.on('data', chunk => bodyChunks.push(chunk));
      await new Promise((resolve) => current.req.on('end', resolve));
      const bodyBase64 = Buffer.concat(bodyChunks).toString('base64');// Encode body as base64

      const requestPayload = { // Prepare request payload
        type: 'http',
        method: current.req.method,
        url: current.req.url,
        headers: current.req.headers,
        body: bodyBase64,
      };

      logDebug(`[ShipProxy] Sending HTTP request offshore: ${current.req.method} ${current.req.url}`);
      sendMessage(offshoreSocket, 0, Buffer.from(JSON.stringify(requestPayload))); // Send request

      let responsePayload;// Wait for response with timeout
      try {
        responsePayload = await promiseWithTimeout(current.responsePromise, OFFSHORE_RESPONSE_TIMEOUT_MS);
      } catch {
        responsePayload = undefined;
      }

      if (!responsePayload) { // Timeout or no response
        console.error('[ShipProxy ERROR] Offshore did not respond (timeout)');
        if (current.res) {
          current.res.writeHead(504);
          current.res.end('Gateway Timeout');
        }
      } else { // Got response
        try {
          const responseObj = JSON.parse(responsePayload.toString()); // Parse response
          current.res.writeHead(responseObj.statusCode || 200, responseObj.headers || {}); // Write headers
          current.res.end(Buffer.from(responseObj.body || '', 'base64'));// Write body
          logDebug(`[ShipProxy] Response relayed: ${responseObj.statusCode}`);// Success
        } catch (e) {
          console.error(`[ShipProxy ERROR] Malformed offshore response: ${e.message}`);
          if (current.res) current.res.end('Bad Gateway');
        }
      }

    } else {
      // CONNECT → direct tunnel
      const connectTarget = current.req.url || '';  
      let host, port;
      if (connectTarget.includes(':')) {// host:port
        [host, port] = connectTarget.split(':');
        port = parseInt(port, 10) || 443;
      } else {// No port, default to 443
        host = current.req.headers.host;
        port = 443;
      }

      logDebug(`[ShipProxy] CONNECT tunnel to ${host}:${port}`);

      const remote = net.connect(port, host, () => { // Connected to target
        current.clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        current.clientSocket.pipe(remote);
        remote.pipe(current.clientSocket);
      });

      remote.on('error', (err) => { // Handle remote errors
        console.error(`[ShipProxy ERROR] Remote error: ${err.message}`);
        try { current.clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
      });

      current.clientSocket.on('error', (err) => { // Handle client socket errors
        logDebug(`[ShipProxy] Client socket error during CONNECT: ${err.message}`);
        try { remote.destroy(); } catch {}
      });

      current.clientSocket.on('close', () => { // Handle client socket close
        logDebug('[ShipProxy] Client socket closed (CONNECT)');
        try { remote.destroy(); } catch {} // Ensure remote is closed
        processing = false;
        queue.shift();
        processingLoop();
      });

      remote.on('close', () => {// Handle remote close
        logDebug('[ShipProxy] Remote closed (CONNECT)');
        try { current.clientSocket.end(); } catch {}  // Ensure client socket is closed
        processing = false;
        queue.shift();
        processingLoop();
      });

      return; // CONNECT handled asynchronously
    }
  } catch (e) {
    console.error(`[ShipProxy ERROR] Processing error: ${e.message}`);
    if (current.res) { try { current.res.end('Broker error'); } catch {} }// End response on error
    if (current.clientSocket) { try { current.clientSocket.end(); } catch {} }// End client socket on error
  }

  queue.shift();// Remove processed request
  processing = false;
  processingLoop();// Process next request
}

// helper: promise timeout
function promiseWithTimeout(promise, ms) { 
  return new Promise((resolve) => { // Resolve with undefined on timeout
    const t = setTimeout(() => resolve(undefined), ms); // Timeout
    promise.then((res) => { clearTimeout(t); resolve(res); })
           .catch(() => { clearTimeout(t); resolve(undefined); });
  });
}

// HTTP proxy server
const proxyServer = http.createServer((req, res) => enqueueRequest(req, res));
proxyServer.on('connect', (req, clientSocket, head) => {// Handle CONNECT
  enqueueRequest(req, null, true, clientSocket, head);
  clientSocket.on('error', (err) => {
    logDebug(`[ShipProxy] Client socket error: ${err.message}`);
  });
});

proxyServer.listen(LOCAL_PORT, () => { // Start server
  console.log(`[ShipProxy] HTTP Proxy server listening on port ${LOCAL_PORT}`);
  connectToOffshore();
});
