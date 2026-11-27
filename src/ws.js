// A small, dependency-free WebSocket server (RFC 6455): text frames, ping/pong,
// close, fragmentation, and a payload cap. Enough for a live feed.

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1 << 20;

export class WsServer extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();
  }

  // Call from http server 'upgrade'. `accept` lets the caller authorize first.
  handleUpgrade(req, socket, head, meta = {}) {
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return null;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'));
    socket.setNoDelay(true);
    const client = new WsClient(socket, meta);
    if (head?.length) client.onData(head);
    this.clients.add(client);
    client.on('close', () => this.clients.delete(client));
    this.emit('connection', client, req);
    return client;
  }

  broadcast(data, filter = () => true) {
    const msg = typeof data === 'string' ? data : JSON.stringify(data);
    for (const c of this.clients) if (filter(c)) c.send(msg);
  }

  closeAll() {
    for (const c of this.clients) c.close();
  }
}

export class WsClient extends EventEmitter {
  constructor(socket, meta) {
    super();
    this.socket = socket;
    this.meta = meta;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.open = true;
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.terminate());
    socket.on('error', () => this.terminate());
    this.alive = true;
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) return this.close(1009);
        len = Number(big); off = 10;
      }
      if (len > MAX_PAYLOAD) return this.close(1009);
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      let payload = this.buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buf = this.buf.subarray(off + maskLen + len);
      this.onFrame(fin, op, payload);
    }
  }

  onFrame(fin, op, payload) {
    if (op === 0x8) { this.close(); return; }
    if (op === 0x9) { this.frame(0xa, payload); return; }
    if (op === 0xa) { this.alive = true; return; }
    if (op === 0x1 || op === 0x2 || op === 0x0) {
      this.fragments.push(payload);
      if (!fin) return;
      const msg = Buffer.concat(this.fragments).toString('utf8');
      this.fragments = [];
      let parsed = msg;
      try { parsed = JSON.parse(msg); } catch { /* keep text */ }
      this.emit('message', parsed);
    }
  }

  frame(op, payload) {
    if (!this.open) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | op, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
    }
    try { this.socket.write(Buffer.concat([header, payload])); } catch { this.terminate(); }
  }

  send(data) {
    this.frame(0x1, Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8'));
  }

  ping() {
    this.alive = false;
    this.frame(0x9, Buffer.alloc(0));
  }

  close(code = 1000) {
    if (!this.open) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code, 0);
    this.frame(0x8, p);
    this.terminate();
  }

  terminate() {
    if (!this.open) return;
    this.open = false;
    try { this.socket.end(); } catch { /* ignore */ }
    this.emit('close');
  }
}
