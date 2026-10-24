// MIL-STD-2525C symbol identification codes (letter SIDCs) for entities and units.

import type { Domain, ForceId, SymbolKind, UnitTemplate } from './types.js';

/** Function IDs (SIDC positions 5-10) by symbol kind. */
const FUNCTION: Record<SymbolKind, string> = {
  armor: 'UCA---',
  mech: 'UCIZ--',
  infantry: 'UCI---',
  recon: 'UCR---',
  wheeled: 'UCRVM-',
  'air-defense': 'UCD---',
  artillery: 'UCF---',
  engineer: 'UCE---',
  supply: 'USS---',
  // Electronic warfare units are drawn as military intelligence.
  ew: 'UUM---',
  rotary: 'MHA---',
  'fixed-wing': 'MFF---',
  uav: 'MFQ---',
  // 2525C has no unmanned ground vehicle: drawn as ground-vehicle equipment.
  ugv: 'EV----',
  legged: 'EV----',
  ship: 'CLDD--',
  boat: 'CP----',
  generic: '------',
};

const AFFILIATION: Record<ForceId, string> = { 0: 'U', 1: 'F', 2: 'H', 3: 'N' };

/** Echelon amplifiers (SIDC positions 11-12). */
const ECHELON: Record<UnitTemplate['echelon'], string> = {
  team: '-A',
  section: '-C',
  platoon: '-D',
  company: '-E',
  flight: '-D',
  group: '-F',
};

function dimension(domain: Domain): string {
  return domain === 'air' ? 'A' : domain === 'surface' ? 'S' : 'G';
}

/**
 * A 15-character 2525C SIDC. `sidc` from the entity type, when given, supplies the
 * dimension and function ID (e.g. "S-G-UCFM--" for a mortar); affiliation and echelon
 * are filled in here.
 */
export function sidcFor(force: ForceId, domain: Domain, kind: SymbolKind, typeSidc?: string, echelon?: UnitTemplate['echelon']): string {
  const base = typeSidc && typeSidc.length >= 10 ? typeSidc : `S-${dimension(domain)}-${FUNCTION[kind] ?? '------'}`;
  const size = echelon ? ECHELON[echelon] : '--';
  return `${base[0]}${AFFILIATION[force] ?? 'U'}${base[2]}P${base.slice(4, 10)}${size}---`;
}
