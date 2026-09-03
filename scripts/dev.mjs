#!/usr/bin/env node
// Runs the game server (server/index.ts, type-stripped directly by Node) and
// the Vite dev server side by side with prefixed, colored output, and tears
// both down together on exit.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ''}` };

/** Spawn a child process, prefixing every output line with a colored tag. */
function run(name, cmd, args, colorCode) {
  const child = spawn(cmd, args, { env, cwd: root, stdio: ['inherit', 'pipe', 'pipe'] });
  const prefix = `\x1b[${colorCode}m[${name}]\x1b[0m `;
  let buf = '';

  const pipe = (readable, writable) => {
    readable.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) writable.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  return child;
}

const server = run('server', 'node', ['server/index.ts'], '36'); // cyan
const vite = run('vite', path.join(root, 'node_modules', '.bin', 'vite'), [], '35'); // magenta

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  server.kill('SIGINT');
  vite.kill('SIGINT');
  process.exitCode = code;
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
server.on('exit', (code) => { if (!shuttingDown) { console.error(`[server] exited with code ${code}`); shutdown(code ?? 1); } });
vite.on('exit', (code) => { if (!shuttingDown) { console.error(`[vite] exited with code ${code}`); shutdown(code ?? 1); } });
