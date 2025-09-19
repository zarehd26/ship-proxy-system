//provides framing helpers for ship-proxy.js

//sends a message with a type and payload buffer over a socket
function sendMessage(sock, msgTpe, payLoadBuffer){
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payLoadBuffer.length, 0);
    const typer = Buffer.from([msgTpe]);
    sock.write(Buffer.concat([length, typer, payLoadBuffer]));  
}

//setups a message reader on a socket that calls a callback with the message type and payload buffer
function setupMessageReader(sock, onMessage){
    let buffer  = Buffer.alloc(0);
    sock.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while(buffer.length >= 5){
            const msgLength = buffer.readUInt32BE(0);
            if(buffer.length >= msgLength + 5){
                const msgType = buffer[4];
                const payload = buffer.slice(5, 5 + msgLength);
                onMessage(msgType, payload);
                buffer = buffer.slice(5 + msgLength);
            } else {
                break;
            }
        }
    });
}

module.exports = {sendMessage, setupMessageReader};