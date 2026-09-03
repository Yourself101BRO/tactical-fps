// Transport contract shared by the WebSocket server, the browser P2P host and
// in-process play. Pure TypeScript: no DOM, no Node APIs, no clocks; the
// LocalTransport receives time through `advance(nowMs)` so tests stay deterministic.
//
// Ordering contract (the same on every path): delivery is NOT guaranteed to be
// in order. The WebSocket path is ordered in practice, but the PeerJS game
// channel is `ordered: false` while still reliable (PeerJS never sets
// maxRetransmits), so stale frames arrive late rather than being dropped.
// Receivers must therefore drop anything older than what they have already
// applied: `EntityBuffer.push` rejects ticks <= newest buffered, and
// `World.applyInput` rejects `cmd.seq <= lastAppliedSeq`.

export interface Transport {
  /** Stable per-connection id assigned by the host. */
  readonly id: number;
  /** Queue a binary frame for the peer. Must never throw after close(). */
  send(data: Uint8Array): void;
  /** Close the connection; onClose fires exactly once. */
  close(): void;
  /** Set by the owner. Called with a fresh Uint8Array view per frame. */
  onMessage: (data: Uint8Array) => void;
  /** Set by the owner. */
  onClose: () => void;
}

export interface LocalLinkOptions {
  /** One-way latency in milliseconds. */
  latencyMs?: number;
  /** Uniform random jitter added to each frame's latency, in milliseconds. */
  jitterMs?: number;
  /** Probability [0,1] that a frame is dropped. */
  lossPct?: number;
  /** Deterministic RNG in [0,1); defaults to a fixed-seed LCG so tests are repeatable. */
  random?: () => number;
}

interface QueuedFrame {
  deliverAt: number;
  data: Uint8Array;
}

let nextLocalId = 1;

/**
 * In-process transport. `LocalTransport.pair()` returns two linked endpoints:
 * frames sent on one are delivered to the other when `advance(nowMs)` is called
 * on the *receiving* endpoint with a time past the frame's delivery time. With
 * no options, `advance` delivers immediately (latency 0, no loss).
 */
export class LocalTransport implements Transport {
  readonly id: number;
  onMessage: (data: Uint8Array) => void = () => {};
  onClose: () => void = () => {};

  private peer: LocalTransport | null = null;
  private readonly inbox: QueuedFrame[] = [];
  private closed = false;
  private now = 0;
  private readonly opts: Required<LocalLinkOptions>;

  private constructor(opts: LocalLinkOptions) {
    this.id = nextLocalId++;
    let seed = 0x9e3779b9;
    const lcg = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    this.opts = {
      latencyMs: opts.latencyMs ?? 0,
      jitterMs: opts.jitterMs ?? 0,
      lossPct: opts.lossPct ?? 0,
      random: opts.random ?? lcg,
    };
  }

  /** Create two linked endpoints. Options apply symmetrically to both directions. */
  static pair(opts: LocalLinkOptions = {}): [LocalTransport, LocalTransport] {
    const a = new LocalTransport(opts);
    const b = new LocalTransport(opts);
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  send(data: Uint8Array): void {
    if (this.closed || !this.peer || this.peer.closed) return;
    const o = this.opts;
    if (o.lossPct > 0 && o.random() < o.lossPct) return;
    const delay = o.latencyMs + (o.jitterMs > 0 ? o.random() * o.jitterMs : 0);
    // Copy so the sender may reuse its buffer.
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    const frame: QueuedFrame = { deliverAt: this.now + delay, data: copy };
    const inbox = this.peer.inbox;
    if (delay === 0 && o.jitterMs === 0) {
      inbox.push(frame);
      this.peer.flush();
      return;
    }
    // Keep the inbox sorted by delivery time; jitter can reorder frames, which is
    // exactly the behaviour receivers must tolerate.
    let i = inbox.length;
    while (i > 0 && inbox[i - 1]!.deliverAt > frame.deliverAt) i--;
    inbox.splice(i, 0, frame);
  }

  /** Advance this endpoint's clock and deliver every frame that is due. */
  advance(nowMs: number): void {
    this.now = nowMs;
    if (this.peer) this.peer.now = Math.max(this.peer.now, nowMs);
    this.flush();
  }

  private flush(): void {
    if (this.closed) return;
    while (this.inbox.length > 0 && this.inbox[0]!.deliverAt <= this.now) {
      const frame = this.inbox.shift()!;
      this.onMessage(frame.data);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.inbox.length = 0;
    const peer = this.peer;
    this.peer = null;
    this.onClose();
    if (peer && !peer.closed) peer.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
