#!/usr/bin/env node
// One-command "let a friend play": builds the client if needed, starts the
// game server, then opens a Cloudflare tunnel to it.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ''}` };
const port = process.env.PORT ? Number(process.env.PORT) : 8090;
env.PORT = String(port);

function runToCompletion(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, cwd: root, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))));
    child.on('error', reject);
  });
}

async function main() {
  const distIndex = path.join(root, 'dist', 'index.html');
  if (!existsSync(distIndex)) {
    console.log('dist/ not found, building the client first...');
    await runToCompletion(path.join(root, 'node_modules', '.bin', 'vite'), ['build']);
  }

  console.log(`Starting the game server on port ${port}...`);
  const server = spawn('node', ['server/index.ts'], { env, cwd: root, stdio: 'inherit' });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.kill('SIGINT');
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  server.on('exit', (code) => {
    if (!shuttingDown && code !== 0 && code !== null) {
      console.error(`server exited with code ${code}`);
      process.exit(code);
    }
  });

  // Give the server a moment to bind its port before pointing a tunnel at it.
  await new Promise((resolve) => setTimeout(resolve, 800));

  const tunnel = spawn('node', ['scripts/tunnel.mjs'], { env, cwd: root, stdio: 'inherit' });
  tunnel.on('exit', () => shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
