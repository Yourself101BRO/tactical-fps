// The client's networking front door. One `ClientNet` wraps exactly one of
// three transports (WebSocket, PeerJS, in-process) behind a single message-
// routing, ping/RTT and clock-sync surface, so the rest of the client never
// has to branch on which path it is talking over. See plan §3 and §9.
//
// This file, and client/net/peer-host.ts, independently implement the same
// "route by message id onto the reliable or unreliable PeerJS channel" rule
// (see RELIABLE_MSG_IDS below). They are not allowed to share that constant
// via import: peer-host.ts already imports ClientNet from here (to run the
// host's own in-process player), and the reverse import would make the two
// modules circular. Keeping both copies small and next to their message-id
// list keeps that duplication safe to eyeball.

import { Peer } from 'peerjs';
import type { DataConnection } from 'peerjs';

import {
  CLOCK_SLEW_TICKS_PER_MS,
  P2P_CONNECT_TIMEOUT_MS,
  PEER_ID_PREFIX,
  PING_INTERVAL_MS,
  RECONNECT_TIMEOUT_MS,
  RTT_EMA_ALPHA,
  RTT_MIN_WINDOW,
  STALL_MS,
  TICK_DT,
} from '../../shared/constants.ts';
import {
  MSG_CHAT,
  MSG_ERROR,
  MSG_HELLO,
  MSG_LOADOUT,
  MSG_LOBBY_CMD,
  MSG_MATCH_END,
  MSG_ROOM_STATE,
  decodeMessage,
  encodeChat,
  encodeHello,
  encodeInput,
  encodeLoadout,
  encodeLobbyCmd,
  encodePing,
  peekMessageId,
} from '../../shared/protocol.ts';
import { LocalTransport } from '../../shared/net/transport.ts';
import type { Transport } from '../../shared/net/transport.ts';
import type { Room } from '../../shared/net/room.ts';
import type {
  ChatMsg,
  HelloMsg,
  InputCmd,
  LobbyCmd,
  Loadout,
  MatchResult,
  RoomState,
  Snapshot,
  WelcomeMsg,
} from '../../shared/types.ts';

export type ClientNetKind = 'ws' | 'peer' | 'local';

/** Google's public STUN servers (no TURN — see plan §3/§11: symmetric NATs fail and the UI should recommend the server path after a timeout). */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/** Message ids that ride the reliable PeerJS channel; everything else (INPUT, SNAPSHOT, PING, PONG) rides the unreliable one. */
const RELIABLE_MSG_IDS = new Set<number>([
  MSG_HELLO,
  MSG_LOADOUT,
  MSG_ROOM_STATE,
  MSG_MATCH_END,
  MSG_CHAT,
  MSG_LOBBY_CMD,
  MSG_ERROR,
]);

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

/** Wraps a plain WebSocket (binaryType 'arraybuffer') as a Transport. */
function wsLink(ws: WebSocket): Transport {
  const link: Transport = {
    id: 0,
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    close: () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
    onMessage: () => {},
    onClose: () => {},
  };
  ws.addEventListener('message', (ev) => {
    const bytes = toBytes(ev.data);
    if (bytes) link.onMessage(bytes);
  });
  ws.addEventListener('close', () => link.onClose());
  return link;
}

/**
 * Wraps a paired unreliable "game" + reliable "control" PeerJS DataConnection
 * as a single Transport, routing outbound frames by message id. Mirrors
 * PeerTransport in peer-host.ts (the host-side equivalent), but is kept as a
 * free function here rather than shared, to avoid a circular import between
 * this file and peer-host.ts (see file header).
 */
function peerLink(game: DataConnection, control: DataConnection): Transport {
  const link: Transport = {
    id: 0,
    send: (data) => {
      const channel = RELIABLE_MSG_IDS.has(peekMessageId(data)) ? control : game;
      if (channel.open) channel.send(data);
    },
    close: () => {
      try {
        game.close();
      } catch {
        /* already closed */
      }
      try {
        control.close();
      } catch {
        /* already closed */
      }
    },
    onMessage: () => {},
    onClose: () => {},
  };
  const onData = (raw: unknown) => {
    const bytes = toBytes(raw);
    if (bytes) link.onMessage(bytes);
  };
  game.on('data', onData);
  control.on('data', onData);
  let gameClosed = false;
  let controlClosed = false;
  const onEitherClose = () => {
    if (gameClosed && controlClosed) link.onClose();
  };
  game.on('close', () => {
    gameClosed = true;
    onEitherClose();
  });
  control.on('close', () => {
    controlClosed = true;
    onEitherClose();
  });
  return link;
}

/** Races a HELLO/WELCOME handshake over an already-open Transport-shaped link. Resolves on WELCOME, rejects on an ERROR frame or the timeout. Restores link.onMessage to a no-op before settling either way. */
function awaitWelcome(link: Transport, timeoutMs: number, sendHello: () => void): Promise<WelcomeMsg> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      link.onMessage = () => {};
      reject(new Error('Timed out waiting for WELCOME'));
    }, timeoutMs);
    link.onMessage = (data) => {
      if (settled) return;
      const msg = decodeMessage(data);
      if (!msg) return;
      if (msg.kind === 'welcome') {
        settled = true;
        clearTimeout(timer);
        link.onMessage = () => {};
        resolve(msg.welcome);
      } else if (msg.kind === 'error') {
        settled = true;
        clearTimeout(timer);
        link.onMessage = () => {};
        reject(new Error(`Server rejected connection (code ${msg.code}): ${msg.message}`));
      }
      // Anything else arriving before WELCOME is unexpected on a fresh
      // connection; ignore it and keep waiting rather than failing outright.
    };
    sendHello();
  });
}

/**
 * One networked connection to a match, over WebSocket, PeerJS or an
 * in-process LocalTransport. Owns the HELLO/WELCOME handshake, message
 * dispatch to the on* callbacks, the 1 Hz ping/RTT estimate, the slewed
 * `localEstServerTick` clock, stall detection and reconnect.
 */
export class ClientNet {
  readonly kind: ClientNetKind;
  welcome: WelcomeMsg;
  /** Smoothed round-trip time in ms (EMA, floored by the min of the last RTT_MIN_WINDOW samples). */
  rtt = 0;
  /** Free-running estimate of the server's current tick, slewed toward snapshot-derived targets. Stamp every InputCmd.tick from this. */
  localEstServerTick: number;
  /** True when no SNAPSHOT has arrived for STALL_MS; the render loop should freeze extrapolation and show a lag indicator. */
  stalled = false;

  onSnapshot: (s: Snapshot) => void = () => {};
  onRoomState: (s: RoomState) => void = () => {};
  onMatchEnd: (m: MatchResult) => void = () => {};
  onChat: (c: ChatMsg) => void = () => {};
  onError: (code: number, message: string) => void = () => {};
  onClose: () => void = () => {};

  private link: Transport;
  private hello: HelloMsg;
  private targetServerTick: number;
  private lastAdvanceMs: number | null = null;
  private lastSnapshotWallMs = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly rttSamples: number[] = [];
  private rttEma: number | null = null;

  // Reconnect bookkeeping, populated by whichever factory created this instance.
  private wsUrl: string | null = null;
  private peerRef: Peer | null = null;
  private peerCode: string | null = null;

  private constructor(kind: ClientNetKind, link: Transport, welcome: WelcomeMsg, hello: HelloMsg) {
    this.kind = kind;
    this.link = link;
    this.welcome = welcome;
    this.hello = hello;
    this.localEstServerTick = welcome.serverTick;
    this.targetServerTick = welcome.serverTick;
    this.installLinkHandlers();
    this.startPing();
  }

  /** Opens a WebSocket to `url`, sends HELLO, resolves on WELCOME. Rejects on MSG_ERROR or a timeout. */
  static connectWs(url: string, hello: HelloMsg): Promise<ClientNet> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error('WebSocket connection timed out'));
      }, RECONNECT_TIMEOUT_MS);
      ws.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('WebSocket connection failed'));
      });
      ws.addEventListener('open', () => {
        const link = wsLink(ws);
        awaitWelcome(link, RECONNECT_TIMEOUT_MS, () => link.send(encodeHello(hello)))
          .then((welcome) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const net = new ClientNet('ws', link, welcome, hello);
            net.wsUrl = url;
            resolve(net);
          })
          .catch((err: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
              ws.close();
            } catch {
              /* ignore */
            }
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      });
    });
  }

  /**
   * Joins a P2P room hosted at `PEER_ID_PREFIX + code` (see peer-host.ts).
   * Opens an unreliable game channel and a reliable control channel, sends
   * HELLO once both are open, resolves on WELCOME. No TURN relay is
   * configured, so a symmetric NAT on either side fails this within
   * P2P_CONNECT_TIMEOUT_MS — callers should recommend the server path.
   */
  static connectPeer(code: string, hello: HelloMsg): Promise<ClientNet> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const peer = new Peer({ config: { iceServers: ICE_SERVERS } });
      const timer = setTimeout(() => fail(new Error('P2P connection timed out (no TURN relay configured — a symmetric NAT on either side will fail here; try the server path instead).')), P2P_CONNECT_TIMEOUT_MS);
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          peer.destroy();
        } catch {
          /* ignore */
        }
        reject(err);
      };

      peer.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
      peer.on('open', () => {
        const hostId = PEER_ID_PREFIX + code;
        const game = peer.connect(hostId, { reliable: false, serialization: 'raw', label: 'game' });
        const control = peer.connect(hostId, { reliable: true, serialization: 'raw', label: 'control' });
        let gameOpen = false;
        let controlOpen = false;
        const tryReady = () => {
          if (settled || !gameOpen || !controlOpen) return;
          const link = peerLink(game, control);
          awaitWelcome(link, P2P_CONNECT_TIMEOUT_MS, () => link.send(encodeHello(hello)))
            .then((welcome) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              const net = new ClientNet('peer', link, welcome, hello);
              net.peerRef = peer;
              net.peerCode = code;
              resolve(net);
            })
            .catch(fail);
        };
        game.on('open', () => {
          gameOpen = true;
          tryReady();
        });
        control.on('open', () => {
          controlOpen = true;
          tryReady();
        });
        game.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
        control.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
      });
    });
  }

  /**
   * Connects to `room` in-process via a zero-latency LocalTransport pair
   * (practice mode, and the P2P host's own player). `room.attach` installs
   * the host-side handler; sending HELLO with the default (no latency/loss)
   * options delivers — and gets a WELCOME reply — synchronously.
   */
  static connectLocal(room: Room, hello: HelloMsg): Promise<ClientNet> {
    const [hostSide, clientSide] = LocalTransport.pair();
    room.attach(hostSide);
    return awaitWelcome(clientSide, RECONNECT_TIMEOUT_MS, () => clientSide.send(encodeHello(hello))).then(
      (welcome) => new ClientNet('local', clientSide, welcome, hello),
    );
  }

  private installLinkHandlers(): void {
    this.link.onMessage = (data) => this.handleFrame(data);
    this.link.onClose = () => this.onClose();
  }

  private handleFrame(data: Uint8Array): void {
    const msg = decodeMessage(data);
    if (!msg) return;
    switch (msg.kind) {
      case 'snapshot': {
        this.lastSnapshotWallMs = nowMs();
        this.targetServerTick = msg.snapshot.tick + this.rtt / 2 / (TICK_DT * 1000) + 1;
        this.onSnapshot(msg.snapshot);
        break;
      }
      case 'roomState':
        this.onRoomState(msg.roomState);
        break;
      case 'matchEnd':
        this.onMatchEnd(msg.result);
        break;
      case 'chat':
        this.onChat(msg.chat);
        break;
      case 'error':
        this.onError(msg.code, msg.message);
        break;
      case 'pong':
        this.handlePong(msg.clientTimeMs);
        break;
      default:
        // hello/input/lobbyCmd/welcome are server-bound or handshake-only; a
        // conforming server never sends them to us post-handshake.
        break;
    }
  }

  private handlePong(clientTimeMs: number): void {
    const sample = Math.max(0, nowMs() - clientTimeMs);
    this.rttSamples.push(sample);
    if (this.rttSamples.length > RTT_MIN_WINDOW) this.rttSamples.shift();
    this.rttEma = this.rttEma === null ? sample : this.rttEma + RTT_EMA_ALPHA * (sample - this.rttEma);
    const floor = Math.min(...this.rttSamples);
    this.rtt = Math.max(this.rttEma, floor);
  }

  private startPing(): void {
    this.stopPing();
    this.link.send(encodePing(Math.floor(nowMs())));
    this.pingTimer = setInterval(() => {
      this.link.send(encodePing(Math.floor(nowMs())));
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Call once per render frame with a `performance.now()`-compatible
   * timestamp. Advances the free-running server-tick estimate and slews it
   * toward the latest snapshot-derived target at CLOCK_SLEW_TICKS_PER_MS,
   * and refreshes stall detection.
   */
  advance(nowMsArg: number): void {
    if (this.lastAdvanceMs === null) {
      this.lastAdvanceMs = nowMsArg;
    } else {
      const dtMs = Math.max(0, nowMsArg - this.lastAdvanceMs);
      this.lastAdvanceMs = nowMsArg;
      this.localEstServerTick += dtMs / (1000 * TICK_DT);
      const diff = this.targetServerTick - this.localEstServerTick;
      const maxSlew = CLOCK_SLEW_TICKS_PER_MS * dtMs;
      this.localEstServerTick += Math.abs(diff) <= maxSlew ? diff : Math.sign(diff) * maxSlew;
    }
    this.stalled = this.lastSnapshotWallMs > 0 && nowMsArg - this.lastSnapshotWallMs > STALL_MS;
  }

  /** Sends the current + redundant recent InputCmds (see Predictor.pendingCmds). */
  sendInput(cmds: readonly InputCmd[]): void {
    this.link.send(encodeInput(cmds));
  }

  sendLoadout(loadout: Loadout): void {
    this.link.send(encodeLoadout(loadout));
  }

  sendLobbyCmd(cmd: LobbyCmd): void {
    this.link.send(encodeLobbyCmd(cmd));
  }

  sendChat(text: string): void {
    this.link.send(encodeChat({ from: this.welcome.playerId, text }));
  }

  /**
   * Re-establishes the connection after a background/foreground cycle
   * (iOS closes WebSockets and tears down RTCPeerConnections on tab hide —
   * see plan §3). Re-sends HELLO with rejoinId = the previous playerId, and
   * on success swaps the new link/welcome/timers into this instance in
   * place so existing on* callback assignments and outside references stay
   * valid. No-op for 'local' (an in-process link never truly disconnects).
   */
  async reconnect(): Promise<void> {
    if (this.kind === 'local') return;
    const rejoinHello: HelloMsg = { ...this.hello, rejoinId: this.welcome.playerId };
    if (this.kind === 'ws') {
      if (!this.wsUrl) throw new Error('cannot reconnect: no WebSocket URL recorded');
      const fresh = await ClientNet.connectWs(this.wsUrl, rejoinHello);
      this.adopt(fresh);
      return;
    }
    // peer
    if (this.peerRef && !this.peerRef.destroyed) this.peerRef.reconnect();
    if (!this.peerCode) throw new Error('cannot reconnect: no room code recorded');
    const fresh = await ClientNet.connectPeer(this.peerCode, rejoinHello);
    this.adopt(fresh);
  }

  /** Absorbs a freshly (re)connected ClientNet's live state into this instance. */
  private adopt(fresh: ClientNet): void {
    this.stopPing();
    fresh.stopPing();
    this.link = fresh.link;
    this.welcome = fresh.welcome;
    this.hello = fresh.hello;
    this.wsUrl = fresh.wsUrl;
    this.peerRef = fresh.peerRef;
    this.peerCode = fresh.peerCode;
    this.rtt = 0;
    this.rttEma = null;
    this.rttSamples.length = 0;
    this.stalled = false;
    this.lastSnapshotWallMs = 0;
    this.lastAdvanceMs = null;
    this.localEstServerTick = fresh.welcome.serverTick;
    this.targetServerTick = fresh.welcome.serverTick;
    this.installLinkHandlers();
    this.startPing();
  }

  close(): void {
    this.stopPing();
    this.link.close();
  }
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
