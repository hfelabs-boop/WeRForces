# Tutorial 9: Extending the catalog

**Time:** 15 minutes · **You will learn:** adding entity types, weapons, sensors
and unit templates, either as a data file for the server or in code.

The *catalog* is WeRForces' simulation object model: every type of vehicle,
person, aircraft and ship, with its performance, sensors and weapons. The
defaults are listed in the [catalog reference](../reference/catalog.md). This
tutorial adds a German **Leopard 2A6**, its gun, and a four-tank platoon.

## 1. The pieces

| Object | Key fields |
| --- | --- |
| **Weapon** | `id`, `name`, DIS `munition` type, `minRange`/`maxRange` (m), `reloadTime` (s), `ammo` (rounds or bursts), `projectileSpeed` (m/s), `pk` per armour class, which domains it `targets`; optional `guided`, `commandGuided` (wire guided: misses if the launcher dies or loses sight), and for artillery `indirect`, `blastRadius` and `dispersion` (m) |
| **Sensor** | `id`, `name`, `maxRange` (m), `fov` (**radians**; 2π = all-round), `detects` (domains), optional `radar` (ignores concealment for air targets) |
| **Entity type** | `id`, `name`, `description`, `domain`, MIL-STD `symbol`, `armor` class, DIS `dis` type, `maxSpeed`/`cruiseSpeed` (m/s), `acceleration` (m/s²), `turnRate` (**rad/s**), `offroadFactor`, `sensorHeight` (m), `sensors` and `weapons` (ids), `crew`; aircraft also `cruiseAltitude`, `climbRate`, and `minSpeed` for fixed wing; optional `capacity` (seats for infantry) and default `reactions` |
| **Unit template** | `id`, `name`, `echelon`, `members` (entity type ids; the first is the leader), `formation`, `spacing` (m) |

Valid values:

| Field | Values |
| --- | --- |
| `domain` | `ground`, `lifeform`, `air`, `surface` |
| `armor` | `lifeform`, `soft`, `light`, `armored`, `air`, `ship` |
| `symbol` | `armor`, `mech`, `infantry`, `recon`, `wheeled`, `air-defense`, `artillery`, `rotary`, `fixed-wing`, `uav`, `ship`, `boat`, `generic` |

How these numbers drive the simulation is described in
[Concepts](../concepts.md). The most important is **Pk**: the chance that one
shot destroys a target of that armour class at short range.

## 2. As a data file (no code)

[`examples/catalog-extension.json`](../../examples/catalog-extension.json)
contains the three new entries:

```json
{
  "weapons": [
    {
      "id": "gun-120mm-l55",
      "name": "120mm L55 smoothbore",
      "munition": { "kind": 2, "domain": 2, "country": 78, "category": 2, "subcategory": 1, "specific": 0, "extra": 0 },
      "minRange": 50, "maxRange": 4500, "reloadTime": 6, "ammo": 42, "projectileSpeed": 1750,
      "pk": { "armored": 0.75, "light": 0.9, "soft": 0.9, "lifeform": 0.3, "ship": 0.15 },
      "targets": ["ground", "lifeform", "surface"]
    }
  ],
  "entityTypes": [
    {
      "id": "de-leopard2a6", "name": "Leopard 2A6", "description": "German main battle tank",
      "domain": "ground", "symbol": "armor", "armor": "armored",
      "dis": { "kind": 1, "domain": 1, "country": 78, "category": 1, "subcategory": 1, "specific": 0, "extra": 0 },
      "maxSpeed": 19, "cruiseSpeed": 12, "acceleration": 2.6, "turnRate": 0.61, "offroadFactor": 0.72,
      "sensorHeight": 2.5, "sensors": ["thermal-sight", "eye"], "weapons": ["gun-120mm-l55", "mg-762"], "crew": 4
    }
  ],
  "unitTemplates": [
    { "id": "de-tank-platoon", "name": "DE Tank Platoon", "echelon": "platoon",
      "members": ["de-leopard2a6", "de-leopard2a6", "de-leopard2a6", "de-leopard2a6"], "formation": "wedge", "spacing": 90 }
  ]
}
```

Things to note:

- **Reuse is fine.** The Leopard uses the stock `thermal-sight`, `eye` and
  `mg-762`.
- **Units.** Speeds are m/s (19 m/s ≈ 68 km/h). `turnRate` is rad/s
  (0.61 ≈ 35°/s).
- **DIS country 78** is Germany. Other simulations will see these entities with
  that enumeration ([DIS reference](../reference/dis.md)).

Start the server with it:

```bash
npm start -- --catalog examples/catalog-extension.json
```

```
Catalog extension: examples/catalog-extension.json
WeRForces running at http://127.0.0.1:8080  (scenario: Untitled)
  Docs http://127.0.0.1:8080/docs/  ·  REST API http://127.0.0.1:8080/api/docs  ·  MCP http://127.0.0.1:8080/mcp
```

In the GUI, the **Blue** palette now lists **DE Tank Platoon** and **Leopard
2A6**. The palette groups types by DIS country: Russia (222) goes to Red,
country 0 to Neutral, and everything else to Blue. The new types also work in
the REST API and MCP:

```bash
curl -s -H 'Content-Type: application/json' http://127.0.0.1:8080/api/v1/units \
  -d '{"templateId":"de-tank-platoon","force":1,"position":{"town":"Dunmore"}}'
```

**Rules:**

- An entry with the **same id** as a default **replaces** it. For example,
  re-declare `us-m1a2` with a longer-range sensor to experiment.
- New ids are **added**.
- The merged catalog is **validated** at startup. An entity type that references
  an unknown weapon or sensor, or a template that references an unknown type,
  stops the server with a clear message:

  ```
  werforces: entity type x references unknown weapon nope
  ```

- Scenarios that use custom types need the same `--catalog` file when they are
  loaded.

## 3. In code

For experiments and batch studies, build the catalog in TypeScript and pass it to
the engine. [`examples/custom-catalog.ts`](../../examples/custom-catalog.ts)
defines the same Leopard and fights a platoon of them against the stock T-72
platoon:

```ts
const catalog: Catalog = {
  ...DEFAULT_CATALOG,
  weapons: [...DEFAULT_CATALOG.weapons, { id: 'gun-120mm-l55', /* … */ }],
  entityTypes: [...DEFAULT_CATALOG.entityTypes, { id: 'de-leopard2a6', turnRate: 35 * DEG, /* … */ }],
  unitTemplates: [...DEFAULT_CATALOG.unitTemplates, { id: 'de-tank-platoon', /* … */ }],
};
const engine = new Engine({ catalog });
```

```bash
npx tsx examples/custom-catalog.ts
```

```
1106s  T-72 Plt 2 destroyed by Leo Plt Lead
1118s  T-72 Plt Lead destroyed by Leo Plt Lead
1124s  T-72 Plt 3 destroyed by Leo Plt Lead
Leopards: 4/4 survive
T-72s: 0/3 survive
```

Combine this with [Tutorial 8](08-batch-and-monte-carlo.md) to study how one
parameter (gun range, armour, sensor range) changes outcomes across hundreds of
runs.

## 4. Making it permanent

To ship a type with WeRForces itself:

1. Add it to `src/sim/catalog.ts`. The `dis()` helper and `DEG` constant keep
   entries compact.
2. Optionally add a unit template and use it in `scripts/make-scenarios.ts`.
3. Run `npm run docs:gen` to regenerate the [catalog reference](../reference/catalog.md),
   then `npm test`. `docs.test.ts` fails if the reference is out of date.

## 5. Choosing numbers

The defaults are representative, not authoritative. When adding equipment:

- **Calibrate Pk against a reference matchup.** For example, if your new gun
  should be "slightly better than the M256", start from the M256's values and
  adjust. Run duels (Tutorial 8 style) and check the kill ratios are plausible.
- **Range and Pk work together.** Effective Pk falls with the square of range
  (to half at maximum range), so a longer `maxRange` also improves mid-range
  shots.
- **Sensors matter as much as weapons.** A long-range gun is useless if
  `thermal-sight` (4.5 km, 120°) can't see that far, or the terrain blocks the
  view.
- **Off-road factor** decides whether a vehicle sticks to roads (low values) or
  drives cross-country (high values).

**You have finished the tutorials.** See the [user guide](../user-guide.md)
and the [reference](../README.md#reference) for everything else.
