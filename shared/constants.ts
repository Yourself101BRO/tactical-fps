// Single source of every tunable and every id used by the simulation, the
// protocol, the server and the client. Nothing else in the codebase may define
// a gameplay number. Pure data: no DOM, no three.js, no clocks.

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------
export const PROTOCOL_VERSION = 1;
export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;
/** Snapshots are sent every Nth tick (60 / 3 = 20 Hz). */
export const SNAPSHOT_EVERY = 3;
/** Inputs are sampled and sent on a fixed cadence, never per rendered frame. */
export const INPUT_SEND_HZ = 60;
/** Each INPUT message carries the newest command plus this many older ones minus one. */
export const INPUT_REDUNDANCY = 3;
/** Server drops INPUT messages beyond this rate (headroom above INPUT_SEND_HZ). */
export const MAX_INPUT_MSGS_PER_SEC = 75;
/** Remote entities render this many ticks behind the estimated server tick (100 ms). */
export const INTERP_TICKS = 6;
export const INTERP_BUFFER_SIZE = 8;
export const EXTRAPOLATE_MAX_MS = 150;
/** No snapshot for this long on the WebSocket path = stall: freeze, indicate, snap on resume. */
export const STALL_MS = 250;
/** A disconnected player's slot and state survive this long for a rejoin. */
export const REJOIN_GRACE_MS = 20_000;
export const RECONNECT_TIMEOUT_MS = 10_000;
export const P2P_CONNECT_TIMEOUT_MS = 10_000;
export const LAGCOMP_HISTORY_TICKS = 60;
export const PING_INTERVAL_MS = 1000;
export const RTT_EMA_ALPHA = 0.1;
export const RTT_MIN_WINDOW = 5;
/** Max slew of the local server-tick estimate: 1 tick per 100 ms. */
export const CLOCK_SLEW_TICKS_PER_MS = 1 / 100;
export const PREDICTION_BUFFER_SIZE = 256;
export const RECONCILE_IGNORE_DIST = 0.02;
export const RECONCILE_SNAP_DIST = 1.5;
export const RECONCILE_SMOOTH_HZ = 10;
export const MAX_PLAYERS = 12;
export const MAX_NAME_LEN = 16;
export const ROOM_CODE_LEN = 4;
/** No 0/O/1/I so codes survive being read out loud. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const MAX_MSG_SIZE = 4096;
export const MAX_CHAT_LEN = 64;
export const WS_BACKPRESSURE_BYTES = 65_536;
export const ROOM_STATE_INTERVAL_TICKS = 30;
export const DEFAULT_PORT = 8080;
export const PEER_ID_PREFIX = 'tfps-';

// ---------------------------------------------------------------------------
// Ids: teams, modes, phases, connection states, buttons, stances, move states
// ---------------------------------------------------------------------------
export const TEAM_NONE = 0;
export const TEAM_A = 1;
export const TEAM_B = 2;

export const MODE_ANY = 0;
export const MODE_FFA = 1;
export const MODE_TDM = 2;
export const MODE_SND = 3;

export const PHASE_LOBBY = 0;
export const PHASE_WARMUP = 1;
/** S&D round-start freeze. */
export const PHASE_FREEZE = 2;
export const PHASE_LIVE = 3;
export const PHASE_ROUND_END = 4;
export const PHASE_MATCH_END = 5;

/** Player connection/participation state (WELCOME.connState, ROOM_STATE players[].connState). */
export const CONN_ACTIVE = 0;
export const CONN_WAITING_ROUND = 1;
export const CONN_SPECTATING = 2;
export const CONN_DISCONNECTED = 3;

/** InputCmd.buttons bitmask (u16). */
export const BTN_JUMP = 1 << 0;
export const BTN_CROUCH = 1 << 1;
export const BTN_PRONE = 1 << 2;
export const BTN_SPRINT = 1 << 3;
export const BTN_TACSPRINT = 1 << 4;
export const BTN_FIRE = 1 << 5;
export const BTN_ADS = 1 << 6;
export const BTN_RELOAD = 1 << 7;
export const BTN_MELEE = 1 << 8;
export const BTN_LETHAL = 1 << 9;
export const BTN_TACTICAL = 1 << 10;
export const BTN_INTERACT = 1 << 11;
export const BTN_MOUNT = 1 << 12;
export const BTN_SWAP = 1 << 13;
export const BTN_ALL = (1 << 14) - 1;

export const STANCE_STAND = 0;
export const STANCE_CROUCH = 1;
export const STANCE_PRONE = 2;

/** PlayerState.moveState (4 bits in the snapshot flags). */
export const MOVE_IDLE = 0;
export const MOVE_WALK = 1;
export const MOVE_SPRINT = 2;
export const MOVE_TACSPRINT = 3;
export const MOVE_SLIDE = 4;
export const MOVE_MANTLE = 5;
export const MOVE_AIR = 6;
export const MOVE_CROUCH_MOVE = 7;
export const MOVE_PRONE_MOVE = 8;
export const MOVE_MOUNTED = 9;
export const MOVE_DEAD = 10;

// ---------------------------------------------------------------------------
// Weapons, equipment, perks, hit zones, materials
// ---------------------------------------------------------------------------
export const WEAPON_AR = 0;
export const WEAPON_SMG = 1;
export const WEAPON_SNIPER = 2;
export const WEAPON_SHOTGUN = 3;
export const WEAPON_PISTOL = 4;
export const WEAPON_COUNT = 5;
export const WEAPON_NONE = 255;

export const SLOT_PRIMARY = 0;
export const SLOT_SECONDARY = 1;

export const LETHAL_FRAG = 0;
export const TACTICAL_FLASH = 0;

export const PROJ_FRAG = 0;
export const PROJ_FLASH = 1;
export const PROJ_SMOKE = 2;

export const PERK_NONE = 0;
export const PERK_DOUBLE_TIME = 1;
export const PERK_EOD = 2;
export const PERK_GHOST = 3;
export const PERK_AMPED = 4;
export const PERK_QUICK_FIX = 5;
export const PERK_TRACKER = 6;
export const PERK_COUNT = 7;

export const ZONE_HEAD = 0;
export const ZONE_CHEST = 1;
export const ZONE_LIMB = 2;

export const MAT_CONCRETE = 0;
export const MAT_METAL = 1;
export const MAT_WOOD = 2;
export const MAT_GRAVEL = 3;
export const MAT_ASPHALT = 4;
export const MAT_BRICK = 5;
export const MAT_PLASTER = 6;
export const MAT_SAND = 7;
export const MAT_FLESH = 8;
export const MAT_COUNT = 9;

export const MAP_COMPOUND = 0;

// ---------------------------------------------------------------------------
// Body and movement (metres, seconds, m/s, m/s²)
// ---------------------------------------------------------------------------
export const PLAYER_RADIUS = 0.35;
export const HEIGHT_STAND = 1.8;
export const HEIGHT_CROUCH = 1.2;
export const HEIGHT_PRONE = 0.6;
export const EYE_STAND = 1.62;
export const EYE_CROUCH = 1.05;
export const EYE_PRONE = 0.4;
export const STEP_HEIGHT = 0.45;
export const GRAVITY = 22;
export const TERMINAL_VELOCITY = 40;
export const FALL_DAMAGE_MIN_HEIGHT = 6;
export const FALL_DAMAGE_PER_M = 10;
export const STANCE_TIME_CROUCH = 0.25;
export const STANCE_TIME_TO_PRONE = 0.9;
export const STANCE_TIME_FROM_PRONE = 0.8;

export const SPEED_WALK = 4.3;
export const STRAFE_MULT = 0.9;
export const BACK_MULT = 0.8;
export const SPEED_CROUCH = 2.4;
export const SPEED_PRONE = 1.2;
export const SPEED_SPRINT = 6.2;
export const SPEED_TACSPRINT = 8.2;
export const GROUND_ACCEL = 40;
export const GROUND_DECEL = 50;
export const AIR_ACCEL = 6;
export const JUMP_VELOCITY = 6.6;
export const LANDING_SLOW_MULT = 0.6;
export const LANDING_SLOW_TIME = 0.25;
export const LANDING_SPREAD_BUMP = 2.0;

export const SPRINT_CONE_DEG = 45;
export const SPRINT_START_DELAY = 0.1;
export const TACSPRINT_DURATION = 4.0;
export const TACSPRINT_COOLDOWN = 3.0;
export const TACSPRINT_SPRINTOUT_MULT = 1.4;

export const SLIDE_SPEED_START = 7.5;
export const SLIDE_SPEED_END = 2.5;
export const SLIDE_DURATION = 0.75;
export const SLIDE_ADS_LOCK = 0.2;
export const SLIDE_CANCEL_KEEP = 0.9;
export const SLIDE_CAMERA_HEIGHT = 0.8;
export const SLIDE_CAMERA_ROLL_DEG = 8;

export const MANTLE_RAY_DIST = 0.7;
export const MANTLE_MIN_HEIGHT = 0.5;
export const MANTLE_MAX_HEIGHT = 1.6;
export const MANTLE_LOW_THRESHOLD = 0.9;
export const MANTLE_DURATION = 0.5;
export const MANTLE_DURATION_LOW = 0.35;

export const MOUNT_RANGE = 0.6;
export const MOUNT_EDGE_TOLERANCE = 0.3;
export const MOUNT_LEAN = 0.4;
export const MOUNT_RECOIL_MULT = 0.5;

export const ADS_SENS_MULT = 0.6;
export const ADS_SENS_MULT_SNIPER = 0.3;
export const FOV_DEFAULT = 90;
export const FOV_MIN = 70;
export const FOV_MAX = 110;
export const FOV_SPRINT_KICK = 5;
export const FOV_TACSPRINT_KICK = 10;
export const VIEWMODEL_FOV = 60;

// ---------------------------------------------------------------------------
// Health, damage, melee, respawn
// ---------------------------------------------------------------------------
export const HEALTH_MAX = 100;
export const REGEN_DELAY = 4.0;
export const REGEN_DELAY_QUICK_FIX = 1.5;
export const REGEN_RATE = 40;
export const FLINCH_PITCH_DEG = 1.5;
export const FLINCH_YAW_DEG = 0.5;
export const MELEE_RANGE = 1.6;
export const MELEE_TIME = 0.8;
export const MELEE_HIT_AT = 0.25;
/** Melee bypasses the damage pipeline (one-hit kill); this value only exists for the kill event. */
export const MELEE_DAMAGE = 999;
export const RESPAWN_DELAY = 3.0;
export const SWAP_TIME = 0.6;
export const AMPED_SWAP_MULT = 1 / 1.7;
export const HEAD_RADIUS = 0.12;

// ---------------------------------------------------------------------------
// Grenades
// ---------------------------------------------------------------------------
export const FRAG_FUSE = 4.5;
export const FRAG_THROW_SPEED = 18;
export const FRAG_RESTITUTION = 0.3;
export const FRAG_FRICTION = 0.7;
export const FRAG_DAMAGE_MAX = 120;
export const FRAG_DAMAGE_MIN = 25;
export const FRAG_RADIUS_FULL = 2;
export const FRAG_RADIUS = 6;
export const FLASH_FUSE = 1.5;
export const FLASH_THROW_SPEED = 18;
export const FLASH_RADIUS = 8;
export const FLASH_BLIND_TIME = 1.0;
export const FLASH_FADE_TIME = 1.5;
export const FLASH_DEAFEN_TIME = 2.0;
export const GRENADE_RADIUS = 0.08;
export const GRENADES_PER_LIFE = 1;
export const GRENADE_PULL_TIME = 0.35;
export const EOD_EXPLOSIVE_MULT = 0.5;

// ---------------------------------------------------------------------------
// Match rules
// ---------------------------------------------------------------------------
export const WARMUP_SECONDS = 10;
export const MATCH_END_SECONDS = 15;
export const FFA_KILL_LIMIT = 30;
export const TDM_KILL_LIMIT = 75;
export const DM_TIME_LIMIT = 600;
export const SND_ROUNDS_TO_WIN = 6;
export const SND_MAX_ROUNDS = 11;
export const SND_SWAP_AFTER = 5;
export const SND_ROUND_SECONDS = 90;
export const SND_PLANT_TIME = 5;
export const SND_DEFUSE_TIME = 5;
export const SND_BOMB_FUSE = 45;
export const SND_FREEZE_SECONDS = 3;
export const SND_ROUND_END_SECONDS = 5;
export const SND_SITE_RADIUS = 3;

export const BOMB_NONE = 0;
export const BOMB_CARRIED = 1;
export const BOMB_DROPPED = 2;
export const BOMB_PLANTED = 3;
export const BOMB_DEFUSED = 4;
export const BOMB_EXPLODED = 5;

export const MINIMAP_REVEAL_SECONDS = 1.5;
export const KILLFEED_SECONDS = 6;
export const TRACKER_SECONDS = 3;
export const SPAWN_MIN_ENEMY_DIST = 12;

// ---------------------------------------------------------------------------
// Snapshot event types (GameEvent.type) and special kill "weapon" ids
// ---------------------------------------------------------------------------
export const EV_FIRE = 0;
export const EV_HIT = 1;
export const EV_KILL = 2;
export const EV_IMPACT = 3;
export const EV_EXPLODE = 4;
export const EV_FLASHED = 5;
export const EV_PLANT = 6;
export const EV_DEFUSE = 7;
export const EV_ROUND = 8;
export const EV_RESPAWN = 9;
export const EV_THROW = 10;
export const EV_MELEE = 11;
export const EV_RELOAD = 12;
export const EV_BOMB_PICKUP = 13;

export const KILL_MELEE = 255;
export const KILL_FRAG = 254;
export const KILL_FALL = 253;
export const KILL_BOMB = 252;

export const ROUND_START = 0;
export const ROUND_END = 1;

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------
export const BOT_RECRUIT = 0;
export const BOT_REGULAR = 1;
export const BOT_VETERAN = 2;
export const BOT_MEMORY_SECONDS = 3;
export const BOT_ADS_RANGE = 15;

// ---------------------------------------------------------------------------
// Quantization used by the protocol (shared so tests and clients agree)
// ---------------------------------------------------------------------------
export const TWO_PI = Math.PI * 2;
export const YAW_SCALE = 65535 / TWO_PI;
export const PITCH_SCALE = 32767 / (Math.PI / 2);
export const VEL_SCALE = 100;
export const UNIT_DIR_SCALE = 127;
export const TIME_SCALE = 10; // seconds → tenths in u16
