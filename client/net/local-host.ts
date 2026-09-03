// Practice mode: an in-process Room (with bots) driven by the same fixed-tick
// HostLoop as the real hosts. No transport is attached here — the local
// player connects via `ClientNet.connectLocal(localHost.room, hello)`, left
// to the integrator (client/main.ts) since it needs the player's chosen
// name/loadout to build the HelloMsg, which this class has no source for.

import { Room } from '../../shared/net/room.ts';
import type { RoomOptions } from '../../shared/net/room.ts';
import { HostLoop } from './host-loop.ts';

export class LocalHost {
  readonly room: Room;
  private readonly loop: HostLoop;

  constructor(opts: RoomOptions) {
    this.room = new Room(opts);
    this.loop = new HostLoop(this.room);
  }

  start(): void {
    this.room.start();
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
    this.room.close();
  }
}
