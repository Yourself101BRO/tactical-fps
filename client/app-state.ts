// Tiny typed event emitter and the top-level screen state machine used by
// client/main.ts. Deliberately dependency-free so it can be unit-tested in Node.

export type Listener<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as Listener<never>);
    return () => set!.delete(fn as Listener<never>);
  }

  once<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    const off = this.on(event, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) (fn as Listener<Events[K]>)(payload);
  }

  clear(): void {
    this.listeners.clear();
  }
}

/** Top-level screens. Transitions are validated so a stray callback cannot skip the lobby. */
export type Screen =
  | 'boot'
  | 'menu'
  | 'connecting'
  | 'lobby'
  | 'loadout'
  | 'match'
  | 'spectate'
  | 'results'
  | 'settings'
  | 'credits'
  | 'error';

const TRANSITIONS: Record<Screen, readonly Screen[]> = {
  boot: ['menu', 'error'],
  menu: ['connecting', 'settings', 'credits', 'match', 'error'],
  connecting: ['lobby', 'menu', 'error', 'match'],
  lobby: ['loadout', 'match', 'menu', 'settings', 'error'],
  loadout: ['lobby', 'match'],
  match: ['spectate', 'results', 'lobby', 'menu', 'settings', 'loadout', 'error'],
  spectate: ['match', 'results', 'lobby', 'menu', 'settings', 'error'],
  results: ['lobby', 'menu'],
  settings: ['menu', 'lobby', 'match', 'spectate'],
  credits: ['menu'],
  error: ['menu'],
};

export interface AppEvents extends Record<string, unknown> {
  screen: { from: Screen; to: Screen };
}

export class AppState extends Emitter<AppEvents> {
  private current: Screen = 'boot';
  private previous: Screen = 'boot';

  get screen(): Screen {
    return this.current;
  }

  get lastScreen(): Screen {
    return this.previous;
  }

  canGo(to: Screen): boolean {
    return TRANSITIONS[this.current].includes(to);
  }

  /** Move to `to` if the transition is allowed. Returns false (and does nothing) otherwise. */
  go(to: Screen): boolean {
    if (to === this.current) return true;
    if (!this.canGo(to)) return false;
    const from = this.current;
    this.previous = from;
    this.current = to;
    this.emit('screen', { from, to });
    return true;
  }

  /** Return to the screen we came from (settings overlay → back). */
  back(): boolean {
    return this.go(this.previous);
  }

  /** Force a screen without validation (used for error recovery). */
  reset(to: Screen): void {
    const from = this.current;
    this.previous = from;
    this.current = to;
    this.emit('screen', { from, to });
  }
}
