// OpenAPI 3.1 description of the /api/v1 REST API.

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Schema) => ({ content: { 'application/json': { schema } } });
const ok = (schema: Schema, description = 'OK') => ({ description, ...json(schema) });
const errors = {
  '400': { description: 'Invalid request', ...json(ref('Error')) },
  '401': { description: 'Missing or wrong API key', ...json(ref('Error')) },
  '404': { description: 'Not found', ...json(ref('Error')) },
};
const idParam = (name = 'id') => ({ name, in: 'path', required: true, schema: { type: 'string' } });

function op(tag: string, summary: string, extra: Schema = {}, response: Schema = ok({ type: 'object' })): Schema {
  return { tags: [tag], summary, responses: { '200': response, ...errors }, ...extra };
}

export function buildOpenApi(baseUrl: string): Schema {
  const body = (schema: Schema) => ({ requestBody: { required: true, ...json(schema) } });
  const taskable = (kind: 'entities' | 'units', tag: string) => ({
    [`/api/v1/${kind}/{id}/task`]: {
      post: op(tag, `Assign a task (replaces any plan)`, { parameters: [idParam()], ...body(ref('Task')) }),
    },
    [`/api/v1/${kind}/{id}/plan`]: {
      post: op(tag, `Assign a plan`, { parameters: [idParam()], ...body(ref('Plan')) }),
    },
    [`/api/v1/${kind}/{id}/stop`]: { post: op(tag, 'Stop the current task and plan', { parameters: [idParam()] }) },
    [`/api/v1/${kind}/{id}/embark`]: {
      post: op(tag, 'Put this infantry into a carrier now (scenario setup); a unit carrier shares out seats', {
        parameters: [idParam()],
        ...body({ type: 'object', required: ['carrierId'], properties: { carrierId: { type: 'string', description: 'carrier entity or unit id' } } }),
      }),
    },
    [`/api/v1/${kind}/{id}/disembark`]: { post: op(tag, "Let this carrier's (or unit's carriers') passengers out now", { parameters: [idParam()] }) },
  });

  return {
    openapi: '3.1.0',
    info: {
      title: 'WeRForces API',
      version: '1.0.0',
      description:
        'Remote control of the WeRForces computer-generated forces simulator. Positions are local metres ' +
        '(x east, y north from the terrain south-west corner) and may be given as {x,y}, {lat,lon} or {town}. ' +
        'Mutating requests must send Content-Type: application/json. When the server runs with --api-key, send ' +
        '`Authorization: Bearer <key>` (or `X-API-Key`).',
    },
    servers: [{ url: baseUrl || '/' }],
    security: [{ bearer: [] }, { apiKey: [] }],
    tags: ['Simulation', 'Scenario', 'Recording', 'Catalog', 'Entities', 'Units', 'Graphics', 'Events', 'Terrain', 'Integrations', 'Export'].map((name) => ({ name })),
    paths: {
      '/api/v1/simulation': { get: op('Simulation', 'Status, strength per force, terrain and towns', {}, ok(ref('Simulation'))) },
      '/api/v1/simulation/run': { post: op('Simulation', 'Run in real time', {}, ok(ref('Simulation'))) },
      '/api/v1/simulation/pause': { post: op('Simulation', 'Pause', {}, ok(ref('Simulation'))) },
      '/api/v1/simulation/rewind': { post: op('Simulation', 'Rewind to the loaded scenario', {}, ok(ref('Simulation'))) },
      '/api/v1/simulation/step': {
        post: op('Simulation', 'Advance simulated time immediately (as fast as possible)', body({ type: 'object', properties: { seconds: { type: 'number', maximum: 3600 } } }), ok(ref('Simulation'))),
      },
      '/api/v1/simulation/time-scale': {
        put: op('Simulation', 'Set the real-time multiplier', body({ type: 'object', required: ['scale'], properties: { scale: { type: 'number', exclusiveMinimum: 0, maximum: 64 } } }), ok(ref('Simulation'))),
      },
      '/api/v1/scenario': {
        get: op('Scenario', 'Current state as a scenario file', {}, ok(ref('Scenario'))),
        put: op('Scenario', 'Load a scenario file', body(ref('Scenario'))),
      },
      '/api/v1/scenario/new': {
        post: op('Scenario', 'Start an empty scenario', body({ type: 'object', properties: { name: { type: 'string' }, terrain: { type: 'object', description: 'generation settings (seed, size, cellSize, relief, waterFraction, forestFraction, towns, origin) or {"dataset": name} for imported terrain' } } })),
      },
      '/api/v1/scenarios': { get: op('Scenario', 'List scenarios stored on the server') },
      '/api/v1/scenarios/{name}': {
        get: op('Scenario', 'Read a stored scenario', { parameters: [idParam('name')] }, ok(ref('Scenario'))),
        put: op('Scenario', 'Save the current state under a name', { parameters: [idParam('name')] }),
      },
      '/api/v1/scenarios/{name}/load': { post: op('Scenario', 'Load a stored scenario', { parameters: [idParam('name')] }) },
      '/api/v1/terrains': { get: op('Terrain', 'Imported real-world terrain datasets (use one with POST /scenario/new {"terrain":{"dataset":name}})') },
      '/api/v1/terrains/{name}': { put: op('Terrain', 'Upload a terrain dataset made with werforces-terrain', { parameters: [idParam('name')], ...body({ type: 'object' }) }) },
      '/api/v1/simulation/rules': {
        get: op('Simulation', 'Which optional models are on'),
        put: op('Simulation', 'Turn optional models on or off', {
          ...body({
            type: 'object',
            properties: {
              suppression: { type: 'boolean', description: 'incoming fire suppresses: less accurate, slower, worse at spotting; infantry get pinned' },
              morale: { type: 'boolean', description: 'units become shaken and break under losses and fire' },
              fuel: { type: 'boolean', description: 'vehicles and aircraft burn fuel; out of fuel, vehicles stop and aircraft come down' },
              orderDelay: { type: 'boolean', description: 'orders take time to pass down the chain of command: 5 s for an entity, 15 s a section, 30 s a platoon, 60 s a company (off by default)' },
            },
          }),
        }),
      },
      '/api/v1/simulation/environment': {
        get: op('Simulation', 'Time of day and weather: the settings, plus the current local time, sun altitude and light level'),
        put: op('Simulation', 'Change the time of day and weather (fields left out keep their values)', {
          ...body({
            type: 'object',
            properties: {
              date: { type: 'string', description: 'date at the scenario start, YYYY-MM-DD' },
              time: { type: 'number', minimum: 0, maximum: 24, description: 'local solar time at the scenario start, hours' },
              visibility: { type: 'number', minimum: 50, maximum: 100000, description: 'meteorological visibility in metres (fog: a few hundred)' },
              precipitation: { type: 'string', enum: ['none', 'rain', 'heavyRain', 'snow'] },
              windSpeed: { type: 'number', minimum: 0, maximum: 40, description: 'm/s; drifts smoke' },
              windFrom: { type: 'number', minimum: 0, maximum: 360, description: 'degrees the wind blows from' },
            },
          }),
        }),
      },
      '/api/v1/recording': { get: op('Recording', 'Recording summary: time span, frames, bookmarks, live or reviewing a loaded recording') },
      '/api/v1/recording/data': { get: op('Recording', 'The whole recording (frames, events, bookmarks) as JSON, for saving or replaying elsewhere') },
      '/api/v1/recording/report': { get: op('Recording', 'After-action report: strength per force, losses, kills with killer and weapon, rounds fired, strength over time') },
      '/api/v1/recording/state': {
        get: op('Recording', 'Recorded positions and damage of every entity and unit at a past time (interpolated)', {
          parameters: [{ name: 'time', in: 'query', schema: { type: 'number' }, description: 'simulation time in seconds (default: end of the recording)' }],
        }),
      },
      '/api/v1/recording/bookmarks': {
        post: op('Recording', 'Add a bookmark (note) to the recording', {
          ...body({ type: 'object', required: ['text'], properties: { text: { type: 'string' }, time: { type: 'number', description: 'default: now' } } }),
        }),
      },
      '/api/v1/recording/bookmarks/{id}': { delete: { tags: ['Recording'], summary: 'Remove a bookmark', parameters: [idParam()], responses: { '204': { description: 'Deleted' }, ...errors } } },
      '/api/v1/recording/clear': { post: op('Recording', 'Discard the recording (or stop reviewing a loaded one) and record live from now') },
      '/api/v1/recording/load': { post: op('Recording', 'Review a recording sent in the body (live recording is suspended until clear)', { ...body({ type: 'object' }) }) },
      '/api/v1/recordings': { get: op('Recording', 'Saved recordings on the server') },
      '/api/v1/recordings/{name}': { put: op('Recording', 'Save the current recording under a name', { parameters: [idParam('name')] }) },
      '/api/v1/recordings/{name}/load': { post: op('Recording', 'Review a saved recording', { parameters: [idParam('name')] }) },
      '/api/v1/catalog': { get: op('Catalog', 'Full simulation object model') },
      '/api/v1/catalog/entity-types': { get: op('Catalog', 'Entity types (summary)') },
      '/api/v1/catalog/unit-templates': { get: op('Catalog', 'Unit templates') },
      '/api/v1/entities': {
        get: op(
          'Entities',
          'List entities',
          {
            parameters: ['force', 'domain', 'unit', 'alive', 'remote'].map((name) => ({ name, in: 'query', schema: { type: 'string' } })),
          },
          ok({ type: 'array', items: ref('Entity') }),
        ),
        post: {
          ...op('Entities', 'Create an entity', body(ref('CreateEntity'))),
          responses: { '201': ok(ref('Entity'), 'Created'), ...errors },
        },
      },
      '/api/v1/entities/{id}': {
        get: op('Entities', 'Get an entity', { parameters: [idParam()] }, ok(ref('Entity'))),
        patch: op(
          'Entities',
          'Rename, reposition or set ROE',
          { parameters: [idParam()], ...body({ type: 'object', properties: { name: { type: 'string' }, roe: ref('Roe'), position: ref('Position'), heading: { type: 'number' }, reactions: ref('Reactions') } }) },
          ok(ref('Entity')),
        ),
        delete: { tags: ['Entities'], summary: 'Delete an entity', parameters: [idParam()], responses: { '204': { description: 'Deleted' }, ...errors } },
      },
      '/api/v1/entities/{id}/path': { get: op('Entities', 'Remaining planned waypoints', { parameters: [idParam()] }) },
      ...taskable('entities', 'Entities'),
      '/api/v1/units': {
        get: op('Units', 'List units', { parameters: [{ name: 'force', in: 'query', schema: { type: 'string' } }] }),
        post: {
          ...op('Units', 'Create a unit from a template, or group existing entities', body(ref('CreateUnit'))),
          responses: { '201': ok({ type: 'object' }, 'Created'), ...errors },
        },
      },
      '/api/v1/units/{id}': {
        get: op('Units', 'Get a unit with its members', { parameters: [idParam()] }),
        patch: op('Units', 'Rename, set formation, ROE or reactions, or put under a superior unit', {
          parameters: [idParam()],
          ...body({
            type: 'object',
            properties: {
              name: { type: 'string' },
              formation: ref('Formation'),
              roe: ref('Roe'),
              reactions: ref('Reactions'),
              superiorId: { type: ['string', 'null'], description: 'superior unit in the chain of command (null: independent). Orders to the superior pass down to it.' },
            },
          }),
        }),
        delete: { tags: ['Units'], summary: 'Delete a unit and its members', parameters: [idParam()], responses: { '204': { description: 'Deleted' }, ...errors } },
      },
      ...taskable('units', 'Units'),
      '/api/v1/graphics': {
        get: op('Graphics', 'List tactical graphics'),
        post: {
          ...op('Graphics', 'Create a route, area, phase line or point', body(ref('CreateGraphic'))),
          responses: { '201': ok({ type: 'object' }, 'Created'), ...errors },
        },
      },
      '/api/v1/graphics/{id}': {
        get: op('Graphics', 'Get a graphic', { parameters: [idParam()] }),
        patch: op('Graphics', 'Rename or move points', { parameters: [idParam()], ...body({ type: 'object', properties: { name: { type: 'string' }, points: { type: 'array', items: ref('Position') } } }) }),
        delete: { tags: ['Graphics'], summary: 'Delete a graphic', parameters: [idParam()], responses: { '204': { description: 'Deleted' }, ...errors } },
      },
      '/api/v1/events': {
        get: op(
          'Events',
          'Event log',
          {
            parameters: [
              { name: 'since', in: 'query', schema: { type: 'integer' }, description: 'Return events with seq greater than this' },
              { name: 'kinds', in: 'query', schema: { type: 'string' }, description: 'Comma-separated kinds' },
              { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 1000 } },
            ],
          },
          ok({ type: 'array', items: ref('Event') }),
        ),
      },
      '/api/v1/terrain': { get: op('Terrain', 'Terrain spec, towns and roads') },
      '/api/v1/terrain/point': {
        get: op('Terrain', 'Elevation, water, forest, road and slope at a point', {
          parameters: ['x', 'y', 'lat', 'lon', 'town'].map((name) => ({ name, in: 'query', schema: { type: 'string' } })),
        }),
      },
      '/api/v1/terrain/line-of-sight': {
        post: op(
          'Terrain',
          'Line of sight between two entities or points',
          body({ type: 'object', required: ['from', 'to'], properties: { from: { oneOf: [{ type: 'string', description: 'entity id' }, ref('Position')] }, to: { oneOf: [{ type: 'string' }, ref('Position')] } } }),
        ),
      },
      '/api/v1/terrain/route': {
        post: op(
          'Terrain',
          'Plan a route without moving anything',
          body({ type: 'object', required: ['from', 'to'], properties: { from: ref('Position'), to: ref('Position'), domain: { enum: ['ground', 'lifeform', 'surface', 'air'] } } }),
        ),
      },
      '/api/v1/integrations': { get: op('Integrations', 'Status of CoT/TAK and webhooks') },
      '/api/v1/integrations/cot': {
        get: op('Integrations', 'Cursor-on-Target publisher status'),
        put: op('Integrations', 'Configure the Cursor-on-Target publisher', body(ref('CotConfig'))),
      },
      '/api/v1/webhooks': {
        get: op('Integrations', 'List webhooks'),
        post: { ...op('Integrations', 'Add a webhook', body(ref('WebhookInput'))), responses: { '201': ok({ type: 'object' }, 'Created'), ...errors } },
      },
      '/api/v1/webhooks/{id}': { delete: { tags: ['Integrations'], summary: 'Remove a webhook', parameters: [idParam()], responses: { '204': { description: 'Deleted' }, ...errors } } },
      '/api/v1/webhooks/{id}/test': { post: op('Integrations', 'Send a test message', { parameters: [idParam()] }) },
      '/api/v1/export/entities.geojson': { get: op('Export', 'Entities as GeoJSON points', {}, { description: 'GeoJSON', content: { 'application/geo+json': {} } }) },
      '/api/v1/export/graphics.geojson': { get: op('Export', 'Tactical graphics as GeoJSON', {}, { description: 'GeoJSON', content: { 'application/geo+json': {} } }) },
      '/api/v1/export/scene.kml': { get: op('Export', 'Entities and graphics as KML', {}, { description: 'KML', content: { 'application/vnd.google-earth.kml+xml': {} } }) },
      '/api/v1/export/live.kml': {
        get: op('Export', 'KML NetworkLink that refreshes the scene in Google Earth', { parameters: [{ name: 'refresh', in: 'query', schema: { type: 'number' } }] }, { description: 'KML', content: { 'application/vnd.google-earth.kml+xml': {} } }),
      },
    },
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer' },
        apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'object', properties: { status: { type: 'integer' }, message: { type: 'string' } } } } },
        Position: {
          description: 'A location: local metres, geodetic degrees, or a town name',
          oneOf: [
            { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
            { type: 'object', required: ['lat', 'lon'], properties: { lat: { type: 'number' }, lon: { type: 'number' } } },
            { type: 'object', required: ['town'], properties: { town: { type: 'string' } } },
          ],
        },
        Force: { type: 'integer', enum: [0, 1, 2, 3], description: '0 other, 1 blue, 2 red, 3 neutral' },
        Roe: { enum: ['fireAtWill', 'returnFire', 'holdFire'] },
        Formation: { enum: ['column', 'line', 'wedge', 'vee', 'echelonRight'] },
        Task: {
          oneOf: [
            { type: 'object', required: ['type', 'target'], properties: { type: { const: 'moveTo' }, target: ref('Position'), speed: { type: 'number', description: 'm/s' } } },
            { type: 'object', required: ['type', 'routeId'], properties: { type: { const: 'followRoute' }, routeId: { type: 'string' }, speed: { type: 'number' }, reverse: { type: 'boolean' }, startIndex: { type: 'integer' } } },
            { type: 'object', required: ['type', 'routeId'], properties: { type: { const: 'patrol' }, routeId: { type: 'string' }, speed: { type: 'number' } } },
            { type: 'object', required: ['type', 'duration'], properties: { type: { const: 'wait' }, duration: { type: 'number' } } },
            { type: 'object', required: ['type', 'targetId'], properties: { type: { const: 'follow' }, targetId: { type: 'string' }, distance: { type: 'number' } } },
            { type: 'object', required: ['type', 'targetId'], properties: { type: { const: 'attack' }, targetId: { type: 'string' } } },
            { type: 'object', required: ['type', 'center', 'radius'], properties: { type: { const: 'orbit' }, center: ref('Position'), radius: { type: 'number' }, duration: { type: 'number' } } },
            {
              type: 'object',
              required: ['type', 'carrierId'],
              description: 'Infantry walk to the carrier (or the nearest member of a carrier unit with free seats) and board it. On a unit, seats are shared out.',
              properties: { type: { const: 'mount' }, carrierId: { type: 'string' } },
            },
            { type: 'object', required: ['type'], description: 'A carrier stops (a helicopter lands) and lets all passengers out.', properties: { type: { const: 'dismount' } } },
            {
              type: 'object',
              required: ['type', 'target'],
              description: 'Indirect fire (artillery, mortars) on a location. On a unit every tube that can reach the target fires.',
              properties: {
                type: { const: 'fireMission' },
                target: ref('Position'),
                rounds: { type: 'integer', minimum: 1, maximum: 100, description: 'rounds per tube (default 3)' },
                radius: { type: 'number', minimum: 0, maximum: 1000, description: 'spread rounds over this radius in m (default 0)' },
                weaponId: { type: 'string', description: 'indirect-fire weapon to use (default: first that can reach)' },
                smoke: { type: 'boolean', description: 'fire smoke rounds: a cloud that blocks sight instead of a blast' },
              },
            },
            {
              type: 'object',
              required: ['type', 'graphicId'],
              description: 'Engineers: move to a minefield or obstacle line and breach a 30 m lane through it.',
              properties: { type: { const: 'breach' }, graphicId: { type: 'string' } },
            },
            {
              type: 'object',
              required: ['type'],
              description: 'Drive to a friendly supply vehicle (the nearest with stock, or supplierId), halt beside it and take on fuel and ammunition. Units send every member that needs it.',
              properties: { type: { const: 'resupply' }, supplierId: { type: 'string' } },
            },
            {
              type: 'object',
              required: ['type', 'position'],
              description:
                'Take a position and hold it facing `facing` (degrees; default the direction of the move). overwatch: watch and engage (optional `duration` s). defend: dig in and fight from it. screen: return-fire ROE, fall back to `fallback` (default 2 km to the rear) when an enemy comes within `breakContact` m. ambush: weapons tight until an enemy enters the `killZoneId` area, then everyone opens fire. Units deploy in a line `width` m wide. Infantry dig in after 90 s, vehicles go hull-down after 30 s: harder to see and hit.',
              properties: {
                type: { enum: ['overwatch', 'defend', 'screen', 'ambush'] },
                position: ref('Position'),
                facing: { type: 'number', minimum: 0, maximum: 360 },
                width: { type: 'number' },
                duration: { type: 'number' },
                killZoneId: { type: 'string' },
                fallback: ref('Position'),
                breakContact: { type: 'number' },
              },
            },
            {
              type: 'object',
              required: ['type', 'areaId'],
              description: "Sweep an area in parallel tracks spaced to the searcher's sensor range (or `spacing` m), then report what was found.",
              properties: { type: { const: 'search' }, areaId: { type: 'string' }, spacing: { type: 'number' }, speed: { type: 'number' } },
            },
          ],
        },
        PlanStatement: {
          oneOf: [
            { type: 'object', required: ['kind', 'task'], properties: { kind: { const: 'task' }, task: ref('Task') } },
            { type: 'object', required: ['kind', 'roe'], properties: { kind: { const: 'setRoe' }, roe: ref('Roe') } },
            { type: 'object', required: ['kind', 'speed'], properties: { kind: { const: 'setSpeed' }, speed: { type: 'number' } } },
            { type: 'object', required: ['kind', 'altitude'], properties: { kind: { const: 'setAltitude' }, altitude: { type: 'number' } } },
            { type: 'object', required: ['kind', 'formation'], properties: { kind: { const: 'setFormation' }, formation: ref('Formation') } },
            { type: 'object', required: ['kind', 'reactions'], properties: { kind: { const: 'setReactions' }, reactions: ref('Reactions') } },
            {
              type: 'object',
              required: ['kind', 'condition'],
              properties: {
                kind: { const: 'waitUntil' },
                condition: {
                  type: 'object',
                  properties: {
                    type: { enum: ['simTime', 'inArea', 'enemyInArea', 'enemyDetected', 'underFire', 'strengthBelow', 'fuelBelow', 'ammoBelow', 'entityDestroyed'] },
                    time: { type: 'number' },
                    areaId: { type: 'string' },
                    entityId: { type: 'string' },
                    fraction: { type: 'number', minimum: 0, maximum: 1 },
                  },
                },
              },
            },
          ],
        },
        Reactions: {
          type: 'object',
          properties: {
            onContact: { enum: ['continue', 'halt'], description: 'halt: stop and fight while a hostile is within weapon range, then resume' },
            withdrawBelow: { type: 'number', minimum: 0, maximum: 1, description: 'units: fall back when strength drops below this fraction; entities: when weapons are knocked out' },
            withdrawTo: ref('Position'),
            callForFire: { type: 'boolean', description: 'request fire missions from idle friendly artillery on hostiles this entity sees' },
          },
        },
        Plan: { type: 'object', required: ['statements'], properties: { name: { type: 'string' }, loop: { type: 'boolean' }, statements: { type: 'array', items: ref('PlanStatement') } } },
        CreateEntity: {
          type: 'object',
          required: ['typeId', 'force', 'position'],
          properties: { typeId: { type: 'string' }, force: ref('Force'), position: ref('Position'), heading: { type: 'number', description: 'radians' }, name: { type: 'string' }, altitude: { type: 'number', description: 'm above ground (aircraft)' } },
        },
        CreateUnit: {
          oneOf: [
            { type: 'object', required: ['templateId', 'force', 'position'], properties: { templateId: { type: 'string' }, force: ref('Force'), position: ref('Position'), heading: { type: 'number' }, name: { type: 'string' } } },
            { type: 'object', required: ['entityIds'], properties: { entityIds: { type: 'array', items: { type: 'string' } }, name: { type: 'string' }, formation: ref('Formation') } },
          ],
        },
        CreateGraphic: {
          type: 'object',
          required: ['kind', 'points'],
          properties: {
            kind: { enum: ['route', 'area', 'phaseLine', 'point', 'minefield', 'obstacle'], description: 'minefield: an area that damages what crosses it; obstacle: a line vehicles cannot cross (ditch, wire)' },
            name: { type: 'string' },
            force: ref('Force'),
            points: { type: 'array', items: ref('Position') },
            density: { type: 'number', description: 'minefields: 0.1 sparse .. 1.5 dense (default 0.5)' },
          },
        },
        Entity: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            typeId: { type: 'string' },
            force: ref('Force'),
            domain: { enum: ['ground', 'lifeform', 'air', 'surface'] },
            x: { type: 'number' },
            y: { type: 'number' },
            z: { type: 'number', description: 'm above sea level' },
            lat: { type: 'number' },
            lon: { type: 'number' },
            headingDeg: { type: 'number' },
            speed: { type: 'number', description: 'm/s' },
            damage: { enum: ['none', 'mobility', 'firepower', 'destroyed'] },
            roe: ref('Roe'),
            task: { type: 'string' },
            plan: { type: 'string' },
            unitId: { type: 'string' },
            contacts: { type: 'array', items: { type: 'string' } },
            remote: { type: 'boolean' },
          },
        },
        Event: {
          type: 'object',
          properties: { seq: { type: 'integer' }, time: { type: 'number' }, kind: { type: 'string' }, text: { type: 'string' }, entityId: { type: 'string' }, targetId: { type: 'string' } },
        },
        Simulation: { type: 'object', properties: { scenario: { type: 'string' }, time: { type: 'number' }, running: { type: 'boolean' }, timeScale: { type: 'number' }, strength: { type: 'array' }, terrain: { type: 'object' } } },
        Scenario: { type: 'object', required: ['format', 'version', 'name', 'terrain'], properties: { format: { const: 'werforces-scenario' }, version: { const: 1 } } },
        CotConfig: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            url: { type: 'string', examples: ['udp://239.2.3.1:6969', 'tcp://takserver:8087'] },
            interval: { type: 'number' },
            stale: { type: 'number' },
            includeRemote: { type: 'boolean' },
          },
        },
        WebhookInput: {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string', format: 'uri' },
            format: { enum: ['json', 'slack', 'discord'] },
            kinds: { type: 'array', items: { enum: ['fire', 'detonation', 'damaged', 'destroyed', 'detected', 'task', 'created', 'deleted', 'info'] } },
            secret: { type: 'string', description: 'Signs payloads: X-WeRForces-Signature: sha256=<hmac>' },
            name: { type: 'string' },
          },
        },
      },
    },
  };
}

/** Small self-contained HTML page that renders the OpenAPI spec (no external assets). */
export function docsPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>WeRForces API</title>
<style>
:root{color-scheme:dark;--bg:#15191e;--panel:#1e242b;--border:#353e48;--text:#d7dee6;--muted:#8995a3}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px}
h1{margin:0 0 4px}h2{margin:28px 0 8px;border-bottom:1px solid var(--border);padding-bottom:4px}
.op{background:var(--panel);border:1px solid var(--border);border-radius:6px;margin:6px 0;padding:8px 10px}
.m{display:inline-block;min-width:62px;font:600 12px ui-monospace,monospace;border-radius:4px;padding:1px 6px;text-align:center;margin-right:8px}
.GET{background:#1d4a5c}.POST{background:#1d5c27}.PUT{background:#5c4a1d}.PATCH{background:#4a1d5c}.DELETE{background:#5c1d1d}
code{font-family:ui-monospace,monospace}.d{color:var(--muted);margin-left:8px}details pre{white-space:pre-wrap;font-size:12px;color:var(--muted)}
a{color:#7fb6ff}
</style></head><body><main>
<h1>WeRForces API</h1><p class="d" id="desc"></p>
<p>Machine-readable spec: <a href="/api/v1/openapi.json">/api/v1/openapi.json</a></p>
<div id="ops">Loading…</div></main>
<script type="module">
const headers = {};
const key = new URLSearchParams(location.search).get('api_key') || localStorage.getItem('werforces.apiKey');
if (key) headers.Authorization = 'Bearer ' + key;
const spec = await (await fetch('/api/v1/openapi.json', { headers })).json();
document.getElementById('desc').textContent = spec.info.description;
const byTag = {};
for (const [p, ops] of Object.entries(spec.paths)) for (const [m, o] of Object.entries(ops)) (byTag[o.tags[0]] ??= []).push({ p, m: m.toUpperCase(), o });
const el = document.getElementById('ops'); el.textContent = '';
const resolve = (s) => s && s.$ref ? spec.components.schemas[s.$ref.split('/').pop()] : s;
for (const [tag, list] of Object.entries(byTag)) {
  const h = document.createElement('h2'); h.textContent = tag; el.append(h);
  for (const { p, m, o } of list) {
    const d = document.createElement('div'); d.className = 'op';
    const req = o.requestBody ? resolve(o.requestBody.content['application/json'].schema) : null;
    d.innerHTML = '<span class="m ' + m + '">' + m + '</span><code></code><span class="d"></span>';
    d.querySelector('code').textContent = p; d.querySelector('.d').textContent = o.summary;
    if (req) { const det = document.createElement('details'); det.innerHTML = '<summary>request body</summary><pre></pre>'; det.querySelector('pre').textContent = JSON.stringify(req, null, 2); d.append(det); }
    el.append(d);
  }
}
</script></body></html>`;
}
