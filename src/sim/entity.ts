import type { DamageState, EntityTypeDef, ForceId, MoraleState, Plan, Reactions, Roe, TaskSpec, Vec2, Vec3 } from '../shared/types.js';
import type { PlanExecutor } from './plans.js';
import type { Task } from './tasks.js';
import type { Unit } from './units.js';

export interface Contact {
  id: string;
  firstSeen: number;
  lastSeen: number;
  x: number;
  y: number;
  z: number;
}

/** Movement request produced by a task each tick and consumed by the mover. */
export interface SteerCommand {
  x: number;
  y: number;
  speed: number;
  /** Decelerate to arrive at the point instead of driving through it. */
  arrive: boolean;
  /** Face this heading once stopped (used by formation slots). */
  finalHeading?: number;
}

export class Entity {
  x: number;
  y: number;
  z = 0;
  heading: number;
  pitch = 0;
  roll = 0;
  speed = 0;
  /** Vertical speed (m/s, up positive). */
  vz = 0;

  roe: Roe = 'fireAtWill';
  mobilityKill = false;
  firepowerKill = false;
  destroyed = false;

  task: Task | null = null;
  plan: PlanExecutor | null = null;
  /** What the user last assigned, kept so scenarios can be saved and rewound. */
  assignedPlan?: Plan;
  assignedTask?: TaskSpec;
  unit: Unit | null = null;
  steer: SteerCommand | null = null;
  /** Set by the mover when terrain stopped movement this tick. */
  blocked = false;

  reactions: Reactions = {};
  /** True while the on-contact reaction holds the entity in place. */
  halted = false;
  /** Set once the withdraw reaction has fired. */
  withdrawn = false;
  /** Carrier id while riding in another entity (mounted infantry). */
  embarkedIn?: string;
  /** Simulation time this observer may call for fire again. */
  callForFireAt = -Infinity;
  /** Smoke grenade salvos left. */
  smokeLeft = 0;
  /** 0..1 suppression from incoming fire (decays). */
  suppression = 0;
  /** True while pinned down by fire (infantry). */
  pinned = false;
  /** Morale of an entity that is not in a unit (units keep their own). */
  morale = 1;
  moraleState: MoraleState = 'steady';
  /** In a prepared position: infantry dug in, or a vehicle hull-down. */
  prepared?: 'dugIn' | 'hullDown';
  /** 0..1 fuel left. */
  fuel = 1;
  /** Supply vehicles: full loads left to hand out. */
  supplies = 0;

  /** Cruise speed override (m/s) set by plans. */
  speedOverride?: number;
  /** Altitude above ground override (m) for aircraft. */
  altitudeOverride?: number;

  readonly ammo = new Map<string, number>();
  readonly weaponReadyAt = new Map<string, number>();
  readonly contacts = new Map<string, Contact>();
  /** Shooter id -> last time it fired at this entity. */
  readonly attackers = new Map<string, number>();
  underFireUntil = -Infinity;
  lastFiredAt = -Infinity;
  engagingId?: string;
  /** Explicit target from an attack task; engaged regardless of ROE. */
  attackTargetId?: string;

  /** Jammers: switched on (they start on). */
  jamming = true;
  /** A background civilian the pattern-of-life model adds and removes. */
  ambient?: boolean;

  /** True for entities owned by another simulation (received via DIS). */
  remote = false;
  /** DIS entity number for locally owned entities, or full remote id. */
  disNumber = 0;
  remoteDis?: { site: number; application: number; entity: number };
  remoteLastUpdate = 0;
  remoteVelocity: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    readonly id: string,
    public name: string,
    readonly type: EntityTypeDef,
    readonly force: ForceId,
    pos: Vec2,
    heading: number,
  ) {
    this.x = pos.x;
    this.y = pos.y;
    this.heading = heading;
  }

  get position(): Vec3 {
    return { x: this.x, y: this.y, z: this.z };
  }

  get domain() {
    return this.type.domain;
  }

  get alive(): boolean {
    return !this.destroyed;
  }

  get damage(): DamageState {
    if (this.destroyed) return 'destroyed';
    if (this.mobilityKill) return 'mobility';
    if (this.firepowerKill) return 'firepower';
    return 'none';
  }

  /** Effective cruise speed honouring any plan override. */
  get cruiseSpeed(): number {
    return Math.min(this.speedOverride ?? this.type.cruiseSpeed, this.type.maxSpeed);
  }

  /** Eye position of the entity's sensors. */
  get eye(): Vec3 {
    return { x: this.x, y: this.y, z: this.z + this.type.sensorHeight };
  }

  /** World velocity vector (east, north, up); `speed` is horizontal ground speed. */
  get velocity(): Vec3 {
    if (this.remote) return this.remoteVelocity;
    return { x: Math.sin(this.heading) * this.speed, y: Math.cos(this.heading) * this.speed, z: this.vz };
  }
}
