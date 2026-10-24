// Land cover for terrain import: ESA WorldCover 10 m classes, from a local GeoTIFF or
// fetched straight from the public cloud-optimised tiles (only the window needed is read).

import { fromArrayBuffer, fromUrl, type GeoTIFF } from 'geotiff';
import { LAND_COVER } from '../shared/terrainGrid.js';

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Returns the WorldCover class code at a WGS-84 position, or null outside the data. */
export type LandCoverSampler = (lon: number, lat: number) => number | null;

/** ESA WorldCover class codes to WeRForces land cover classes. */
export const WORLDCOVER_CLASSES: Record<number, number> = {
  10: LAND_COVER.forest, // tree cover
  20: LAND_COVER.shrub, // shrubland
  30: LAND_COVER.open, // grassland
  40: LAND_COVER.open, // cropland
  50: LAND_COVER.builtUp, // built-up
  60: LAND_COVER.bare, // bare / sparse vegetation
  70: LAND_COVER.snow, // snow and ice
  80: LAND_COVER.water, // permanent water bodies
  90: LAND_COVER.wetland, // herbaceous wetland
  95: LAND_COVER.wetland, // mangroves
  100: LAND_COVER.open, // moss and lichen
};

export const WORLDCOVER_ATTRIBUTION = '© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium (CC BY 4.0)';

/** The public WorldCover 2021 (v200) tile URL covering a 3x3 degree cell. */
export function worldCoverTileUrl(lat: number, lon: number): string {
  const la = Math.floor(lat / 3) * 3;
  const lo = Math.floor(lon / 3) * 3;
  const ns = `${la >= 0 ? 'N' : 'S'}${String(Math.abs(la)).padStart(2, '0')}`;
  const ew = `${lo >= 0 ? 'E' : 'W'}${String(Math.abs(lo)).padStart(3, '0')}`;
  return `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_${ns}${ew}_Map.tif`;
}

/** Read the part of a geographic (EPSG:4326) class raster that covers a bounding box. */
async function windowSampler(tiff: GeoTIFF, bbox: BBox): Promise<LandCoverSampler | null> {
  const image = await tiff.getImage();
  const keys = image.getGeoKeys() as Record<string, number | undefined>;
  if (keys.ProjectedCSTypeGeoKey && keys.ProjectedCSTypeGeoKey !== 32767) throw new Error('land cover rasters must be in geographic coordinates (EPSG:4326), like ESA WorldCover');
  const [originX, originY] = image.getOrigin();
  const [resX, resY] = image.getResolution();
  const width = image.getWidth();
  const height = image.getHeight();
  const px = (lon: number) => (lon - originX) / resX;
  const py = (lat: number) => (lat - originY) / resY;
  const x0 = Math.max(0, Math.floor(Math.min(px(bbox.west), px(bbox.east))) - 2);
  const x1 = Math.min(width, Math.ceil(Math.max(px(bbox.west), px(bbox.east))) + 2);
  const y0 = Math.max(0, Math.floor(Math.min(py(bbox.north), py(bbox.south))) - 2);
  const y1 = Math.min(height, Math.ceil(Math.max(py(bbox.north), py(bbox.south))) + 2);
  if (x1 <= x0 || y1 <= y0) return null;
  const data = (await image.readRasters({ window: [x0, y0, x1, y1], samples: [0] }))[0] as ArrayLike<number>;
  const w = x1 - x0;
  const h = y1 - y0;
  return (lon, lat) => {
    const c = Math.floor(px(lon)) - x0;
    const r = Math.floor(py(lat)) - y0;
    if (c < 0 || r < 0 || c >= w || r >= h) return null;
    const v = data[r * w + c];
    return v > 0 ? v : null;
  };
}

/** A land cover sampler over a local GeoTIFF of WorldCover-style class codes. */
export async function landCoverFromFile(buf: ArrayBuffer, bbox: BBox): Promise<LandCoverSampler> {
  const s = await windowSampler(await fromArrayBuffer(buf), bbox);
  if (!s) throw new Error('the land cover raster does not cover the terrain extent');
  return s;
}

/** A land cover sampler that reads the needed windows of the public ESA WorldCover tiles. */
export async function landCoverFromWorldCover(bbox: BBox): Promise<LandCoverSampler> {
  const urls = new Set<string>();
  for (const lat of [bbox.south, bbox.north]) for (const lon of [bbox.west, bbox.east]) urls.add(worldCoverTileUrl(lat, lon));
  const samplers: LandCoverSampler[] = [];
  for (const url of urls) {
    try {
      const s = await windowSampler(await fromUrl(url), bbox);
      if (s) samplers.push(s);
    } catch (err) {
      // Tiles over open sea do not exist.
      if (!/404|403/.test(String((err as Error).message))) throw err;
    }
  }
  if (!samplers.length) throw new Error('no ESA WorldCover data for this area');
  return (lon, lat) => {
    for (const s of samplers) {
      const v = s(lon, lat);
      if (v !== null) return v;
    }
    return null;
  };
}

/** The most common class among a few samples around each post (WorldCover pixels are 10 m). */
export function majorityClass(sample: LandCoverSampler, points: [number, number][]): number | null {
  const counts = new Map<number, number>();
  for (const [lon, lat] of points) {
    const v = sample(lon, lat);
    if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: number | null = null;
  let n = 0;
  for (const [v, k] of counts) {
    if (k > n) {
      best = v;
      n = k;
    }
  }
  return best;
}
