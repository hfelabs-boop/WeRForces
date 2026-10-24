# Tutorial 3: Building and sharing a scenario

**Time:** 15 minutes · **You will learn:**

- generating new terrain;
- naming and organising forces;
- saving, exporting and importing;
- what rewind does;
- editing the scenario file by hand.

## 1. Generate a new battlefield

**File → New scenario**, then:

| Field | Value | Effect |
| --- | --- | --- |
| Name | `River Line` | |
| Terrain | *Generated (settings below)* | the default. The other entries are imported real-world terrains |
| Keep terrain | *untick* | generate new terrain from the fields below |
| Terrain seed | `4242` | any number. The same seed always gives the same map |
| Extent | `12 km` | map size |
| Water % | `18` | more water: lakes and wider valleys |
| Forest % | `35` | more cover. Concealment matters more |

Press **Create**. The new terrain takes a second or two to generate. Towns and
roads are placed automatically. Hover over them to read their names from the
map labels.

## 2. Lay out the forces

Using what you learned in Tutorials 1–2, place:

- **Blue:** a **US Mech Platoon**, a **US Rifle Squad** and a **Stinger Team** on
  one side of the water;
- **Red:** an **RU Tank Platoon** and an **RU Recon Patrol** on the other side, plus
  an **Mi-24V Hind** (Aircraft group) behind them.

Then organise them:

- **Rename** units to fit your story. Select one and click the name in the
  inspector. For example *1st Plt*, *Recon*, *Hind 21*.
- **Group loose entities into a unit.** Shift+click them (or Shift+drag a box
  around them) and press **Group into a unit** in the inspector. Through the
  API: `POST /api/v1/units {"entityIds": [...]}`; see [Tutorial 4](04-scripting-with-the-rest-api.md).
- **Draw graphics.** An **Area** for the objective, a **Route** for the Red
  recon to **Patrol**, and a **Phase line** along the river.
- **Set ROE.** For example, Red recon on *Return fire* so it observes rather
  than fights.
- **Give plans** with timed starts: *Wait until…* with *time is (s)* `300`,
  then *Move to (pick)*. Red attacks five minutes in.

Any entity can be **moved** later with **Alt+drag**, and **deleted** with the
**Delete** key.

## 3. Save it

**File → Save on server…** → `river-line`. The file is written to
`scenarios/river-line.json` on the server. It now appears in **File → Open
scenario…** (with the description, if you add one; see step 6) and can be
started directly:

```bash
npm start -- --scenario river-line
```

Saving also sets the **rewind point**: ⏮ returns to exactly this state.

## 4. Run, rewind, repeat

Run the scenario for a few minutes, then press ⏮. Rewind restores the state as
it was **last loaded or saved**. Positions, damage, ammunition, time and the
event log all reset. Changes made after that point are discarded. Save again to
keep them.

## 5. Export and share

- **File → Export to file** downloads the current state as `river-line.json` to
  your computer.
- Send it to a colleague. They load it with **File → Import from file…** (or put
  it in their `scenarios/` folder).

The file holds the **terrain recipe** (seed and parameters), not the terrain
itself, so it is small (a few KB) and recreates the identical map anywhere.

> Saving mid-run writes a full **checkpoint** of the current state:
>
> - positions, damage, ammunition, fuel, suppression, morale and contacts
>   (destroyed entities are kept as wrecks);
> - the assigned tasks and plans, and how far each has got;
> - munitions in flight, smoke clouds, orders still on their way, and the
>   random number state;
> - the current time, as `startTime`.
>
> Loading the file continues the run from that point, and loading the same
> file again always gives the same continuation. Positions are rounded to
> 10 cm in the file, so after a while the continuation can differ in detail
> from the run you saved.

## 6. Edit the file by hand

Open `scenarios/river-line.json` in an editor. The format is documented in
[Scenario file format](../reference/scenario-format.md). Common edits:

**Add a description** (shown in *Open scenario*):

```json
"description": "Red attempts a river crossing at dawn; Blue defends with a mech platoon and infantry.",
```

**Make Red hostile to neutrals too** (e.g. to add civilians Red will fire on):

```json
"hostilities": [[1, 2], [2, 3]],
```

**Move the battlefield on the globe.** This changes the latitude/longitude used
by DIS, TAK and GIS exports, but not the terrain:

```json
"terrain": { "seed": 4242, "size": 12000, "origin": { "lat": 59.33, "lon": 18.06 }, ... }
```

**Change an entity's starting altitude** (aircraft, metres above ground):

```json
{ "id": "E20", "typeId": "ru-mi24", "altitude": 40, ... }
```

Reload with **File → Open scenario…**. If the file has a mistake, for example an
unknown `typeId` or a tank in a lake, the load is refused with an error message
and the current scenario stays loaded.

## 7. Generate scenarios with code (optional)

For many variations, or exact placement along roads, build scenarios in code.
`scripts/make-scenarios.ts` generates the two bundled scenarios: it finds towns
and road routes on the generated terrain, places units, assigns plans and calls
`engine.toScenario()`. Copy it to make your own:

```bash
npx tsx scripts/make-scenarios.ts     # rewrites scenarios/calloway-crossroads.json and lakeside-patrol.json
```

**Next:** [Tutorial 4: Scripting with the REST API](04-scripting-with-the-rest-api.md).
