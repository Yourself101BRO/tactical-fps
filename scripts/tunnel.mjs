#!/usr/bin/env node
// Runs a free Cloudflare tunnel to the local game server and prints the
// public https://*.trycloudflare.com URL prominently as soon as it appears.

import { spawn } from 'node:child_process';

const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ''}` };
const port = process.env.PORT ? Number(process.env.PORT) : 8090;
const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

console.log(`Starting cloudflared tunnel to http://localhost:${port} ...`);
const child = spawn('npx', ['--yes', 'cloudflared', 'tunnel', '--url', `http://localhost:${port}`], {
  env,
  stdio: ['inherit', 'pipe', 'pipe'],
});

let printed = false;
function scan(chunk) {
  const text = chunk.toString();
  process.stderr.write(text); // cloudflared logs its progress to stderr; mirror it all
  const match = text.match(urlPattern);
  if (match && !printed) {
    printed = true;
    const line = `  Share this URL:  ${match[0]}  `;
    const bar = '='.repeat(Math.max(line.length, 40));
    console.log(`\n${bar}\n${line}\n${bar}\n`);
  }
}

child.stdout.on('data', scan);
child.stderr.on('data', scan);
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
