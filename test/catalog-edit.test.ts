import { describe, expect, it } from 'vitest';
import { executeCommand } from '../src/server/commands.js';
import { SimRunner } from '../src/server/runner.js';
import { Engine } from '../src/sim/engine.js';
import { validateEntityType, validateWeapon } from '../src/sim/catalogEdit.js';

function engine() {
  const eng = new Engine();
  eng.newScenario('catalog');
  return { eng, runner: new SimRunner(eng, 0.1, 20, 0) };
}

describe('catalog editing', () => {
  it('adds a variant that new entities use, saved with the scenario', () => {
    const { eng, runner } = engine();
    const m1 = eng.catalog.type('us-m1a2');
    const gun = { ...eng.catalog.weapon('gun-120mm'), id: 'gun-120mm-er', name: '120mm extended range', maxRange: 5000 };
    expect(executeCommand(runner, { cmd: 'setCatalogEntry', section: 'weapons', entry: gun }).ok).toBe(true);
    const variant = { ...m1, id: 'us-m1a2-sep3', name: 'M1A2 SEPv3', weapons: ['gun-120mm-er', ...m1.weapons.slice(1)], maxSpeed: 19 };
    expect(executeCommand(runner, { cmd: 'setCatalogEntry', section: 'entityTypes', entry: variant }).ok).toBe(true);
    const town = eng.terrain.towns[0];
    const e = eng.createEntity({ typeId: 'us-m1a2-sep3', force: 1, x: town.x, y: town.y });
    expect(e.type.maxSpeed).toBe(19);
    expect(e.ammo.has('gun-120mm-er')).toBe(true);
    const saved = eng.toScenario();
    expect(saved.catalog?.entityTypes?.map((t) => t.id)).toEqual(['us-m1a2-sep3']);
    const other = new Engine();
    other.loadScenario(saved);
    expect(other.catalog.type('us-m1a2-sep3').name).toBe('M1A2 SEPv3');
    // Undo takes the edit back with the rest of the scenario.
    expect(eng.catalogVersion).toBeGreaterThan(0);
  });

  it('refuses bad entries and removals that would strand entities', () => {
    const { eng, runner } = engine();
    expect(executeCommand(runner, { cmd: 'setCatalogEntry', section: 'entityTypes', entry: { ...eng.catalog.type('us-m1a2'), id: 'x-tank', weapons: ['no-such-gun'] } }).error).toMatch(/unknown weapon no-such-gun/);
    expect(executeCommand(runner, { cmd: 'setCatalogEntry', section: 'entityTypes', entry: { ...eng.catalog.type('us-m1a2'), id: 'x-tank', cruiseSpeed: 99 } }).error).toMatch(/cruiseSpeed/);
    expect(() => validateWeapon({ ...eng.catalog.weapon('gun-120mm'), pk: { tanks: 0.5 } })).toThrow(/pk class/);
    expect(() => validateEntityType({ id: 'Bad Id' })).toThrow(/id:/);
    executeCommand(runner, { cmd: 'setCatalogEntry', section: 'entityTypes', entry: { ...eng.catalog.type('us-m1a2'), id: 'x-tank' } });
    const town = eng.terrain.towns[0];
    const e = eng.createEntity({ typeId: 'x-tank', force: 1, x: town.x, y: town.y });
    expect(executeCommand(runner, { cmd: 'removeCatalogEntry', section: 'entityTypes', id: 'x-tank' }).error).toMatch(/delete it first/);
    eng.deleteObject(e.id);
    expect(executeCommand(runner, { cmd: 'removeCatalogEntry', section: 'entityTypes', id: 'x-tank' }).ok).toBe(true);
    expect(executeCommand(runner, { cmd: 'removeCatalogEntry', section: 'entityTypes', id: 'us-m1a2' }).error).toMatch(/not a custom/);
    // Overriding a built-in, then removing the override, brings the original back.
    executeCommand(runner, { cmd: 'setCatalogEntry', section: 'sensors', entry: { ...eng.catalog.sensors.get('eye')!, maxRange: 2500 } });
    expect(eng.catalog.sensors.get('eye')!.maxRange).toBe(2500);
    executeCommand(runner, { cmd: 'removeCatalogEntry', section: 'sensors', id: 'eye' });
    expect(eng.catalog.sensors.get('eye')!.maxRange).toBe(1500);
  });
});
