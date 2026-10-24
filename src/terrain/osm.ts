// OpenStreetMap input for terrain import: OSM XML files (as exported from openstreetmap.org
// or JOSM) and Overpass API queries, converted to GeoJSON features the importer understands.

import type { GeoJsonCollection } from './import.js';

type Feature = GeoJsonCollection['features'][number];

/** Tags that make a closed way an area rather than a line. */
const AREA_KEYS = ['building', 'landuse', 'natural', 'leisure', 'amenity', 'water'];

function isArea(tags: Record<string, string>, closed: boolean): boolean {
  if (!closed) return false;
  if (tags.area === 'yes') return true;
  if (tags.area === 'no' || tags.highway) return false;
  if (tags.waterway === 'riverbank') return true;
  return AREA_KEYS.some((k) => tags[k] !== undefined);
}

function decodeEntities(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'amp') return '&';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    return String.fromCodePoint(k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  });
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]] = decodeEntities(m[3] ?? m[4] ?? '');
  return out;
}

/**
 * Convert OSM XML to GeoJSON features: ways become lines or (closed, with an area tag)
 * polygons; multipolygon relations become polygons from their outer and inner ways;
 * tagged nodes become points.
 */
export function osmXmlToGeoJson(xml: string): GeoJsonCollection {
  const nodes = new Map<string, [number, number]>();
  const ways = new Map<string, { refs: string[]; tags: Record<string, string> }>();
  const features: Feature[] = [];
  // Elements are either self-closing (<node .../>) or have children up to their closing tag.
  const re = /<(node|way|relation)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
  const relations: { members: { type: string; ref: string; role: string }[]; tags: Record<string, string> }[] = [];
  for (const m of xml.matchAll(re)) {
    const kind = m[1];
    const a = attrs(m[2]);
    const body = m[4] ?? '';
    const tags: Record<string, string> = {};
    for (const t of body.matchAll(/<tag\b([^>]*)\/?>/g)) {
      const ta = attrs(t[1]);
      if (ta.k !== undefined) tags[ta.k] = ta.v ?? '';
    }
    if (kind === 'node') {
      const lon = Number(a.lon);
      const lat = Number(a.lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      nodes.set(a.id, [lon, lat]);
      if (Object.keys(tags).length) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: tags });
    } else if (kind === 'way') {
      const refs = [...body.matchAll(/<nd\b([^>]*)\/?>/g)].map((n) => attrs(n[1]).ref).filter(Boolean);
      ways.set(a.id, { refs, tags });
    } else {
      const members = [...body.matchAll(/<member\b([^>]*)\/?>/g)].map((n) => {
        const ma = attrs(n[1]);
        return { type: ma.type, ref: ma.ref, role: ma.role ?? '' };
      });
      relations.push({ members, tags });
    }
  }
  const coords = (refs: string[]) => refs.map((r) => nodes.get(r)).filter((c): c is [number, number] => !!c);
  for (const w of ways.values()) {
    if (!Object.keys(w.tags).length) continue;
    const line = coords(w.refs);
    if (line.length < 2) continue;
    const closed = w.refs.length > 3 && w.refs[0] === w.refs[w.refs.length - 1];
    features.push({
      type: 'Feature',
      geometry: isArea(w.tags, closed) ? { type: 'Polygon', coordinates: [line] } : { type: 'LineString', coordinates: line },
      properties: w.tags,
    });
  }
  for (const r of relations) {
    if (r.tags.type !== 'multipolygon') continue;
    const rings = (role: string) =>
      joinRings(r.members.filter((m) => m.type === 'way' && (m.role === role || (role === 'outer' && m.role === ''))).map((m) => coords(ways.get(m.ref)?.refs ?? [])));
    const outer = rings('outer');
    const inner = rings('inner');
    if (!outer.length) continue;
    features.push({ type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: outer.map((o) => [o, ...inner]) }, properties: r.tags });
  }
  return { type: 'FeatureCollection', features };
}

/** Join way segments end to end into closed rings. */
function joinRings(parts: [number, number][][]): [number, number][][] {
  const left = parts.filter((p) => p.length >= 2).map((p) => [...p]);
  const rings: [number, number][][] = [];
  const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];
  while (left.length) {
    const ring = left.shift()!;
    let grew = true;
    while (!same(ring[0], ring[ring.length - 1]) && grew) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const p = left[i];
        const end = ring[ring.length - 1];
        if (same(p[0], end)) ring.push(...p.slice(1));
        else if (same(p[p.length - 1], end)) ring.push(...p.slice(0, -1).reverse());
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

/** Overpass QL for everything the importer uses inside a bounding box. */
export function overpassQuery(bbox: { south: number; west: number; north: number; east: number }): string {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `[out:json][timeout:180];
(
  way["building"](${b});
  relation["building"]["type"="multipolygon"](${b});
  way["highway"](${b});
  way["natural"~"^(wood|water)$"](${b});
  relation["natural"~"^(wood|water)$"]["type"="multipolygon"](${b});
  way["landuse"~"^(forest|reservoir|basin)$"](${b});
  relation["landuse"="forest"]["type"="multipolygon"](${b});
  way["waterway"~"^(river|canal|riverbank)$"](${b});
  node["place"~"^(city|town|village|hamlet)$"](${b});
);
out geom;`;
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
}

/** Convert an Overpass JSON response ("out geom") to GeoJSON features. */
export function overpassToGeoJson(json: { elements?: OverpassElement[] }): GeoJsonCollection {
  const features: Feature[] = [];
  for (const el of json.elements ?? []) {
    const tags = el.tags ?? {};
    if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [el.lon, el.lat] }, properties: tags });
    } else if (el.type === 'way' && el.geometry && el.geometry.length >= 2) {
      const line = el.geometry.map((g) => [g.lon, g.lat] as [number, number]);
      const closed = line.length > 3 && line[0][0] === line[line.length - 1][0] && line[0][1] === line[line.length - 1][1];
      features.push({ type: 'Feature', geometry: isArea(tags, closed) ? { type: 'Polygon', coordinates: [line] } : { type: 'LineString', coordinates: line }, properties: tags });
    } else if (el.type === 'relation' && el.members) {
      const part = (role: string) => el.members!.filter((m) => m.type === 'way' && m.geometry && (m.role === role || (role === 'outer' && m.role === ''))).map((m) => m.geometry!.map((g) => [g.lon, g.lat] as [number, number]));
      const outer = joinRings(part('outer'));
      const inner = joinRings(part('inner'));
      if (outer.length) features.push({ type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: outer.map((o) => [o, ...inner]) }, properties: tags });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** Fetch map features for a bounding box from an Overpass API server. */
export async function fetchOverpass(bbox: { south: number; west: number; north: number; east: number }, url = 'https://overpass-api.de/api/interpreter'): Promise<GeoJsonCollection> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(overpassQuery(bbox))}` });
  if (!res.ok) throw new Error(`Overpass request failed: HTTP ${res.status}`);
  return overpassToGeoJson((await res.json()) as { elements?: OverpassElement[] });
}
