// GIS exports: GeoJSON feature collections and KML documents (plus a live-refreshing
// KML NetworkLink for Google Earth) of entities and tactical graphics.

import { LocalFrame } from '../dis/geodesy.js';
import { FORCE_NAMES, type EntitySnapshot, type Graphic, type SimState, type TerrainSpec, type Vec3 } from '../shared/types.js';
import { cotType, xmlEscape } from './cot.js';

export function frameFor(spec: TerrainSpec): LocalFrame {
  return new LocalFrame(spec.origin.lat, spec.origin.lon);
}

/** [lon, lat, alt] in degrees/metres. */
export function toLonLat(frame: LocalFrame, p: { x: number; y: number; z?: number }): [number, number, number] {
  const g = frame.toGeodetic({ x: p.x, y: p.y, z: p.z ?? 0 });
  return [round((g.lon * 180) / Math.PI, 7), round((g.lat * 180) / Math.PI, 7), round(p.z ?? 0, 1)];
}

function round(v: number, d: number): number {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

const deg = (r: number) => round((((r * 180) / Math.PI) % 360 + 360) % 360, 1);

export function entityProperties(e: EntitySnapshot) {
  return {
    id: e.id,
    name: e.name,
    type: e.typeId,
    force: e.force,
    forceName: FORCE_NAMES[e.force],
    domain: e.domain,
    symbol: e.symbol,
    cotType: cotType(e),
    damage: e.damage,
    heading: deg(e.heading),
    speed: round(e.speed, 1),
    altitudeAgl: round(e.agl, 1),
    unitId: e.unitId ?? null,
    task: e.task ?? null,
    plan: e.plan ?? null,
    roe: e.roe,
    remote: e.remote,
  };
}

export function entitiesGeoJSON(state: SimState, spec: TerrainSpec) {
  const frame = frameFor(spec);
  return {
    type: 'FeatureCollection' as const,
    properties: { scenario: state.scenarioName, simTime: state.time },
    features: state.entities.map((e) => ({
      type: 'Feature' as const,
      id: e.id,
      geometry: { type: 'Point' as const, coordinates: toLonLat(frame, e) },
      properties: entityProperties(e),
    })),
  };
}

function graphicGeometry(g: Graphic, frame: LocalFrame) {
  const pts = g.points.map((p) => toLonLat(frame, p).slice(0, 2) as [number, number]);
  if (g.kind === 'point') return { type: 'Point' as const, coordinates: pts[0] };
  if (g.kind === 'area') return { type: 'Polygon' as const, coordinates: [[...pts, pts[0]]] };
  return { type: 'LineString' as const, coordinates: pts };
}

export function graphicsGeoJSON(state: SimState, spec: TerrainSpec) {
  const frame = frameFor(spec);
  return {
    type: 'FeatureCollection' as const,
    properties: { scenario: state.scenarioName },
    features: state.graphics.map((g) => ({
      type: 'Feature' as const,
      id: g.id,
      geometry: graphicGeometry(g, frame),
      properties: { id: g.id, name: g.name, kind: g.kind, force: g.force, forceName: FORCE_NAMES[g.force] },
    })),
  };
}

// KML colours are aabbggrr.
const KML_COLORS: Record<number, string> = { 0: 'ff00ffff', 1: 'ffffc040', 2: 'ff4040ff', 3: 'ff40ff40' };
const ICON = 'http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png';
const AIR_ICON = 'http://maps.google.com/mapfiles/kml/shapes/airports.png';
const DEAD_ICON = 'http://maps.google.com/mapfiles/kml/shapes/forbidden.png';

function coord(c: [number, number, number] | [number, number]): string {
  return c.join(',');
}

function entityPlacemark(e: EntitySnapshot, frame: LocalFrame): string {
  const c = toLonLat(frame, e as Vec3);
  const style = e.damage === 'destroyed' ? 'dead' : `force${e.force}${e.domain === 'air' ? 'air' : ''}`;
  const desc = [
    `Type: ${e.typeId}`,
    `Damage: ${e.damage}`,
    `Heading: ${deg(e.heading)}°  Speed: ${Math.round(e.speed * 3.6)} km/h`,
    e.task ? `Task: ${e.task}` : '',
    e.plan ? `Plan: ${e.plan}` : '',
  ]
    .filter(Boolean)
    .join('<br/>');
  return (
    `<Placemark id="${xmlEscape(e.id)}"><name>${xmlEscape(e.name)}</name>` +
    `<description><![CDATA[${desc}]]></description><styleUrl>#${style}</styleUrl>` +
    `<Style><IconStyle><heading>${deg(e.heading)}</heading></IconStyle></Style>` +
    `<Point><altitudeMode>${e.domain === 'air' ? 'absolute' : 'clampToGround'}</altitudeMode><coordinates>${coord(c)}</coordinates></Point></Placemark>`
  );
}

function graphicPlacemark(g: Graphic, frame: LocalFrame): string {
  const pts = g.points.map((p) => coord(toLonLat(frame, p).slice(0, 2) as [number, number]));
  let geom: string;
  if (g.kind === 'point') geom = `<Point><coordinates>${pts[0]}</coordinates></Point>`;
  else if (g.kind === 'area') geom = `<Polygon><outerBoundaryIs><LinearRing><tessellate>1</tessellate><coordinates>${[...pts, pts[0]].join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
  else geom = `<LineString><tessellate>1</tessellate><coordinates>${pts.join(' ')}</coordinates></LineString>`;
  return `<Placemark id="${xmlEscape(g.id)}"><name>${xmlEscape(g.name)}</name><styleUrl>#graphic${g.force}</styleUrl>${geom}</Placemark>`;
}

export function sceneKML(state: SimState, spec: TerrainSpec): string {
  const frame = frameFor(spec);
  const styles = [0, 1, 2, 3]
    .map((f) => {
      const col = KML_COLORS[f];
      return (
        `<Style id="force${f}"><IconStyle><color>${col}</color><scale>1.0</scale><Icon><href>${ICON}</href></Icon></IconStyle><LabelStyle><scale>0.8</scale></LabelStyle></Style>` +
        `<Style id="force${f}air"><IconStyle><color>${col}</color><scale>1.1</scale><Icon><href>${AIR_ICON}</href></Icon></IconStyle><LabelStyle><scale>0.8</scale></LabelStyle></Style>` +
        `<Style id="graphic${f}"><LineStyle><color>${col}</color><width>3</width></LineStyle><PolyStyle><color>40${col.slice(2)}</color></PolyStyle></Style>`
      );
    })
    .join('');
  const dead = `<Style id="dead"><IconStyle><color>ff404040</color><Icon><href>${DEAD_ICON}</href></Icon></IconStyle><LabelStyle><scale>0.7</scale></LabelStyle></Style>`;
  const folders = ([1, 2, 3, 0] as const)
    .map((f) => {
      const list = state.entities.filter((e) => e.force === f);
      if (!list.length) return '';
      return `<Folder><name>${FORCE_NAMES[f]} force</name>${list.map((e) => entityPlacemark(e, frame)).join('')}</Folder>`;
    })
    .join('');
  const graphics = state.graphics.length ? `<Folder><name>Tactical graphics</name>${state.graphics.map((g) => graphicPlacemark(g, frame)).join('')}</Folder>` : '';
  return (
    `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
    `<name>${xmlEscape(state.scenarioName)} (t=${Math.round(state.time)}s)</name>${styles}${dead}${folders}${graphics}</Document></kml>`
  );
}

/** KML NetworkLink that makes Google Earth re-fetch the scene every `refresh` seconds. */
export function liveKML(sceneUrl: string, refresh = 5): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><NetworkLink>` +
    `<name>WeRForces live</name><flyToView>0</flyToView><Link><href>${xmlEscape(sceneUrl)}</href>` +
    `<refreshMode>onInterval</refreshMode><refreshInterval>${refresh}</refreshInterval></Link></NetworkLink></kml>`
  );
}
