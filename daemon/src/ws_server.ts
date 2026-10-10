import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Channel } from './util/sync';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export type Incoming = { type: 'text'; data: string } | { type: 'binary'; data: Buffer };

/** Answers a WebSocket upgrade request. Returns undefined and rejects the request when it is not valid. */
export function acceptUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, maxMessage: number): WebSocketConnection | undefined {
  const key = request.headers['sec-websocket-key'];
  const upgrade = String(request.headers.upgrade ?? '').toLowerCase();
  if (request.method !== 'GET' || upgrade !== 'websocket' || typeof key !== 'string' || request.headers['sec-websocket-version'] !== '13') {
    reject(socket, 400, 'Bad Request');
    return undefined;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  return new WebSocketConnection(socket, head, maxMessage);
}

export function reject(socket: Duplex, status: number, text: string, body = ''): void {
  try {
    socket.end('HTTP/1.1 ' + status + ' ' + text + '\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
  } catch { /* socket already closed */ }
  setTimeout(() => socket.destroy(), 1000).unref();
}

/** One server side WebSocket connection. */
export class WebSocketConnection {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentType = 0;
  private messages = new Channel<Incoming>();
  private closeSent = false;
  closed = false;

  constructor(private socket: Duplex, head: Buffer, private maxMessage: number) {
    socket.on('data', (data: Buffer) => this.receive(data));
    socket.on('close', () => this.finish());
    socket.on('end', () => this.finish());
    socket.on('error', () => this.finish());
    if (head.length) this.receive(head);
  }

  /** Returns the next text or binary message, or undefined after the connection closes. */
  next(): Promise<Incoming | undefined> { return this.messages.recv(); }

  sendText(text: string): Promise<void> { return this.frame(0x1, Buffer.from(text, 'utf8')); }

  ping(): Promise<void> { return this.frame(0x9, Buffer.alloc(0)); }

  async close(code = 1000): Promise<void> {
    if (this.closed) return;
    if (!this.closeSent) {
      this.closeSent = true;
      const body = Buffer.alloc(2);
      body.writeUInt16BE(code);
      try { await this.frame(0x8, body, true); } catch { /* closing anyway */ }
    }
    try { this.socket.end(); } catch { /* closed */ }
    setTimeout(() => this.terminate(), 2000).unref();
  }

  terminate(): void {
    try { this.socket.destroy(); } catch { /* closed */ }
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.messages.close();
    try { this.socket.destroy(); } catch { /* closed */ }
  }

  private frame(opcode: number, payload: Buffer, force = false): Promise<void> {
    if (this.closed || (this.closeSent && !force)) return Promise.reject(new Error('WebSocket is closed'));
    let header: Buffer;
    if (payload.length < 126) { header = Buffer.alloc(2); header[1] = payload.length; }
    else if (payload.length < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(payload.length, 2); }
    else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
    header[0] = 0x80 | opcode;
    return new Promise((resolve, rejectWrite) => {
      this.socket.write(Buffer.concat([header, payload]), error => error ? rejectWrite(error) : resolve());
    });
  }

  private peek(count: number): Buffer {
    if (this.chunks[0]!.length >= count) return this.chunks[0]!;
    const joined = Buffer.concat(this.chunks);
    this.chunks = [joined];
    return joined;
  }

  private take(count: number): Buffer {
    const joined = this.peek(count);
    const result = joined.subarray(0, count);
    const rest = joined.subarray(count);
    this.chunks = rest.length ? [rest] : [];
    this.buffered -= count;
    return result;
  }

  private fail(code: number): void {
    this.close(code).catch(() => undefined);
    this.messages.close();
    this.chunks = [];
    this.buffered = 0;
  }

  private receive(data: Buffer): void {
    if (this.closed || this.messages.isClosed) return;
    this.chunks.push(data);
    this.buffered += data.length;
    while (this.buffered >= 2 && !this.messages.isClosed) {
      const start = this.peek(2);
      const fin = (start[0]! & 0x80) !== 0;
      const opcode = start[0]! & 0x0f;
      const masked = (start[1]! & 0x80) !== 0;
      let length = start[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffered < 4) return;
        length = this.peek(4).readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffered < 10) return;
        const big = this.peek(10).readBigUInt64BE(2);
        if (big > BigInt(this.maxMessage)) { this.fail(1009); return; }
        length = Number(big);
        offset = 10;
      }
      if (!masked) { this.fail(1002); return; }
      if (length > this.maxMessage) { this.fail(1009); return; }
      if (this.buffered < offset + 4 + length) return;
      const frame = this.take(offset + 4 + length);
      const mask = frame.subarray(offset, offset + 4);
      const payload = Buffer.from(frame.subarray(offset + 4));
      for (let index = 0; index < payload.length; index++) payload[index]! ^= mask[index & 3]!;
      this.handle(fin, opcode, payload);
    }
  }

  private handle(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) { this.fail(1002); return; }
      if (opcode === 0x8) {
        if (!this.closeSent) {
          this.closeSent = true;
          this.frame(0x8, payload.subarray(0, 2), true).catch(() => undefined).finally(() => { try { this.socket.end(); } catch { /* closed */ } });
        }
        this.messages.close();
        setTimeout(() => this.terminate(), 2000).unref();
        return;
      }
      if (opcode === 0x9) { this.frame(0xa, payload).catch(() => undefined); return; }
      if (opcode === 0xa) { this.messages.send({ type: 'binary', data: Buffer.alloc(0) }); return; }
      this.fail(1002);
      return;
    }
    if (opcode === 0x0) {
      if (!this.fragmentType) { this.fail(1002); return; }
    } else if (opcode === 0x1 || opcode === 0x2) {
      if (this.fragmentType) { this.fail(1002); return; }
      this.fragmentType = opcode;
    } else { this.fail(1002); return; }
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > this.maxMessage) { this.fail(1009); return; }
    this.fragments.push(payload);
    if (!fin) return;
    const body = this.fragments.length === 1 ? this.fragments[0]! : Buffer.concat(this.fragments);
    const type = this.fragmentType;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentType = 0;
    if (type === 0x1) {
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { this.fail(1007); return; }
      this.messages.send({ type: 'text', data: text });
    } else this.messages.send({ type: 'binary', data: body });
  }
}
