# Drop-in custom assets

This folder is where you put your own character or weapon models — a photoreal
Mixamo soldier, a Sketchfab weapon, anything you download yourself. Nothing
here is committed to git or fetched by `npm run assets`; it's entirely local
and entirely optional.

## Quick start

1. Copy `manifest.example.json` (next to this file) to `manifest.json`.
2. Put your model file(s) in this folder (or a subfolder, e.g. `weapons/`).
3. Edit `manifest.json`: point `character.url` / `weapons.<slot>.url` at your
   file(s), fill in `author` / `license` / `sourceUrl` so the in-game credits
   screen and `CREDITS.md`-equivalent stay honest.
4. Reload the game. Open the browser console — the loader logs a warning for
   anything it couldn't match (e.g. a mistyped animation clip name).

Full walkthrough, Mixamo export settings and the exact animation-clip mapping:
see `docs/CUSTOM_ASSETS.md` at the repository root.

## What you can override

- **`character`**: a full replacement for the default operator/soldier
  mannequin. `.glb`/`.gltf` or `.fbx` (Mixamo exports FBX). Optional
  `clipMap` renames the file's animation clips to the names the game expects
  (`Idle_Loop`, `Walk_Loop`, ...). Missing clips just mean that action falls
  back to the nearest one the base rig has (or a static pose) — nothing
  breaks.
- **`weapons.ar` / `.smg` / `.sniper` / `.shotgun` / `.pistol`**: a full
  replacement for one weapon's model. `.glb`, `.gltf`, `.fbx`, `.obj` (with an
  optional sibling `.mtl`), or `.dae`. The loader auto-detects the barrel end
  and normalizes scale/orientation the same way it does for the built-in
  weapons, so you don't need to hand-place `Muzzle`/`Grip` unless the
  automatic guess looks wrong — then set `muzzle: [x,y,z]` / `grip: [x,y,z]`
  in the manifest to override just that.

## Licensing

Whatever you drop in here is your download, under whatever license the
creator chose — CC0, CC-BY, a Mixamo/Adobe license, a Sketchfab "Standard"
license, etc. Fill in `author`, `license` and `sourceUrl` in `manifest.json`;
the loader reads them and shows a credit for your asset on the in-game
credits screen. If the license requires attribution, that's what satisfies it
— don't skip it.

Never commit downloaded assets you don't have redistribution rights for. This
folder (everything except this README and `manifest.example.json`) is already
listed in `.gitignore` for exactly that reason.
