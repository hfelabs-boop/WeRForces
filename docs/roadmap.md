# Roadmap

WeRForces aims to be the simulator you reach for first when you need a battle running
quickly, driven by people or by AI agents, in a browser, without licences. It does not try
to match established commercial CGF products feature for feature; it leads on speed of use,
openness and AI control, and builds fidelity, scale, interoperability and assurance behind
that, release by release.

Each milestone lists what it delivers and the acceptance tests that say it is done.

## v0.6: depth where it matters most

| Area | Delivers | Accepted when |
|---|---|---|
| Model fidelity | Armour by aspect (front, side, rear, top); ballistic drop and time of flight for unguided rounds; radar detection from the radar range equation (radar cross-section by type); a model registry so these can be swapped | Unit tests against hand-worked cases; an RPG-7 kills a frontal M1A2 far less often than a side or rear one; golden runs re-recorded with the reasons |
| Scale | 5,000 entities at 1x real time or better on one server; sensor scheduling, cheaper line of sight, a faster GUI renderer | `npm run bench` shows it, and stays in CI as a regression check |
| Aggregate level | Units simulated as one object (strength, Lanchester-type attrition, unit-speed movement) that disaggregate into entities near the enemy or on command, and re-aggregate | Tests for attrition against the closed-form Lanchester result; round trip aggregate → entities → aggregate keeps strength and position |
| Large terrain | Tiled terrain datasets loaded on demand (200 km × 200 km at 30 m); earth curvature and refraction in line of sight | A 200 km dataset loads and runs; line of sight across 30 km of flat ground is blocked by curvature as expected |
| Interoperability evidence | DIS 7 PDUs cross-checked against an independent implementation; more PDUs; a conformance matrix | Round-trip tests with the independent library pass for every PDU we send or read |
| AI commanders | A rule-based commander that runs a force (attacks when strong, defends or delays when weak, calls fire, resupplies, regroups); an LLM commander that sees what its force sees and acts through the same commands as a player | Rule-based commander wins or holds in the standard scenarios more often than an idle force; the LLM commander is exercised with a scripted transport in tests and against the live API when a key is configured |

## v0.7: geospecific and multi-user

- Streaming geospecific terrain (3D Tiles / quantized mesh elevation, OSM vectors) on a round earth; areas of several hundred kilometres.
- Building interiors and multi-storey urban terrain for infantry.
- Several operators per force with their own views, chat and handover of units.
- Batch runs on many machines (a job queue), with results in a database.

## v0.8: proven interoperability

- HLA 1516e with the complete RPR FOM 2.0 (radio, simulation management, aggregates), tested against at least two commercial RTIs.
- DIS 7 and HLA conformance reports; a gateway between them.
- DDS (for example for C2 systems) where users need it.
- Participation in an interoperability test event.

## v0.9: models users can trust

- Model cards for every model: what it represents, its data, its limits and its validation evidence.
- Validation cases against published data and reference models.
- Pluggable data packs (versioned, signed) so organisations can bring their own equipment data.
- Domains: subsurface (sonar), air dynamics (energy-based flight), naval.

## v1.0: deployable

- Offline and air-gapped installation, a security review and hardening guide.
- Long-term support branch, upgrade path for scenarios and data packs.
- Training material, reference deployments and a support process.
