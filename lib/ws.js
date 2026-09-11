'use strict';
/**
 * Servidor WebSocket minimo (RFC 6455) sin dependencias externas.
 * Soporta texto, fragmentacion, ping/pong y cierre limpio.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 4 * 1024 * 1024; // 4 MiB: suficiente para SDP de WebRTC

class WebSocketConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.open = true;
    this.remoteAddress = normalizeAddress(socket.remoteAddress);
    this.data = {};
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = 0;
    this._alive = true;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => this.close());
    socket.on('close', () => this._finish());
    socket.setTimeout(0);
    socket.setNoDelay(true);

    this._pingTimer = setInterval(() => {
      if (!this.open) return;
      if (!this._alive) return this.close();
      this._alive = false;
      this._send(0x9, Buffer.alloc(0));
    }, 25000);
  }

  send(obj) {
    if (!this.open) return false;
    const payload = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
    return this._send(0x1, payload);
  }

  _send(opcode, payload) {
    if (!this.open) return false;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
      return true;
    } catch (err) {
      this.close();
      return false;
    }
  }

  close(code) {
    if (!this.open) return;
    this.open = false;
    clearInterval(this._pingTimer);
    try {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code || 1000, 0);
      this._sendRaw(0x8, payload);
      this.socket.end();
    } catch (err) { /* socket ya cerrado */ }
    setTimeout(() => { try { this.socket.destroy(); } catch (e) {} }, 200).unref();
    this._finish();
  }

  _sendRaw(opcode, payload) {
    const header = Buffer.from([0x80 | opcode, payload.length]);
    this.socket.write(Buffer.concat([header, payload]));
  }

  _finish() {
    clearInterval(this._pingTimer);
    if (this._finished) return;
    this._finished = true;
    this.open = false;
    this.emit('close');
  }

  _onData(chunk) {
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
    while (this._buffer.length >= 2) {
      const b0 = this._buffer[0];
      const b1 = this._buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this._buffer.length < offset + 2) return;
        length = this._buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this._buffer.length < offset + 8) return;
        const big = this._buffer.readBigUInt64BE(offset);
        if (big > BigInt(MAX_PAYLOAD)) return this.close(1009);
        length = Number(big);
        offset += 8;
      }
      if (length > MAX_PAYLOAD) return this.close(1009);
      if (masked) {
        if (this._buffer.length < offset + 4) return;
      }
      const maskKey = masked ? this._buffer.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (this._buffer.length < offset + length) return;

      const payload = Buffer.from(this._buffer.subarray(offset, offset + length));
      if (maskKey) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      }
      this._buffer = this._buffer.subarray(offset + length);

      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this._send(0xa, payload); continue; }
      if (opcode === 0xa) { this._alive = true; continue; }

      if (opcode === 0x0) {
        this._fragments.push(payload);
      } else {
        this._fragments = [payload];
        this._fragmentOpcode = opcode;
      }
      if (!fin) continue;

      const full = Buffer.concat(this._fragments);
      this._fragments = [];
      if (this._fragmentOpcode === 0x1) {
        this._alive = true;
        let parsed = null;
        try {
          parsed = JSON.parse(full.toString('utf8'));
        } catch (err) {
          continue; // mensaje malformado: se ignora
        }
        this.emit('message', parsed);
      }
    }
  }
}

function normalizeAddress(addr) {
  if (!addr) return '';
  return addr.replace(/^::ffff:/, '');
}

/** Conecta el servidor WebSocket a un servidor HTTP/HTTPS existente. */
function attach(server, path, onConnection) {
  server.on('upgrade', (req, socket, head) => {
    const url = (req.url || '').split('?')[0];
    if (url !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    const conn = new WebSocketConnection(socket, req);
    if (head && head.length) conn._onData(head);
    onConnection(conn, req);
  });
}

module.exports = { attach, WebSocketConnection };
