# Terrain datasets

Real-world terrains imported with `npm run terrain:import` (`werforces-terrain`).
Scenarios use one by name: `"terrain": { "dataset": "fulda" }`. See
[docs/terrain-import.md](../docs/terrain-import.md).

| Dataset | Area | Source |
| --- | --- | --- |
| `fulda.json` | 10 km square around Fulda, Hesse, Germany (50 m grid) | Copernicus DEM GLO-30 |

**Attribution.** `fulda.json` is derived from the Copernicus DEM GLO-30:
© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under
COPERNICUS by the European Union and ESA; all rights reserved. Used under the
Copernicus DEM licence, which permits free use and redistribution with this notice.
It has no map features (roads, water, forest, towns): add them from an OpenStreetMap
export with `--features`.
