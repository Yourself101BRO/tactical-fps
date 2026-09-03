#!/usr/bin/env node
// Downloads every asset in scripts/asset-manifest.json into public/assets/,
// locking each download's SHA-256 in scripts/asset-lock.json, and writes
// public/assets/index.json + CREDITS.md. Pure Node ESM, no npm dependencies.
//
// Usage:
//   PATH=/opt/homebrew/bin:$PATH node scripts/fetch-assets.mjs [--tier desktop|mobile|all] [--force] [--dry-run] [--strict]
//
// See the plan (§5) and the header comment in scripts/asset-manifest.json for
// the full contract. This file is intentionally defensive: a single bad asset
// warns and is marked failed:true rather than aborting the whole run (unless
// --strict), because every category has a procedural fallback in
// client/assets/fallbacks.ts.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'scripts', 'asset-manifest.json');
const LOCK_PATH = path.join(ROOT, 'scripts', 'asset-lock.json');
const PUBLIC_ASSETS = path.join(ROOT, 'public', 'assets');
const INDEX_PATH = path.join(PUBLIC_ASSETS, 'index.json');
const CREDITS_PATH = path.join(ROOT, 'CREDITS.md');
const TMP_DIR = path.join(ROOT, '.tmp-assets');

const RETRIES = 3;
const TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { tier: 'all', force: false, dryRun: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tier') args.tier = argv[++i];
    else if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--strict') args.strict = true;
    else if (a.startsWith('--tier=')) args.tier = a.slice('--tier='.length);
    else console.warn(`[assets] unknown argument "${a}" ignored`);
  }
  if (!['desktop', 'mobile', 'all'].includes(args.tier)) {
    console.error(`[assets] --tier must be desktop|mobile|all, got "${args.tier}"`);
    process.exit(1);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Small filesystem helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

function sizeOf(filePath) {
  return statSync(filePath).size;
}

/** Recursively lists files under dir as paths relative to dir (POSIX separators). */
function listFilesRecursive(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const abs = path.join(entry.parentPath ?? entry.path ?? dir, entry.name);
      out.push(path.relative(dir, abs).split(path.sep).join('/'));
    }
  }
  return out;
}

function dirIsNonEmpty(dir) {
  return existsSync(dir) && listFilesRecursive(dir).length > 0;
}

/** Minimal glob (only `*` wildcards, matched against the file's basename or full relative path). */
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesAnyGlob(relPath, globs) {
  if (!globs || globs.length === 0) return false;
  const base = path.basename(relPath);
  return globs.some((g) => {
    const re = globToRegExp(g);
    return re.test(base) || re.test(relPath);
  });
}

// ---------------------------------------------------------------------------
// Download with retries + timeout
// ---------------------------------------------------------------------------

async function downloadToFile(url, destPath, { retries = RETRIES, timeoutMs = TIMEOUT_MS } = {}) {
  ensureDir(path.dirname(destPath));
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const tmp = `${destPath}.part`;
      writeFileSync(tmp, buf);
      renameSync(tmp, destPath);
      clearTimeout(timer);
      return;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        console.warn(`[assets] retry ${attempt}/${retries - 1} for ${url}: ${err.message ?? err}`);
      }
    }
  }
  throw new Error(`failed to download ${url} after ${retries} attempts: ${lastErr?.message ?? lastErr}`);
}

async function fetchJson(url, { timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Lock file (compare-and-abort on hash mismatch)
// ---------------------------------------------------------------------------

function loadLock() {
  if (!existsSync(LOCK_PATH)) return { version: 1, entries: {} };
  try {
    return JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  } catch {
    console.warn(`[assets] ${LOCK_PATH} is not valid JSON; starting a fresh lock`);
    return { version: 1, entries: {} };
  }
}

function saveLock(lock) {
  writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + '\n');
}

/**
 * Downloads `url` to a temp path, hashes it, and compares against the lock.
 * On mismatch this ABORTS THE ENTIRE RUN (exit 1) per the plan: an asset that
 * changed upstream (or arrived corrupted) must be verified by a human before
 * the game ships it. On first sight, records the new hash. Returns the temp
 * file path and its sha256.
 */
async function downloadLocked(id, url, lock, { dryRun }) {
  const tmpPath = path.join(TMP_DIR, id, path.basename(new URL(url).pathname) || 'download');
  if (dryRun) {
    return { tmpPath: null, sha256: null, bytes: 0, skipped: true };
  }
  await downloadToFile(url, tmpPath);
  const sha256 = sha256File(tmpPath);
  const bytes = sizeOf(tmpPath);
  const existing = lock.entries[url];
  if (existing) {
    if (existing.sha256 !== sha256) {
      console.error(
        `\n[assets] SHA-256 MISMATCH for ${url}\n` +
          `  locked:     ${existing.sha256}\n` +
          `  downloaded: ${sha256}\n` +
          `  asset changed upstream or corrupted — verify manually, then delete its entry\n` +
          `  from ${path.relative(ROOT, LOCK_PATH)} to accept the new hash.\n`,
      );
      process.exit(1);
    }
  } else {
    lock.entries[url] = { id, url, sha256, bytes, fetchedAt: new Date().toISOString() };
  }
  return { tmpPath, sha256, bytes, skipped: false };
}

// ---------------------------------------------------------------------------
// Zip extraction (unzip CLI, no deps)
// ---------------------------------------------------------------------------

function extractZip(zipPath, destDir) {
  ensureDir(destDir);
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', destDir], { stdio: 'inherit' });
}

/** Moves a single top-level directory's contents up one level, if the zip had one. */
function flattenSingleTopDir(destDir) {
  const entries = readdirSync(destDir, { withFileTypes: true }).filter(
    (e) => e.name !== '__MACOSX' && e.name !== '.DS_Store',
  );
  if (entries.length === 1 && entries[0].isDirectory()) {
    const inner = path.join(destDir, entries[0].name);
    for (const child of readdirSync(inner)) {
      renameSync(path.join(inner, child), path.join(destDir, child));
    }
    rmSync(inner, { recursive: true, force: true });
  }
}

function cleanExtractedZip(destDir, { include, exclude }) {
  rmSync(path.join(destDir, '__MACOSX'), { recursive: true, force: true });
  for (const rel of listFilesRecursive(destDir)) {
    if (path.basename(rel) === '.DS_Store') {
      rmSync(path.join(destDir, rel), { force: true });
      continue;
    }
    if (exclude && matchesAnyGlob(rel, exclude)) {
      rmSync(path.join(destDir, rel), { force: true });
      continue;
    }
    if (include && include.length > 0 && !matchesAnyGlob(rel, include)) {
      rmSync(path.join(destDir, rel), { force: true });
    }
  }
  // Removing files can leave empty directories; that's harmless and left as-is.
}

// ---------------------------------------------------------------------------
// sips 512px downscale (best-effort; skipped silently if sips is missing)
// ---------------------------------------------------------------------------

let sipsChecked = false;
let sipsAvailable = false;
function hasSips() {
  if (sipsChecked) return sipsAvailable;
  sipsChecked = true;
  try {
    execFileSync('sips', ['--version'], { stdio: 'ignore' });
    sipsAvailable = true;
  } catch {
    sipsAvailable = false;
  }
  return sipsAvailable;
}

function make512Copy(srcJpg) {
  if (!hasSips()) return null;
  const dir = path.dirname(srcJpg);
  const base = path.basename(srcJpg, path.extname(srcJpg));
  const out = path.join(dir, `${base}_512.jpg`);
  try {
    execFileSync('sips', ['-Z', '512', srcJpg, '--out', out], { stdio: 'ignore' });
    return out;
  } catch (err) {
    console.warn(`[assets] sips failed to downscale ${srcJpg}: ${err.message ?? err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-asset processing
// ---------------------------------------------------------------------------

const PREFER_DEFAULT = ['glb', 'gltf', 'fbx', 'dae', 'obj'];

function pickPrimary(files, prefer) {
  const order = prefer && prefer.length > 0 ? prefer : PREFER_DEFAULT;
  for (const ext of order) {
    const hit = files.find((f) => f.toLowerCase().endsWith(`.${ext}`));
    if (hit) return hit;
  }
  return files[0] ?? null;
}

function toPublicUrl(absPath) {
  return '/' + path.relative(path.join(ROOT, 'public'), absPath).split(path.sep).join('/');
}

/** type: 'file' */
async function processFile(asset, lock, opts) {
  const destAbs = path.join(PUBLIC_ASSETS, asset.dest);
  if (!opts.force && existsSync(destAbs) && lock.entries[asset.url]) {
    return { files: [toPublicUrl(destAbs)], bytes: sizeOf(destAbs), skipped: true };
  }
  if (opts.dryRun) {
    console.log(`  [file] ${asset.url}\n         -> public/assets/${asset.dest}`);
    return { files: [toPublicUrl(destAbs)], bytes: 0, skipped: true };
  }
  const { tmpPath, bytes } = await downloadLocked(asset.id, asset.url, lock, opts);
  ensureDir(path.dirname(destAbs));
  copyFileSync(tmpPath, destAbs);
  return { files: [toPublicUrl(destAbs)], bytes };
}

/** type: 'zip' */
async function processZip(asset, lock, opts) {
  const destDir = path.join(PUBLIC_ASSETS, asset.dest);
  if (!opts.force && dirIsNonEmpty(destDir) && lock.entries[asset.url]) {
    const relFiles = listFilesRecursive(destDir);
    const files = relFiles.map((f) => toPublicUrl(path.join(destDir, f)));
    const bytes = relFiles.reduce((s, f) => s + sizeOf(path.join(destDir, f)), 0);
    return { files, bytes, skipped: true };
  }
  if (opts.dryRun) {
    console.log(`  [zip]  ${asset.url}\n         -> public/assets/${asset.dest}/  (prefer: ${(asset.prefer ?? PREFER_DEFAULT).join(', ')})`);
    return { files: [], bytes: 0, skipped: true };
  }
  const { tmpPath, bytes } = await downloadLocked(asset.id, asset.url, lock, opts);
  rmSync(destDir, { recursive: true, force: true });
  extractZip(tmpPath, destDir);
  flattenSingleTopDir(destDir);
  cleanExtractedZip(destDir, { include: asset.include, exclude: asset.exclude });
  const files = listFilesRecursive(destDir).map((f) => toPublicUrl(path.join(destDir, f)));
  return { files, bytes };
}

/** type: 'polyhaven-model' */
async function processPolyhavenModel(asset, lock, opts) {
  const destDir = path.join(PUBLIC_ASSETS, asset.dest);
  const filesApiUrl = `https://api.polyhaven.com/files/${asset.polyhavenId}`;
  if (opts.dryRun) {
    console.log(`  [polyhaven-model] ${asset.polyhavenId} @ ${asset.resolution}\n         via ${filesApiUrl}\n         -> public/assets/${asset.dest}/`);
    return { files: [], bytes: 0, skipped: true };
  }
  if (!opts.force && dirIsNonEmpty(destDir)) {
    // Per-file Poly Haven URLs aren't cheaply reconstructible from disk alone;
    // a non-empty dest dir is treated as "already fetched" like the other
    // asset types. --force re-downloads if a partial/stale extraction is suspected.
    const relFiles = listFilesRecursive(destDir);
    const files = relFiles.map((f) => toPublicUrl(path.join(destDir, f)));
    return { files, bytes: relFiles.reduce((s, f) => s + sizeOf(path.join(destDir, f)), 0), skipped: true };
  }
  const manifest = await fetchJson(filesApiUrl);
  const byRes = manifest?.gltf?.[asset.resolution]?.gltf;
  if (!byRes?.url) throw new Error(`polyhaven files API had no gltf.${asset.resolution}.gltf for ${asset.polyhavenId}`);

  ensureDir(destDir);
  let bytes = 0;
  const files = [];

  async function fetchInto(url, relName) {
    const { tmpPath, bytes: b } = await downloadLocked(`${asset.id}:${relName}`, url, lock, opts);
    const destAbs = path.join(destDir, relName);
    ensureDir(path.dirname(destAbs));
    copyFileSync(tmpPath, destAbs);
    bytes += b;
    files.push(toPublicUrl(destAbs));
  }

  const mainName = path.basename(new URL(byRes.url).pathname);
  await fetchInto(byRes.url, mainName);
  const include = byRes.include ?? {};
  for (const [relName, info] of Object.entries(include)) {
    if (info?.url) await fetchInto(info.url, relName);
  }
  return { files, bytes };
}

/** type: 'polyhaven-texture' */
async function processPolyhavenTexture(asset, lock, opts) {
  const destDir = path.join(PUBLIC_ASSETS, asset.dest);
  if (opts.dryRun) {
    console.log(
      `  [polyhaven-texture] ${asset.polyhavenId} @ ${asset.resolution} maps=[${asset.maps.join(', ')}]\n` +
        `         -> public/assets/${asset.dest}/`,
    );
    return { files: [], bytes: 0, skipped: true, textures: {} };
  }
  if (!opts.force && dirIsNonEmpty(destDir)) {
    const relFiles = listFilesRecursive(destDir);
    const files = relFiles.map((f) => toPublicUrl(path.join(destDir, f)));
    return {
      files,
      bytes: relFiles.reduce((s, f) => s + sizeOf(path.join(destDir, f)), 0),
      skipped: true,
      textures: textureMapFromFiles(files, asset),
    };
  }

  ensureDir(destDir);
  let bytes = 0;
  const files = [];
  const mapUrls = {}; // map name (as requested, e.g. "rough") -> local public URL

  for (const map of asset.maps) {
    const primaryUrl = `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/${asset.resolution}/${asset.polyhavenId}/${asset.polyhavenId}_${map}_${asset.resolution}.jpg`;
    let usedMap = map;
    let localPath;
    try {
      const { tmpPath, bytes: b } = await downloadLocked(`${asset.id}:${map}`, primaryUrl, lock, opts);
      localPath = path.join(destDir, `${asset.polyhavenId}_${map}_${asset.resolution}.jpg`);
      copyFileSync(tmpPath, localPath);
      bytes += b;
    } catch (err) {
      if (map === 'rough') {
        console.warn(`[assets] ${asset.id}: "rough" map missing (${err.message ?? err}), trying "arm"`);
        usedMap = 'arm';
        const armUrl = `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/${asset.resolution}/${asset.polyhavenId}/${asset.polyhavenId}_arm_${asset.resolution}.jpg`;
        const { tmpPath, bytes: b } = await downloadLocked(`${asset.id}:arm`, armUrl, lock, opts);
        localPath = path.join(destDir, `${asset.polyhavenId}_arm_${asset.resolution}.jpg`);
        copyFileSync(tmpPath, localPath);
        bytes += b;
      } else {
        throw err;
      }
    }
    const mapKey = usedMap === 'arm' ? 'rough' : normalizeMapName(map);
    files.push(toPublicUrl(localPath));
    mapUrls[mapKey] = toPublicUrl(localPath);

    const p512 = make512Copy(localPath);
    if (p512) {
      files.push(toPublicUrl(p512));
      mapUrls[`${mapKey}512`] = toPublicUrl(p512);
    }
  }

  return { files, bytes, textures: mapUrls };
}

/** "nor_gl" (Poly Haven's OpenGL-convention normal map) -> "nor" in the index/loader contract. */
function normalizeMapName(map) {
  if (map === 'nor_gl' || map === 'nor_dx') return 'nor';
  if (map === 'diff') return 'diff';
  if (map === 'rough' || map === 'arm') return 'rough';
  return map;
}

function textureMapFromFiles(files, asset) {
  const out = {};
  for (const f of files) {
    const base = path.basename(f, '.jpg');
    const is512 = base.endsWith('_512');
    for (const map of asset.maps) {
      const norm = normalizeMapName(map);
      if (base.includes(`_${map}_`) || base.endsWith(`_${map}`)) {
        out[is512 ? `${norm}512` : norm] = f;
      }
    }
    if (base.includes('_arm_')) out[is512 ? 'rough512' : 'rough'] = f;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const lock = loadLock();

  if (!opts.dryRun) {
    ensureDir(PUBLIC_ASSETS);
    ensureDir(TMP_DIR);
  }

  const assets = manifest.assets.filter((a) => opts.tier === 'all' || a.tiers.includes(opts.tier));
  console.log(`[assets] processing ${assets.length}/${manifest.assets.length} assets for tier "${opts.tier}"${opts.dryRun ? ' (dry run)' : ''}`);

  const indexAssets = {};
  const categorySizes = {};
  let totalBytes = 0;
  let anyFailed = false;

  for (const asset of assets) {
    process.stdout.write(`[assets] ${asset.id} (${asset.type}) ... `);
    try {
      let result;
      switch (asset.type) {
        case 'file':
          result = await processFile(asset, lock, opts);
          break;
        case 'zip':
          result = await processZip(asset, lock, opts);
          break;
        case 'polyhaven-model':
          result = await processPolyhavenModel(asset, lock, opts);
          break;
        case 'polyhaven-texture':
          result = await processPolyhavenTexture(asset, lock, opts);
          break;
        default:
          throw new Error(`unknown asset type "${asset.type}"`);
      }
      console.log(opts.dryRun ? 'planned' : result.skipped ? 'skipped (up to date)' : `ok (${(result.bytes / 1024).toFixed(0)} KB)`);

      const primary = asset.category === 'texture' ? null : pickPrimary(result.files, asset.prefer);
      indexAssets[asset.id] = {
        category: asset.category,
        name: asset.name,
        author: asset.author,
        license: asset.license,
        licenseUrl: asset.licenseUrl,
        sourceUrl: asset.sourceUrl,
        attributionRequired: Boolean(asset.attributionRequired),
        files: result.files,
        primary,
        ...(asset.category === 'texture' ? { textures: result.textures ?? {} } : {}),
      };
      categorySizes[asset.category] = (categorySizes[asset.category] ?? 0) + result.bytes;
      totalBytes += result.bytes;
    } catch (err) {
      console.log('FAILED');
      const isOptional = Boolean(asset.optional);
      console.warn(`[assets] ${isOptional ? '(optional) ' : ''}${asset.id} failed: ${err.message ?? err}`);
      anyFailed = anyFailed || !isOptional;
      indexAssets[asset.id] = {
        category: asset.category,
        name: asset.name,
        author: asset.author,
        license: asset.license,
        licenseUrl: asset.licenseUrl,
        sourceUrl: asset.sourceUrl,
        attributionRequired: Boolean(asset.attributionRequired),
        files: [],
        primary: null,
        failed: true,
      };
    }
  }

  if (opts.dryRun) {
    console.log('\n[assets] dry run complete — no files written, no network calls beyond none intended.');
    return;
  }

  saveLock(lock);

  const index = { version: 1, tier: opts.tier, assets: indexAssets };
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + '\n');

  writeFileSync(CREDITS_PATH, buildCreditsMarkdown(manifest, indexAssets));

  rmSync(TMP_DIR, { recursive: true, force: true });

  console.log('\n[assets] summary:');
  for (const [cat, bytes] of Object.entries(categorySizes)) {
    console.log(`  ${cat.padEnd(10)} ${(bytes / (1024 * 1024)).toFixed(2)} MB`);
  }
  console.log(`  ${'total'.padEnd(10)} ${(totalBytes / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`[assets] wrote ${path.relative(ROOT, INDEX_PATH)} and ${path.relative(ROOT, CREDITS_PATH)}`);

  if (anyFailed && opts.strict) {
    console.error('[assets] one or more required assets failed and --strict was set');
    process.exit(1);
  }
}

function buildCreditsMarkdown(manifest, indexAssets) {
  const byCategory = new Map();
  for (const asset of manifest.assets) {
    const entry = indexAssets[asset.id];
    if (!entry) continue;
    const list = byCategory.get(asset.category) ?? [];
    const mods = [];
    if (asset.category === 'texture' && entry.textures && Object.keys(entry.textures).some((k) => k.endsWith('512'))) {
      mods.push('resized 512 px copies generated for the mobile tier');
    }
    if (asset.exclude?.some((g) => /\.(wav|ogg|mp3)$/i.test(g))) mods.push('bundled audio files removed (unused or wrong license)');
    if (asset.exclude?.some((g) => /\.blend/i.test(g))) mods.push('.blend source files removed (not needed at runtime)');
    if (asset.notes) mods.push(asset.notes);
    list.push({ ...entry, id: asset.id, modifications: mods.join('; '), failed: Boolean(entry.failed) });
    byCategory.set(asset.category, list);
  }

  const lines = [];
  lines.push('# Credits');
  lines.push('');
  lines.push(
    'Every downloaded asset in this game, generated by `npm run assets` from `scripts/asset-manifest.json`. ' +
      'Do not edit this file by hand — it is regenerated on every asset fetch.',
  );
  lines.push('');
  lines.push('## Licenses at a glance');
  lines.push('');
  lines.push(
    '- **CC0-1.0** ("public domain dedication"): no attribution is legally required, but we credit every author anyway because it is the right thing to do and because Poly Haven, OpenGameArt and Kenney all ask nicely.',
  );
  lines.push(
    '- **CC-BY** (any version): attribution IS required by the license. The footsteps pack below is CC-BY-3.0 — its credit line also appears on the in-game credits screen, not just here.',
  );
  lines.push('');

  for (const [category, list] of byCategory) {
    lines.push(`## ${category[0].toUpperCase()}${category.slice(1)}`);
    lines.push('');
    lines.push('| Asset | Author | License | Source | Modifications |');
    lines.push('|---|---|---|---|---|');
    for (const a of list) {
      const name = a.failed ? `${a.name} _(download failed — procedural fallback used)_` : a.name;
      const license = `[${a.license}](${a.licenseUrl})${a.attributionRequired ? ' **(attribution required)**' : ''}`;
      lines.push(`| ${name} | ${a.author} | ${license} | [link](${a.sourceUrl}) | ${a.modifications || '—'} |`);
    }
    lines.push('');
  }

  lines.push(
    '_Custom drop-in assets a player adds under `public/assets/custom/` (see `docs/CUSTOM_ASSETS.md`) are not listed here — they are gitignored and credited live from their own manifest entry on the in-game credits screen._',
  );
  lines.push('');
  return lines.join('\n');
}

main().catch((err) => {
  console.error('[assets] fatal:', err);
  process.exit(1);
});
