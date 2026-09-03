// Runs a Room as a WebRTC (PeerJS) host on the main thread (see plan §2/§3:
// no worker, since RTCPeerConnection is not exposed in dedicated workers).
// Claims `PEER_ID_PREFIX + code` as this browser's PeerJS id, pairs each
// joiner's unreliable "game" + reliable "control" DataConnection into one
// Transport, attaches it to the Room, and drives the room's tick loop. The
// host's own player connects in-process via ClientNet.connectLocal so the
// host plays in the same match it is simulating.
//
// See client-net.ts's file header for why the "route by message id onto the
// reliable/unreliable channel" logic is duplicated rather than shared
// between that file and this one (this file already imports ClientNet from
// there; the reverse import would make the pair circular).

import { Peer } from 'peerjs';
import type { DataConnection } from 'peerjs';

import { MODE_ANY, P2P_CONNECT_TIMEOUT_MS, PEER_ID_PREFIX, PROTOCOL_VERSION } from '../../shared/constants.ts';
import {
  MSG_CHAT,
  MSG_ERROR,
  MSG_HELLO,
  MSG_LOADOUT,
  MSG_LOBBY_CMD,
  MSG_MATCH_END,
  MSG_ROOM_STATE,
  peekMessageId,
} from '../../shared/protocol.ts';
import type { Transport } from '../../shared/net/transport.ts';
import type { Room } from '../../shared/net/room.ts';
import type { HelloMsg } from '../../shared/types.ts';
import { ClientNet, ICE_SERVERS } from './client-net.ts';
import { HostLoop } from './host-loop.ts';

/** Message ids that ride the reliable control channel; everything else (INPUT, SNAPSHOT, PING, PONG) rides the unreliable game channel. Must agree with client-net.ts's identical set. */
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

/**
 * One remote player's Transport, backed by a pair of DataConnections opened
 * by the same remote PeerJS peer: an unreliable channel for INPUT/SNAPSHOT/
 * PING/PONG and a reliable one for everything else. Outbound frames sent
 * before both channels finish opening are queued and flushed once they are,
 * so the first WELCOME is never lost to a slow ICE handshake on one leg.
 */
export class PeerTransport implements Transport {
  readonly id: number;
  onMessage: (data: Uint8Array) => void = () => {};
  onClose: () => void = () => {};

  private readonly game: DataConnection;
  private readonly control: DataConnection;
  private gameOpen: boolean;
  private controlOpen: boolean;
  private readonly queue: Uint8Array[] = [];
  private closed = false;

  constructor(id: number, game: DataConnection, control: DataConnection) {
    this.id = id;
    this.game = game;
    this.control = control;
    this.gameOpen = game.open;
    this.controlOpen = control.open;

    const onData = (raw: unknown) => {
      const bytes = toBytes(raw);
      if (bytes) this.onMessage(bytes);
    };
    game.on('data', onData);
    control.on('data', onData);

    game.on('open', () => {
      this.gameOpen = true;
      this.flush();
    });
    control.on('open', () => {
      this.controlOpen = true;
      this.flush();
    });

    let gameClosed = false;
    let controlClosed = false;
    const onEitherClose = () => {
      if (gameClosed && controlClosed) this.handleClose();
    };
    game.on('close', () => {
      gameClosed = true;
      onEitherClose();
    });
    control.on('close', () => {
      controlClosed = true;
      onEitherClose();
    });
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  private flush(): void {
    if (!this.gameOpen || !this.controlOpen || this.closed) return;
    for (const frame of this.queue) this.sendNow(frame);
    this.queue.length = 0;
  }

  private sendNow(data: Uint8Array): void {
    const channel = RELIABLE_MSG_IDS.has(peekMessageId(data)) ? this.control : this.game;
    channel.send(data);
  }

  send(data: Uint8Array): void {
    if (this.closed) return;
    if (this.gameOpen && this.controlOpen) this.sendNow(data);
    else this.queue.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.game.close();
    } catch {
      /* already closing */
    }
    try {
      this.control.close();
    } catch {
      /* already closing */
    }
    this.onClose();
  }
}

interface PendingPeer {
  game?: DataConnection;
  control?: DataConnection;
}

export class PeerHost {
  private readonly room: Room;
  private readonly loop: HostLoop;
  private peer: Peer | null = null;
  private readonly pendingByPeerId = new Map<string, PendingPeer>();
  private readonly transportsByPeerId = new Map<string, PeerTransport>();
  private nextTransportId = 1;

  /** The host's own in-process connection, set once start() resolves. */
  localNet: ClientNet | null = null;
  /** Surfaces fatal PeerJS errors (e.g. the room code is already taken) to the integrator's UI. */
  onError: (err: Error) => void = () => {};

  constructor(room: Room) {
    this.room = room;
    this.loop = new HostLoop(room);
  }

  /**
   * Claims `PEER_ID_PREFIX + code` as this browser's PeerJS id, starts the
   * room's tick loop, and connects the host's own player in-process.
   * `hostHello` lets the integrator supply the host's chosen name/loadout;
   * it defaults to a generic HELLO if omitted — an addition beyond the
   * plan's bare `start(code)` signature, needed because
   * ClientNet.connectLocal requires a HelloMsg and PeerHost has no other
   * source for one.
   */
  async start(code: string, hostHello?: HelloMsg): Promise<void> {
    const peer = new Peer(PEER_ID_PREFIX + code, { config: { iceServers: ICE_SERVERS } });
    this.peer = peer;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Could not claim room code "${code}" for P2P hosting (timed out).`)),
        P2P_CONNECT_TIMEOUT_MS,
      );
      peer.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      peer.once('error', (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });

    peer.on('connection', (conn) => this.handleConnection(conn));
    peer.on('disconnected', () => {
      if (!peer.destroyed) peer.reconnect();
    });
    peer.on('error', (err) => this.onError(err instanceof Error ? err : new Error(String(err))));

    this.loop.start();

    const hello: HelloMsg = hostHello ?? {
      protocolVersion: PROTOCOL_VERSION,
      name: 'Host',
      roomCode: code,
      mode: MODE_ANY,
      wantBots: 0,
      rejoinId: 0,
    };
    this.localNet = await ClientNet.connectLocal(this.room, hello);
  }

  private handleConnection(conn: DataConnection): void {
    const key = conn.peer;
    let entry = this.pendingByPeerId.get(key);
    if (!entry) {
      entry = {};
      this.pendingByPeerId.set(key, entry);
    }
    if (conn.reliable) entry.control = conn;
    else entry.game = conn;

    if (entry.game && entry.control) {
      this.pendingByPeerId.delete(key);
      const id = this.nextTransportId++;
      const transport = new PeerTransport(id, entry.game, entry.control);
      this.transportsByPeerId.set(key, transport);
      this.room.attach(transport);
      // Room.attach just took ownership of transport.onClose; chain our own
      // bookkeeping after whatever handler it installed rather than before,
      // so we don't clobber Room's disconnect handling.
      const roomOnClose = transport.onClose;
      transport.onClose = () => {
        this.transportsByPeerId.delete(key);
        roomOnClose();
      };
    }
  }

  stop(): void {
    this.loop.stop();
    for (const t of Array.from(this.transportsByPeerId.values())) t.close();
    this.transportsByPeerId.clear();
    this.pendingByPeerId.clear();
    if (this.localNet) {
      this.localNet.close();
      this.localNet = null;
    }
    if (this.peer && !this.peer.destroyed) this.peer.destroy();
    this.peer = null;
  }
}
