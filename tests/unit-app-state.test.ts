import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppState, Emitter } from '../client/app-state.ts';

test('Emitter on/once/emit/off', () => {
  const e = new Emitter<{ a: number; b: string }>();
  const seen: number[] = [];
  const off = e.on('a', (n) => seen.push(n));
  e.once('a', (n) => seen.push(n * 100));
  e.emit('a', 1);
  e.emit('a', 2);
  off();
  e.emit('a', 3);
  assert.deepEqual(seen, [1, 100, 2]);
});

test('AppState validates transitions and records the previous screen', () => {
  const s = new AppState();
  const log: string[] = [];
  s.on('screen', ({ from, to }) => log.push(`${from}>${to}`));
  assert.equal(s.screen, 'boot');
  assert.equal(s.go('lobby'), false);
  assert.equal(s.go('menu'), true);
  assert.equal(s.go('connecting'), true);
  assert.equal(s.go('lobby'), true);
  assert.equal(s.go('settings'), true);
  assert.equal(s.back(), true);
  assert.equal(s.screen, 'lobby');
  assert.equal(s.go('match'), true);
  assert.equal(s.go('spectate'), true);
  assert.equal(s.go('results'), true);
  assert.equal(s.go('lobby'), true);
  s.reset('error');
  assert.equal(s.screen, 'error');
  assert.equal(s.go('menu'), true);
  assert.deepEqual(log, [
    'boot>menu', 'menu>connecting', 'connecting>lobby', 'lobby>settings', 'settings>lobby',
    'lobby>match', 'match>spectate', 'spectate>results', 'results>lobby', 'lobby>error', 'error>menu',
  ]);
});
