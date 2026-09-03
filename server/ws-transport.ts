// Transport implementation over a `ws` WebSocket connection. Binary frames
// only; drops outgoing frames when the socket's send buffer backs up, except
// for the small set of messages a client cannot afford to miss.

import type WebSocket from 'ws';
import type { Transport } from '../shared/net/transport.ts';
import { WS_BACKPRESSURE_BYTES } from '../shared/constants.ts';
import { MSG_ERROR, MSG_HELLO, MSG_MATCH_END, MSG_ROOM_STATE, MSG_WELCOME, peekMessageId } from '../shared/protocol.ts';

/** Frame kinds that are always sent even while the socket is backed up. */
const NEVER_DROP = new Set<number>([MSG_HELLO, MSG_WELCOME, MSG_ROOM_STATE, MSG_MATCH_END, MSG_ERROR]);

let nextId = 1;

export class WsTransport implements Transport {
  readonly id: number;
  onMessage: (data: Uint8Array) => void = () => {};
  onClose: () => void = () => {};

  private readonly ws: WebSocket;
  private closed = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.id = nextId++;
    this.ws.binaryType = 'nodebuffer';

    this.ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (this.closed || !isBinary) return;
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      this.onMessage(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    });
    this.ws.on('close', () => this.handleClose());
    this.ws.on('error', () => this.handleClose());
  }

  send(data: Uint8Array): void {
    if (this.closed) return;
    if (this.ws.readyState !== this.ws.OPEN) return;
    const id = peekMessageId(data);
    if (!NEVER_DROP.has(id) && this.ws.bufferedAmount > WS_BACKPRESSURE_BYTES) return;
    this.ws.send(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Contract: onClose fires exactly once, including when we initiate the close (kicks rely on it).
    this.onClose();
    try {
      this.ws.close();
    } catch {
      // Already closing/closed; nothing to do.
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }
}
