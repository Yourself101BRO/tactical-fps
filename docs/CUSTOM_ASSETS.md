# Custom assets: dropping in your own character or weapon

The built-in character is a free, license-clean, account-free stylized
mannequin (see the root `CREDITS.md`) — that's the honest limit of what's
downloadable without logging into anything. If you want a true photoreal COD-
style soldier, this is the path: download one yourself from a site that
requires an account (Mixamo, Sketchfab, CGTrader...), drop it in
`public/assets/custom/`, and the game picks it up automatically. No code
changes, no rebuild step.

This document covers two cases: a **Mixamo soldier** (character) and a
**Sketchfab CC-BY weapon**. The mechanism (`public/assets/custom/manifest.json`)
is the same one described more briefly in `public/assets/custom/README.md`.

---

## 1. Mixamo character

### 1.1 Export settings (get these right or the model won't load correctly)

On [mixamo.com](https://www.mixamo.com) (free Adobe account required — that's
the account step I can't do for you):

1. Pick a character, or upload your own rigged model for auto-rigging.
2. Pick an animation and click **Download**. In the download dialog:
   - **Format: FBX Binary (.fbx)** — the loader's `FBXLoader` reads this.
   - **Skin: With Skin** for the very first download (this is the one that
     carries the mesh + skeleton). Every subsequent animation-only download
     for the *same* character can use **Without Skin** — smaller files, same
     skeleton, so the animation retargets identically once merged.
   - **Frame rate: 30 fps** matches this project's fixed tick assumptions
     elsewhere and keeps file sizes sane; 60 fps also works but doubles clip
     size for no visible benefit at our sim rate.
   - **Keyframe reduction: none** (uncompressed) is safest; Mixamo's
     "moderate" setting is usually fine too if you want smaller files.
   - **In Place: ON**, for every clip, including one-shots like the death and
     roll animations. This game's movement is entirely code-driven
     (`shared/movement.ts` sets the position every tick) — an animation that
     also carries root-motion translation will fight the code-driven
     position and the character will visibly slide or double-move. "In
     Place" strips translation from the root bone and keeps just the pose.

### 1.2 One file vs. several

**The loader reads animation clips from a single file** (whatever you point
`character.url` at). Two ways to get everything into one file:

- **Simplest**: download just the clips you care about most (e.g. Idle,
  Walk, Death) *with skin* on the Mixamo site's multi-animation queue — it
  lets you add several animations to the cart for one character and download
  them as one batch, but each still comes out as a **separate** FBX sharing
  a skeleton, not one merged file with an animations exported into it.
  Simplest is to keep only ONE clip baked into `character.url` (typically
  Idle, "With Skin"), map just `Idle_Loop` in `clipMap`, and accept a mostly
  static character. This still upgrades the *look* immediately — the mesh,
  face and gear are all real — with zero merging work.
- **Full rig** (recommended once you're happy with the model): merge every
  downloaded FBX into one file that carries the mesh once and every
  animation clip alongside it. Free options: Blender (File → Import each
  FBX; use the NLA editor or `bpy`'s `bpy.ops.import_scene.fbx` in a small
  script to pull each animation's action into the first file's armature,
  then File → Export → FBX with "Baked Animation" checked), or any of the
  several free "Mixamo FBX merger" scripts published for exactly this
  workflow. Export the merged result as one `.fbx` (or convert to `.glb` —
  either loads) and point `character.url` at it.

### 1.3 Clip names the game looks for

`shared/` and `client/render/characters.ts` (owned by another part of this
codebase) expect these canonical clip names. Map each one your file actually
has via `clipMap` in `manifest.json` — canonical name on the left, your
file's real clip name on the right:

| Canonical name | What it's for | A Mixamo animation that fits |
|---|---|---|
| `Idle_Loop` | Standing still | Idle |
| `Walk_Loop` | Walking | Walking (In Place) |
| `Jog_Fwd_Loop` | Jogging forward | Jogging (In Place) |
| `Sprint_Loop` | Sprint / tac-sprint | Fast Run (In Place) |
| `Crouch_Idle_Loop` | Crouched, standing still | Crouch Idle |
| `Crouch_Fwd_Loop` | Crouched, moving forward | Crouched Walking |
| `Jump_Loop` | Airborne | Falling Idle (or trim a Jump clip to its apex) |
| `Pistol_Aim_Neutral` | ADS aim pose (blended by pitch) | Aiming Idle / Pistol Idle |
| `Pistol_Shoot` | Fire one-shot | Firing Pistol / Pistol Shoot |
| `Pistol_Reload` | Reload one-shot | Reload |
| `Death01` | Death one-shot | Dying / Death From Right |
| `Hit_Chest` | Damage-flinch one-shot | Hit Reaction |
| `Roll` | Slide-cancel / dive | Forward Roll / Standing Dodge |

Any canonical name you don't map (or that doesn't match your file's actual
clip name) is simply skipped — the character keeps whatever pose/clip it had,
nothing crashes. **Check the browser console after reloading**: the loader
logs a warning naming every `clipMap` entry it couldn't find, and lists the
clip names your file actually contains, so you can copy-paste the correct
right-hand side.

Mixamo's exported clip names are usually `mixamo.com|<Animation Name>` (the
example `manifest.example.json` uses this convention) but can vary with
export tooling — trust the console warning over this table if they disagree.

### 1.4 manifest.json

```json
{
  "character": {
    "url": "/assets/custom/character.fbx",
    "scale": 1,
    "clipMap": {
      "Idle_Loop": "mixamo.com|Idle",
      "Walk_Loop": "mixamo.com|Walking"
    },
    "author": "Your name",
    "license": "Mixamo (Adobe) standard license",
    "sourceUrl": "https://www.mixamo.com/"
  }
}
```

---

## 2. Sketchfab CC-BY weapon

1. Find a weapon model licensed **CC-BY** or **CC0** (Sketchfab's filter
   sidebar: Licenses → Creative Commons). CC-BY is fine — just credit it,
   which `manifest.json`'s `author`/`license`/`sourceUrl` fields do
   automatically on the in-game credits screen.
2. Download the **glTF (.glb)** format if offered — one file, textures
   embedded, simplest path. `.fbx` and `.obj`(+`.mtl`) also work.
3. Put the file under `public/assets/custom/weapons/`, e.g. `ar.glb`.
4. Add it to `manifest.json`:

```json
{
  "weapons": {
    "ar": {
      "url": "/assets/custom/weapons/ar.glb",
      "author": "Sketchfab creator's name",
      "license": "CC-BY-4.0",
      "sourceUrl": "https://sketchfab.com/3d-models/..."
    }
  }
}
```

Valid weapon slot keys are exactly `ar`, `smg`, `sniper`, `shotgun`, `pistol`
(the game's five weapon ids). The loader centers the model, auto-detects
which end is the barrel (the thinner cross-section), rotates it so the
barrel points forward, and scales it to that weapon's real-world length from
`shared/weapons.ts` — the same normalization the built-in OpenGameArt models
go through. If the auto-detected muzzle or grip point looks wrong in-game
(flash appears at the wrong end, hands attach oddly), override it explicitly:

```json
"ar": {
  "url": "/assets/custom/weapons/ar.glb",
  "muzzle": [0, 0.01, -0.55],
  "grip": [0, -0.04, 0.12]
}
```
Coordinates are metres, in the model's own local space after normalization
(barrel along -Z, origin at the model's center).

---

## 3. Both together, and what to expect

You can set `character` and any subset of `weapons` in the same
`manifest.json` — each is independent, and anything you don't set keeps the
built-in/procedural default. Nothing here requires touching a single line of
game code: `client/assets/loader.ts` reads `public/assets/custom/manifest.json`
at load time and wires it into the same `GameAssets` object the rest of the
client already consumes.

If a custom asset fails to load (bad path, unsupported format, corrupt file),
the loader logs a `console.warn` with the error and falls back to the default
asset for that slot — the game still runs.
