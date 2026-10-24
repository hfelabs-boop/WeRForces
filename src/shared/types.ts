// Shared, serializable types used by the simulation engine, the server API
// and the browser front-end. Everything in here must be plain JSON data.
//
// Coordinate conventions (local tangent plane around the terrain origin):
//   x = metres east, y = metres north, z = metres above mean sea level.
//   heading = radians clockwise from true north, pitch = radians nose-up.

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 extends Vec2 {
  z: number;
}

/** Force identifiers match DIS Force ID enumeration (IEEE 1278.1). */
export type ForceId = 0 | 1 | 2 | 3;
export const FORCE_OTHER: ForceId = 0;
export const FORCE_BLUE: ForceId = 1;
export const FORCE_RED: ForceId = 2;
export const FORCE_NEUTRAL: ForceId = 3;
export const FORCE_NAMES: Record<ForceId, string> = {
  0: 'Other',
  1: 'Blue',
  2: 'Red',
  3: 'Neutral',
};

export type Domain = 'ground' | 'lifeform' | 'air' | 'surface';
export type ArmorClass = 'lifeform' | 'soft' | 'light' | 'armored' | 'air' | 'ship';
export type SymbolKind =
  | 'armor'
  | 'mech'
  | 'infantry'
  | 'recon'
  | 'wheeled'
  | 'air-defense'
  | 'artillery'
  | 'rotary'
  | 'fixed-wing'
  | 'uav'
  | 'ship'
  | 'boat'
  | 'generic';

export type DamageState = 'none' | 'mobility' | 'firepower' | 'destroyed';
export type Roe = 'holdFire' | 'returnFire' | 'fireAtWill';
export type Formation = 'column' | 'line' | 'wedge' | 'vee' | 'echelonRight';

/** DIS Entity Type record (kind.domain.country.category.subcategory.specific.extra). */
export interface DisEntityType {
  kind: number;
  domain: number;
  country: number;
  category: number;
  subcategory: number;
  specific: number;
  extra: number;
}

// ---------------------------------------------------------------- catalog

export interface WeaponDef {
  id: string;
  name: string;
  /** DIS munition entity type, sent in Fire/Detonation burst descriptors. */
  munition: DisEntityType;
  minRange: number;
  maxRange: number;
  /** Seconds between shots/bursts. */
  reloadTime: number;
  /** Rounds (or bursts) carried. */
  ammo: number;
  /** Munition flight speed in m/s, used for time of flight. */
  projectileSpeed: number;
  /** Probability of a catastrophic kill per shot at short range, per target class. */
  pk: Partial<Record<ArmorClass, number>>;
  /** Domains this weapon can engage. */
  targets: Domain[];
  /** Guided munitions do not need the shooter to keep line of sight after launch. */
  guided?: boolean;
}

export interface SensorDef {
  id: string;
  name: string;
  maxRange: number;
  /** Full field of view in radians (2*PI = all-round). */
  fov: number;
  /** Domains this sensor can detect. */
  detects: Domain[];
  /** Ignores forest concealment and terrain masking only for air targets (radar). */
  radar?: boolean;
}

export interface EntityTypeDef {
  id: string;
  name: string;
  description: string;
  domain: Domain;
  symbol: SymbolKind;
  armor: ArmorClass;
  dis: DisEntityType;
  /** Maximum speed in m/s. */
  maxSpeed: number;
  /** Default cruise speed in m/s. */
  cruiseSpeed: number;
  /** Lowest flying speed for fixed wing aircraft (m/s); 0 means it can hover/stop. */
  minSpeed?: number;
  /** Acceleration in m/s^2. */
  acceleration: number;
  /** Turn rate in rad/s. */
  turnRate: number;
  /** Speed multiplier off-road (ground) / in forest (lifeform). */
  offroadFactor: number;
  /** Default cruise altitude above ground for aircraft. */
  cruiseAltitude?: number;
  climbRate?: number;
  /** Eye height of the crew/sensors above the entity position. */
  sensorHeight: number;
  sensors: string[];
  weapons: string[];
  /** Number of personnel (informational). */
  crew: number;
}

export interface UnitTemplate {
  id: string;
  name: string;
  echelon: 'team' | 'section' | 'platoon' | 'company' | 'flight' | 'group';
  members: string[];
  formation: Formation;
  spacing: number;
}

export interface Catalog {
  entityTypes: EntityTypeDef[];
  weapons: WeaponDef[];
  sensors: SensorDef[];
  unitTemplates: UnitTemplate[];
}

// ---------------------------------------------------------------- tasks & plans

export type TaskSpec =
  | { type: 'moveTo'; target: Vec2; speed?: number }
  | { type: 'followRoute'; routeId: string; speed?: number; reverse?: boolean }
  | { type: 'patrol'; routeId: string; speed?: number }
  | { type: 'wait'; duration: number }
  | { type: 'follow'; targetId: string; distance?: number }
  | { type: 'attack'; targetId: string }
  | { type: 'orbit'; center: Vec2; radius: number; duration?: number }
  | { type: 'formation'; leaderId: string };

export type Condition =
  | { type: 'simTime'; time: number }
  | { type: 'inArea'; areaId: string }
  | { type: 'enemyDetected' }
  | { type: 'underFire' }
  | { type: 'entityDestroyed'; entityId: string };

export type PlanStatement =
  | { kind: 'task'; task: TaskSpec }
  | { kind: 'setRoe'; roe: Roe }
  | { kind: 'setSpeed'; speed: number }
  | { kind: 'setAltitude'; altitude: number }
  | { kind: 'setFormation'; formation: Formation }
  | { kind: 'waitUntil'; condition: Condition };

export interface Plan {
  name?: string;
  statements: PlanStatement[];
  loop?: boolean;
}

// ---------------------------------------------------------------- tactical graphics

export type GraphicKind = 'route' | 'area' | 'point' | 'phaseLine';

export interface Graphic {
  id: string;
  kind: GraphicKind;
  name: string;
  points: Vec2[];
  force: ForceId;
}

// ---------------------------------------------------------------- terrain

export interface TerrainSpec {
  seed: number;
  /** Extent in metres (square, origin at south-west corner). */
  size: number;
  cellSize: number;
  /** Geodetic location of the local origin (x=0,y=0). */
  origin: { lat: number; lon: number };
  /** Peak-to-trough relief in metres. */
  relief: number;
  /** Fraction (0..1) of the map covered by water. */
  waterFraction: number;
  /** Fraction (0..1) of land covered by forest. */
  forestFraction: number;
  towns: number;
}

export interface Town {
  name: string;
  x: number;
  y: number;
}

/** Terrain as transmitted to clients. Heights are decimetres in a base64 Int16 array. */
export interface TerrainData {
  spec: TerrainSpec;
  cols: number;
  rows: number;
  heightsB64: string;
  forestB64: string;
  roads: Vec2[][];
  towns: Town[];
}

// ---------------------------------------------------------------- scenario file

export interface EntityRecord {
  id: string;
  name: string;
  typeId: string;
  force: ForceId;
  x: number;
  y: number;
  /** Altitude above ground level for aircraft; ignored for ground/surface. */
  altitude?: number;
  heading: number;
  roe?: Roe;
  plan?: Plan;
  task?: TaskSpec;
}

export interface UnitRecord {
  id: string;
  name: string;
  force: ForceId;
  memberIds: string[];
  formation: Formation;
  spacing: number;
  echelon: UnitTemplate['echelon'];
  plan?: Plan;
  task?: TaskSpec;
}

export interface ScenarioFile {
  format: 'werforces-scenario';
  version: 1;
  name: string;
  description?: string;
  terrain: TerrainSpec;
  startTime?: number;
  /** Pairs of forces that are hostile to each other. */
  hostilities?: [ForceId, ForceId][];
  entities: EntityRecord[];
  units: UnitRecord[];
  graphics: Graphic[];
}

// ---------------------------------------------------------------- runtime snapshots

export interface EntitySnapshot {
  id: string;
  name: string;
  typeId: string;
  force: ForceId;
  domain: Domain;
  symbol: SymbolKind;
  x: number;
  y: number;
  z: number;
  /** Height above terrain. */
  agl: number;
  heading: number;
  pitch: number;
  speed: number;
  damage: DamageState;
  remote: boolean;
  unitId?: string;
  isLeader?: boolean;
  roe: Roe;
  task?: string;
  plan?: string;
  ammo: { weapon: string; rounds: number }[];
  contacts: string[];
  engagingId?: string;
}

export interface UnitSnapshot {
  id: string;
  name: string;
  force: ForceId;
  echelon: UnitTemplate['echelon'];
  formation: Formation;
  leaderId?: string;
  memberIds: string[];
  x: number;
  y: number;
  task?: string;
  plan?: string;
}

export type SimEventKind =
  | 'fire'
  | 'detonation'
  | 'damaged'
  | 'destroyed'
  | 'detected'
  | 'task'
  | 'created'
  | 'deleted'
  | 'info';

export interface SimEvent {
  seq: number;
  time: number;
  kind: SimEventKind;
  text: string;
  entityId?: string;
  targetId?: string;
  from?: Vec3;
  to?: Vec3;
  weaponId?: string;
  hit?: boolean;
}

export interface SimState {
  time: number;
  running: boolean;
  timeScale: number;
  scenarioName: string;
  entities: EntitySnapshot[];
  units: UnitSnapshot[];
  graphics: Graphic[];
  dis?: DisStatus;
}

export interface DisStatus {
  enabled: boolean;
  exerciseId: number;
  site: number;
  application: number;
  port: number;
  address: string;
  pdusSent: number;
  pdusReceived: number;
  remoteEntities: number;
}

// ---------------------------------------------------------------- remote control API

export type Command =
  | { cmd: 'run' }
  | { cmd: 'pause' }
  | { cmd: 'step'; seconds?: number }
  | { cmd: 'setTimeScale'; scale: number }
  | { cmd: 'rewind' }
  | { cmd: 'newScenario'; name?: string; terrain?: Partial<TerrainSpec> }
  | { cmd: 'loadScenario'; scenario: ScenarioFile }
  | {
      cmd: 'createEntity';
      typeId: string;
      force: ForceId;
      x: number;
      y: number;
      heading?: number;
      name?: string;
      altitude?: number;
    }
  | {
      cmd: 'createUnit';
      templateId: string;
      force: ForceId;
      x: number;
      y: number;
      heading?: number;
      name?: string;
    }
  | { cmd: 'groupUnit'; name?: string; entityIds: string[]; formation?: Formation }
  | { cmd: 'deleteObject'; id: string }
  | { cmd: 'moveEntity'; id: string; x: number; y: number; heading?: number }
  | { cmd: 'assignTask'; targetId: string; task: TaskSpec }
  | { cmd: 'assignPlan'; targetId: string; plan: Plan }
  | { cmd: 'stop'; targetId: string }
  | { cmd: 'setRoe'; targetId: string; roe: Roe }
  | { cmd: 'setFormation'; unitId: string; formation: Formation }
  | { cmd: 'rename'; id: string; name: string }
  | { cmd: 'createGraphic'; kind: GraphicKind; name?: string; points: Vec2[]; force?: ForceId }
  | { cmd: 'updateGraphic'; id: string; name?: string; points?: Vec2[] };

export interface CommandResult {
  ok: boolean;
  error?: string;
  id?: string;
}

export type ServerMessage =
  | { type: 'hello'; catalog: Catalog; scenarioName: string; terrainVersion: number }
  | { type: 'state'; state: SimState }
  | { type: 'events'; events: SimEvent[] }
  | { type: 'terrainChanged'; terrainVersion: number }
  | { type: 'result'; reqId: number; result: CommandResult };

export type ClientMessage = { type: 'command'; reqId: number; command: Command };
