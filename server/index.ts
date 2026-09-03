// The dedicated game server: one Node process serving the built client
// (dist/) over HTTP and hosting every Room over a single WebSocket upgrade at
// /ws. Not part of shared/**, so this file may freely use Node APIs, Math.random()
// and wall-clock time.

import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';

import { BOT_REGULAR, DEFAULT_PORT, MAP_COMPOUND, MODE_ANY, ROOM_CODE_ALPHABET, ROOM_CODE_LEN, TICK_DT } from '../shared/constants.ts';
import { decodeMessage, encodeError } from '../shared/protocol.ts';
import { ERR_BAD_VERSION, ERR_ROOM_NOT_FOUND } from '../shared/types.ts';
import { Room } from '../shared/net/room.ts';
import { WsTransport } from './ws-transport.ts';

export interface CreateServerOptions {
  port: number;
  staticDir: string;
  host?: string;
}

export interface GameServer {
  httpServer: HttpServer;
  wss: WebSocketServer;
  rooms: Map<string, Room>;
  close(): void;
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.hdr': 'image/vnd.radiance',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.obj': 'text/plain; charset=utf-8',
  '.fbx': 'application/octet-stream',
  '.dae': 'model/vnd.collada+xml',
  '.mtl': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
};

function safeJoin(staticDir: string, urlPath: string): string {
  const decoded = decodeURIComponent(urlPath);
  const normalized = path.normalize(decoded).replace(/^([/\\]?\.\.[/\\])+/, '/');
  return path.join(staticDir, normalized);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, staticDir: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/healthz') {
    const body = JSON.stringify({ ok: true, ts: Date.now() });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  // Dev-only: browser automation posts JPEG frames here (DEBUG_SHOTS=1) so a
  // hidden/headless tab can still be inspected from disk.
  if (url.pathname === '/debug/shot' && process.env.DEBUG_SHOTS === '1') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const dataUrl = Buffer.concat(chunks).toString('utf8');
    const comma = dataUrl.indexOf(',');
    const name = (url.searchParams.get('name') ?? 'shot').replace(/[^a-z0-9_-]/gi, '_');
    const dir = path.join(process.cwd(), '.backup-w1', 'shots');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${name}.jpg`), Buffer.from(dataUrl.slice(comma + 1), 'base64'));
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  const reqPath = url.pathname === '/' ? '/index.html' : url.pathname;
  let filePath = safeJoin(staticDir, reqPath);

  try {
    let st = await stat(filePath);
    if (st.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      st = await stat(filePath);
    }
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'content-length': data.byteLength });
    res.end(data);
    return;
  } catch {
    // fall through to SPA fallback / 404 below
  }

  // SPA fallback: any path with no file extension is a client route.
  if (path.extname(reqPath) === '') {
    try {
      const data = await readFile(path.join(staticDir, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': data.byteLength });
      res.end(data);
      return;
    } catch {
      // no build present; fall through to 404
    }
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

// ---------------------------------------------------------------------------
// Room registry and the per-room drift-corrected tick loop
// ---------------------------------------------------------------------------
function generateRoomCode(taken: ReadonlySet<string>): string {
  let code = '';
  do {
    code = '';
    for (let i = 0; i < ROOM_CODE_LEN; i++) {
      code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
    }
  } while (taken.has(code));
  return code;
}

function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

/** setTimeout-based scheduler that corrects for drift instead of accumulating it. */
function startRoomLoop(room: Room): () => void {
  const intervalMs = TICK_DT * 1000;
  let stopped = false;
  let expected = performance.now() + intervalMs;
  let timer: ReturnType<typeof setTimeout>;

  const tick = (): void => {
    if (stopped) return;
    room.update(performance.now());
    const now = performance.now();
    const drift = now - expected;
    expected += intervalMs;
    const nextDelay = Math.max(0, intervalMs - drift);
    timer = setTimeout(tick, nextDelay);
  };

  timer = setTimeout(tick, intervalMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export function createServer(opts: CreateServerOptions): GameServer {
  const rooms = new Map<string, Room>();
  const roomStoppers = new Map<string, () => void>();

  const httpServer = createHttpServer((req, res) => {
    serveStatic(req, res, opts.staticDir).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end('internal error');
    });
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  function destroyRoom(code: string): void {
    const stop = roomStoppers.get(code);
    if (stop) stop();
    roomStoppers.delete(code);
    const room = rooms.get(code);
    rooms.delete(code);
    if (room) room.close();
  }

  function createRoom(code: string, mode: number, wantBots: number): Room {
    const room = new Room({ code, mode, mapId: MAP_COMPOUND, botCount: wantBots, botDifficulty: BOT_REGULAR, seed: randomSeed() });
    rooms.set(code, room);
    room.onEmpty = () => destroyRoom(code);
    roomStoppers.set(code, startRoomLoop(room));
    return room;
  }

  wss.on('connection', (ws: WebSocket) => {
    const transport = new WsTransport(ws);
    let routed = false;

    transport.onMessage = (data) => {
      if (routed) return;
      routed = true;

      const msg = decodeMessage(data);
      if (!msg || msg.kind !== 'hello') {
        transport.send(encodeError(ERR_BAD_VERSION, 'expected HELLO'));
        transport.close();
        return;
      }
      const hello = msg.hello;
      const requestedCode = hello.roomCode.trim();
      let room = requestedCode.length > 0 ? rooms.get(requestedCode) : undefined;

      if (!room) {
        if (requestedCode.length === 0 || hello.mode !== MODE_ANY) {
          const code = requestedCode.length === ROOM_CODE_LEN ? requestedCode : generateRoomCode(new Set(rooms.keys()));
          room = createRoom(code, hello.mode, hello.wantBots);
        } else {
          transport.send(encodeError(ERR_ROOM_NOT_FOUND, 'room not found'));
          transport.close();
          return;
        }
      }
      room.attach(transport, data);
    };
  });

  const host = opts.host ?? '0.0.0.0';
  httpServer.listen(opts.port, host);

  return {
    httpServer,
    wss,
    rooms,
    close(): void {
      for (const stop of roomStoppers.values()) stop();
      roomStoppers.clear();
      for (const room of rooms.values()) room.close();
      rooms.clear();
      wss.close();
      httpServer.close();
    },
  };
}

// Listen only when this module is run directly (`node server/index.ts`), so
// tests can import createServer without binding a port.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;
  const staticDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  const server = createServer({ port, staticDir, host: '0.0.0.0' });
  console.log(`tactical-fps server listening on http://0.0.0.0:${port} (ws upgrade at /ws, static from ${staticDir})`);

  const shutdown = (): void => {
    console.log('\nShutting down...');
    server.close();
    process.exit(0);
  };
  // Hosts (Railway/Render/Fly/Docker) send SIGTERM on redeploys; terminals send SIGINT.
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
