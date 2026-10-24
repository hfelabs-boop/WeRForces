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
  | 'engineer'
  | 'supply'
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
  /** Guided munitions track their target (higher hit chance against movers). */
  guided?: boolean;
  /**
   * Command-guided (e.g. wire-guided SACLOS) missiles need the launcher alive, able to
   * fire and in line of sight of the target until impact, or they miss.
   */
  commandGuided?: boolean;
  /**
   * Indirect fire (artillery, mortars): fired at a location by fire missions, never by
   * direct-fire target selection, and needs no line of sight.
   */
  indirect?: boolean;
  /** Lethal radius in metres; the round damages every entity inside it (area effect). */
  blastRadius?: number;
  /** One-sigma radial aiming error in metres at maximum range (half that at short range). */
  dispersion?: number;
  /** Indirect fire that can also fire smoke rounds: cloud radius (m) and how long it lasts (s). */
  smoke?: { radius: number; duration: number };
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
  /** Thermal imager: unaffected by darkness, less affected by haze. */
  thermal?: boolean;
  /** Image intensifier (night-vision goggles): keeps much of its range at night. */
  nightVision?: boolean;
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
  /** Seats for dismounted infantry (lifeform entities) carried as passengers. */
  capacity?: number;
  /** Smoke grenade salvos, fired automatically when a guided missile is launched at it. */
  smokeGrenades?: number;
  /** Engineers: seconds to breach a lane through a minefield or obstacle. */
  breachTime?: number;
  /** How far a full tank goes (vehicles, km) or how long it lasts (aircraft, hours). Missing: no fuel model. */
  endurance?: { km?: number; hours?: number };
  /** Supply vehicles: how many full loads (fuel and ammunition) of other vehicles they carry. */
  supply?: { capacity: number };
  /** Reactions that new entities of this type start with (e.g. observers call for fire). */
  reactions?: Reactions;
}

export interface UnitTemplate {
  id: string;
  name: string;
  echelon: 'team' | 'section' | 'platoon' | 'company' | 'flight' | 'group';
  members: string[];
  formation: Formation;
  spacing: number;
  /** Subordinate unit templates (e.g. a company's platoons), placed in `formation` at `spacing` around the members (the HQ). */
  subunits?: string[];
}

export interface Catalog {
  entityTypes: EntityTypeDef[];
  weapons: WeaponDef[];
  sensors: SensorDef[];
  unitTemplates: UnitTemplate[];
}

// ---------------------------------------------------------------- tasks & plans

export type TaskSpec =
  /** `covered`: keep out of sight of known enemies' direct fire where possible (slower, safer route). */
  | { type: 'moveTo'; target: Vec2; speed?: number; covered?: boolean }
  | { type: 'followRoute'; routeId: string; speed?: number; reverse?: boolean; startIndex?: number }
  | { type: 'patrol'; routeId: string; speed?: number }
  | { type: 'wait'; duration: number }
  | { type: 'follow'; targetId: string; distance?: number }
  | { type: 'attack'; targetId: string }
  | { type: 'orbit'; center: Vec2; radius: number; duration?: number }
  | { type: 'formation'; leaderId: string }
  /**
   * Indirect fire on a location: `rounds` per tube (default 3), spread over `radius`
   * metres around the target (default 0, all rounds at the aim point).
   */
  | { type: 'fireMission'; target: Vec2; rounds?: number; radius?: number; weaponId?: string; smoke?: boolean }
  /** Engineers: go to a minefield or obstacle and breach a 30 m lane through it. */
  | { type: 'breach'; graphicId: string }
  /** Go to a friendly supply vehicle (the nearest, or the one given), halt beside it and take on fuel and ammunition. */
  | { type: 'resupply'; supplierId?: string }
  /** Support by fire: take a position and watch toward `facing` (degrees; default: the direction of the move), for `duration` s or until changed. */
  | { type: 'overwatch'; position: Vec2; facing?: number; duration?: number }
  /** Hold a position and fight from it; after a while in place, infantry dig in and vehicles go hull-down. Units deploy in a line across `facing`, `width` m wide. */
  | { type: 'defend'; position: Vec2; facing?: number; width?: number }
  /** Wait in position with weapons tight; open fire together when an enemy enters the kill zone area (or the ambush is found). */
  | { type: 'ambush'; position: Vec2; killZoneId: string; facing?: number; width?: number; sprung?: boolean }
  /** Watch from a position with return-fire ROE; fall back (to `fallback`, default 2 km to the rear) when an enemy comes within `breakContact` m (default 1500). */
  | { type: 'screen'; position: Vec2; facing?: number; width?: number; fallback?: Vec2; breakContact?: number }
  /** Sweep an area in parallel tracks spaced to the searcher's sensor range (or `spacing` m). */
  | { type: 'search'; areaId: string; spacing?: number; speed?: number; startIndex?: number }
  /** Infantry walk to a carrier (entity, or any member of a unit with free seats) and board it. */
  | { type: 'mount'; carrierId: string }
  /** A carrier stops and lets all its passengers out. */
  | { type: 'dismount' };

export type Condition =
  | { type: 'simTime'; time: number }
  | { type: 'inArea'; areaId: string }
  | { type: 'enemyDetected' }
  | { type: 'underFire' }
  | { type: 'entityDestroyed'; entityId: string }
  /** A hostile (to the plan's owner) entity is inside the area. */
  | { type: 'enemyInArea'; areaId: string }
  /** Fraction of the owner's members still alive is below `fraction` (0..1). */
  | { type: 'strengthBelow'; fraction: number }
  /** Average fuel of the owner's vehicles is below `fraction`. */
  | { type: 'fuelBelow'; fraction: number }
  /** Average ammunition (fraction of full loads) of the owner's members is below `fraction`. */
  | { type: 'ammoBelow'; fraction: number };

/** Automatic behaviours that run alongside tasks and plans. */
export interface Reactions {
  /** 'halt': stop moving while a hostile is detected within weapon range, then carry on. */
  onContact?: 'continue' | 'halt';
  /** Abandon the plan and fall back when strength drops below this fraction (units), or on a firepower kill (entities). */
  withdrawBelow?: number;
  /** Where to fall back to (default: where the reaction was set). */
  withdrawTo?: Vec2;
  /** Request fire missions from friendly artillery on hostiles this entity can see. */
  callForFire?: boolean;
}

export type PlanStatement =
  | { kind: 'task'; task: TaskSpec }
  | { kind: 'setRoe'; roe: Roe }
  | { kind: 'setSpeed'; speed: number }
  | { kind: 'setAltitude'; altitude: number }
  | { kind: 'setFormation'; formation: Formation }
  | { kind: 'waitUntil'; condition: Condition }
  | { kind: 'setReactions'; reactions: Reactions };

export interface Plan {
  name?: string;
  statements: PlanStatement[];
  loop?: boolean;
}

// ---------------------------------------------------------------- tactical graphics

export type GraphicKind = 'route' | 'area' | 'point' | 'phaseLine' | 'minefield' | 'obstacle';

export interface Graphic {
  id: string;
  kind: GraphicKind;
  name: string;
  points: Vec2[];
  force: ForceId;
  /** Minefields: mines per metre of front, roughly (0.1 sparse .. 1.5 dense; default 0.5). */
  density?: number;
  /** Minefields and obstacles: breached lanes (a centreline; lanes are 30 m wide). */
  lanes?: { from: Vec2; to: Vec2 }[];
  /** Minefields: forces that know where it is (its own force always does). */
  knownBy?: ForceId[];
}

/** A smoke cloud: blocks sight (not radar) until it disperses. */
export interface SmokeCloud {
  id: number;
  x: number;
  y: number;
  radius: number;
  /** Simulation time it is gone. */
  until: number;
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
  /**
   * Name of an imported real-world terrain dataset (terrains/<name>.json). When set, the
   * terrain is loaded from it and the generation parameters above are ignored.
   */
  dataset?: string;
}

/** A real-world terrain imported from a DEM and map features (`npm run terrain:import`). */
export interface TerrainDataset extends TerrainData {
  format: 'werforces-terrain';
  version: 1;
  name: string;
  title?: string;
  /** Where the data came from, for attribution. */
  source?: { dem?: string; features?: string; landCover?: string; imported?: string; attribution?: string };
}

export interface Town {
  name: string;
  x: number;
  y: number;
}

/** Terrain as transmitted to clients. Heights are a base64 Int16 array in units of `heightScale` metres. */
export interface TerrainData {
  spec: TerrainSpec;
  cols: number;
  rows: number;
  heightsB64: string;
  /** Metres per height unit (default 0.1: decimetres). Coarser for terrain above 3 km. */
  heightScale?: number;
  forestB64: string;
  /** 1 = inland water (lakes, rivers) per post; sea is wherever elevation is below 0. */
  waterB64?: string;
  /** Land cover class per post (see LAND_COVER), e.g. from ESA WorldCover. */
  landCoverB64?: string;
  /** Building footprints, e.g. from OpenStreetMap. */
  buildings?: Building[];
  roads: Vec2[][];
  towns: Town[];
}

/** A building: footprint as local x,y pairs in metres (x0, y0, x1, y1, ...) and height in metres. */
export interface Building {
  pts: number[];
  h: number;
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
  reactions?: Reactions;
  /** Runtime state, present in checkpoints (scenarios saved mid-run). */
  state?: EntityState;
}

/** Everything needed to resume an entity exactly where a checkpoint left it. */
export interface EntityState {
  destroyed?: boolean;
  mobilityKill?: boolean;
  firepowerKill?: boolean;
  speed?: number;
  /** Altitude MSL (aircraft). */
  z?: number;
  ammo?: Record<string, number>;
  /** Weapon id -> simulation time it is ready to fire again. */
  weaponReadyAt?: Record<string, number>;
  contacts?: { id: string; firstSeen: number; lastSeen: number; x: number; y: number; z: number }[];
  /** Shooter id -> last time it fired at this entity. */
  attackers?: Record<string, number>;
  underFireUntil?: number;
  lastFiredAt?: number;
  sensorDue?: number;
  speedOverride?: number;
  altitudeOverride?: number;
  /** Index of the plan statement being executed. */
  planIndex?: number;
  /** The running task, as a spec that resumes it (e.g. a route from its current waypoint). */
  taskState?: TaskSpec;
  withdrawn?: boolean;
  /** Id of the carrier this entity is riding in. */
  embarkedIn?: string;
  /** The assigned task already finished (do not restart it on load). */
  taskDone?: boolean;
  /** Simulation time this observer may call for fire again. */
  callForFireAt?: number;
  /** Smoke grenade salvos left. */
  smokeLeft?: number;
  suppression?: number;
  morale?: number;
  moraleState?: MoraleState;
  fuel?: number;
  /** Supply vehicles: loads left. */
  supplies?: number;
  prepared?: 'dugIn' | 'hullDown';
}

export interface UnitRecord {
  id: string;
  name: string;
  force: ForceId;
  memberIds: string[];
  formation: Formation;
  spacing: number;
  echelon: UnitTemplate['echelon'];
  /** Superior unit in the chain of command. */
  parentId?: string;
  plan?: Plan;
  task?: TaskSpec;
  reactions?: Reactions;
  /** Runtime state, present in checkpoints. */
  state?: { planIndex?: number; taskState?: TaskSpec; leaderId?: string; withdrawn?: boolean; taskDone?: boolean; morale?: number; moraleState?: MoraleState; lossesSeen?: number };
}

/** A munition in flight, saved in checkpoints. */
export interface ShotRecord {
  eventNumber: number;
  shooterId: string;
  targetId?: string;
  weaponId: string;
  from: Vec3;
  to: Vec3;
  fireTime: number;
  impactTime: number;
  range: number;
  /** A smoke round. */
  smoke?: boolean;
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
  /** Checkpoint only: munitions in flight and the random number generator state. */
  shots?: ShotRecord[];
  /** Checkpoint only: smoke clouds still hanging about. */
  smoke?: SmokeCloud[];
  rngState?: number;
  /** Which optional models are on (all default to on). */
  rules?: SimulationRules;
  /** Time of day and weather at the start. */
  environment?: Environment;
  /** Checkpoint only: orders still on their way. */
  orders?: PendingOrder[];
}

/** Optional parts of the model, for comparison runs. Missing fields mean on. */
export interface SimulationRules {
  /** Incoming fire suppresses: less accurate, slower to fire and spot; infantry get pinned. */
  suppression?: boolean;
  /** Units lose cohesion with losses and suppression, and can break and fall back. */
  morale?: boolean;
  /** Vehicles and aircraft burn fuel; out of fuel, vehicles stop and aircraft come down. */
  fuel?: boolean;
  /** Orders take time to pass down the chain of command (by echelon). Off by default. */
  orderDelay?: boolean;
}

/** An order on its way to an entity or unit (rules.orderDelay). */
export interface PendingOrder {
  targetId: string;
  task?: TaskSpec;
  plan?: Plan;
  /** Simulation time it arrives and is acted on. */
  due: number;
}

export type MoraleState = 'steady' | 'shaken' | 'broken';

export type Precipitation = 'none' | 'rain' | 'heavyRain' | 'snow';

/** Time of day and weather. Missing fields keep their defaults (midsummer noon, clear, calm). */
export interface Environment {
  /** Date at the scenario's start, YYYY-MM-DD. */
  date?: string;
  /** Local solar time at the scenario's start, in hours (0-24). */
  time?: number;
  /** Meteorological visibility in metres (fog: a few hundred; clear: 20 km or more). */
  visibility?: number;
  precipitation?: Precipitation;
  /** Wind speed in m/s; drifts smoke. */
  windSpeed?: number;
  /** Direction the wind blows from, degrees clockwise from north. */
  windFrom?: number;
}

/** The environment now: settings plus the current clock and light. */
export interface EnvironmentState extends Required<Environment> {
  localDate: string;
  /** HH:MM local solar time. */
  localTime: string;
  /** Degrees above the horizon (negative: below). */
  sunAltitude: number;
  /** Fraction of daylight range left to the naked eye (1 by day, under 0.1 at night). */
  light: number;
  period: 'day' | 'twilight' | 'night';
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
  reactions?: Reactions;
  /** Halted by its on-contact reaction. */
  halted?: boolean;
  withdrawn?: boolean;
  /** Carrier it is riding in (embarked entities are not on the map). */
  embarkedIn?: string;
  /** Ids of entities riding in this carrier. */
  passengers?: string[];
  /** Fog of war: this is another force's entity known only as a sensor contact, last seen this many seconds ago. */
  contactAge?: number;
  /** 0..1: how hard incoming fire is pressing it. */
  suppression?: number;
  /** Infantry pinned down by fire: not moving. */
  pinned?: boolean;
  /** Morale of an entity that is not in a unit. */
  morale?: number;
  moraleState?: MoraleState;
  /** 0..1 fuel left (types with a fuel model). */
  fuel?: number;
  /** Supply vehicles: full loads of fuel and ammunition left to hand out. */
  supplies?: number;
  /** In a prepared position: infantry dug in, or a vehicle hull-down (harder to see and hit). */
  prepared?: 'dugIn' | 'hullDown';
}

export interface UnitSnapshot {
  id: string;
  name: string;
  force: ForceId;
  echelon: UnitTemplate['echelon'];
  formation: Formation;
  /** Superior unit, and subordinate units, in the chain of command. */
  parentId?: string;
  childIds?: string[];
  leaderId?: string;
  memberIds: string[];
  x: number;
  y: number;
  task?: string;
  plan?: string;
  reactions?: Reactions;
  withdrawn?: boolean;
  /** 0..1 cohesion; see moraleState. */
  morale?: number;
  moraleState?: MoraleState;
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
  | 'info'
  /** A radio message: orders acknowledged, contact reports, calls for fire (sent on DIS as Signal PDUs). */
  | 'radio';

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
  /** Indirect fire: the round flies out of sight, so viewers show a muzzle flash, not a tracer. */
  indirect?: boolean;
  /** Blast radius of an area-effect detonation (m). */
  radius?: number;
}

export interface SimState {
  time: number;
  running: boolean;
  timeScale: number;
  scenarioName: string;
  entities: EntitySnapshot[];
  units: UnitSnapshot[];
  graphics: Graphic[];
  /** Smoke clouds on the battlefield. */
  smoke?: SmokeCloud[];
  environment?: EnvironmentState;
  /** Orders on their way down the chain of command. */
  orders?: { targetId: string; text: string; due: number }[];
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
  /** Local radios on the network (unit leaders and entities not in units). */
  radios?: number;
  /** Other simulations' radios heard. */
  remoteRadios?: number;
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
  | { cmd: 'setReactions'; targetId: string; reactions: Reactions }
  /** Put infantry (entity or unit) into a carrier (entity or unit) instantly, e.g. when setting up a scenario. */
  | { cmd: 'embark'; passengerId: string; carrierId: string }
  /** Let a carrier's passengers out now. */
  | { cmd: 'disembark'; carrierId: string }
  /** Turn optional model parts (suppression, morale, …) on or off. */
  | { cmd: 'setRules'; rules: SimulationRules }
  | { cmd: 'setEnvironment'; environment: Environment }
  /** Put a unit under a superior unit (null: make it independent). */
  | { cmd: 'setSuperior'; unitId: string; superiorId: string | null }
  | { cmd: 'setFormation'; unitId: string; formation: Formation }
  | { cmd: 'rename'; id: string; name: string }
  | { cmd: 'createGraphic'; kind: GraphicKind; name?: string; points: Vec2[]; force?: ForceId; density?: number }
  | { cmd: 'updateGraphic'; id: string; name?: string; points?: Vec2[]; density?: number };

export interface CommandResult {
  ok: boolean;
  error?: string;
  id?: string;
}

/**
 * Who a client is. The controller (exercise control) sees and commands everything; a
 * player sees its own force plus what its force has detected, and commands only its force.
 */
export type Role = { kind: 'controller' } | { kind: 'player'; force: ForceId };

export type ServerMessage =
  | { type: 'hello'; catalog: Catalog; scenarioName: string; terrainVersion: number; role: Role }
  | { type: 'state'; state: SimState }
  | { type: 'events'; events: SimEvent[] }
  | { type: 'terrainChanged'; terrainVersion: number }
  | { type: 'result'; reqId: number; result: CommandResult };

export type ClientMessage = { type: 'command'; reqId: number; command: Command };
