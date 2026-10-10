// -----------------------------------------------------------------------------
// "Near my home": the stops and stations suggested from the house location,
// and the connection status that tells the user what to do next.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { restoreFetch, stubFetch } from './helpers/stubFetch.js';
import { bixiRoutes, MAP_STOPS, stopTimesPayload } from './helpers/fixtures.js';
import { normalizeConfig } from '../src/config.js';
import {
  clearSuggestions,
  getSuggestions,
  refreshSuggestions,
  suggestedStopName,
} from '../src/devices/suggestions.js';
import { buildDiscoveredDevices } from '../src/devices/index.js';
import { clearTransitousCache } from '../src/api/transitous.js';
import { clearBixiCache } from '../src/api/bixi.js';
import { describeStatus, inventory } from '../src/status.js';

function routes() {
  return {
    '/v1/map/stops': MAP_STOPS,
    '/v5/stoptimes': stopTimesPayload(Date.now(), [{ minutes: 3 }, { minutes: 9 }]),
    ...bixiRoutes(),
  };
}

beforeEach(() => {
  clearSuggestions();
  clearTransitousCache();
  clearBixiCache();
});
afterEach(() => restoreFetch());

test('the closest stops and stations are suggested, named the way people know them', async () => {
  stubFetch(routes());
  const gladys = createFakeGladys();
  const config = normalizeConfig({ nearby_bus_stops: 2, nearby_bixi_stations: 2 });

  const found = await refreshSuggestions(gladys, config);

  assert.equal(found.status, 'ok');
  assert.deepEqual(
    found.stops.map((stop) => [stop.id, stop.name]),
    [
      // Same name, same direction: the code on the sign tells them apart. The
      // parenthesis the STM forgot is closed.
      ['52743', 'École de technologie supérieure (Peel / Notre-Dame) (61 → Est) · 52743'],
      ['52744', 'École de technologie supérieure (Peel / Notre-Dame) (61 → Est) · 52744'],
    ],
  );
  // Station 3 is around the corner; 1 (1.2 km) and 2 (4.7 km) are beyond the
  // 1 km radius.
  assert.deepEqual(
    found.bixiStations.map((station) => station.id),
    ['3'],
  );

  // Without typing anything, the Discovery screen offers them.
  const names = buildDiscoveredDevices(gladys, config).map((device) => device.name);
  assert.deepEqual(names, [
    'École de technologie supérieure (Peel / Notre-Dame) (61 → Est) · 52743',
    'École de technologie supérieure (Peel / Notre-Dame) (61 → Est) · 52744',
    'de la Montagne / Notre-Dame',
  ]);
});

test('no located house, no permission, nothing wanted: each has its own status', async () => {
  stubFetch(routes());
  const gladys = createFakeGladys();
  const config = normalizeConfig({});

  gladys.houses = [{ id: 'h', name: 'Maison', latitude: null, longitude: null }];
  assert.equal((await refreshSuggestions(gladys, config)).status, 'no_location');

  gladys.houses = new Error('HTTP 403');
  assert.equal((await refreshSuggestions(gladys, config)).status, 'no_house');

  const off = normalizeConfig({ nearby_bus_stops: 0, nearby_bixi_stations: 0 });
  assert.equal((await refreshSuggestions(gladys, off)).status, 'disabled');
});

test('a lookup that fails everywhere says so, without throwing', async () => {
  stubFetch({ '/v1/map/stops': { status: 503, body: '' }, 'gbfs.json': { status: 503, body: '' } });
  const found = await refreshSuggestions(createFakeGladys(), normalizeConfig({}));
  assert.equal(found.status, 'failed');
  assert.deepEqual(getSuggestions().stops, []);
});

test('a suggested stop without description falls back on its name, then its code', () => {
  assert.equal(suggestedStopName({ code: '1', name: 'Peel / Ottawa' }, null), 'Peel / Ottawa');
  assert.equal(suggestedStopName({ code: '1', name: '' }, null), '1');
});

test('status: nothing found asks to locate the house', async () => {
  stubFetch(routes());
  const gladys = createFakeGladys();
  gladys.houses = [];
  const config = normalizeConfig({});
  await refreshSuggestions(gladys, config);
  const status = describeStatus(gladys, config);
  assert.equal(status.connected, false);
  assert.match(status.message.fr, /Paramètres → Maisons/);
});

test('status: devices waiting point to the Discovery tab, and say what a key adds', async () => {
  stubFetch(routes());
  const gladys = createFakeGladys();
  const config = normalizeConfig({ nearby_bus_stops: 2, nearby_bixi_stations: 1 });
  await refreshSuggestions(gladys, config);

  const status = describeStatus(gladys, config);
  assert.equal(status.connected, true);
  assert.equal(
    status.message.fr,
    'Prêt : 2 arrêts et 1 station BIXI à ajouter. Ouvrez l’onglet « Découverte » de cette ' +
      'intégration et cliquez sur « Ajouter ». Horaires prévus seulement : une clé STM ajoute ' +
      'le temps réel et l’état du métro.',
  );
});

test('status: once everything is added, what is watched and the STM quota', async () => {
  stubFetch(routes());
  const gladys = createFakeGladys();
  const config = normalizeConfig({
    stm_api_key: 'k',
    nearby_bus_stops: 1,
    nearby_bixi_stations: 0,
  });
  await refreshSuggestions(gladys, config);
  gladys.devices = buildDiscoveredDevices(gladys, config);

  const status = describeStatus(gladys, config);
  assert.equal(
    status.message.en,
    'Connected. Watching 1 bus stop and the metro (about 2160 STM requests a day).',
  );
});

test('status: bus stops with neither a key nor the timetable', () => {
  const config = normalizeConfig({ stops: '52743', schedule_without_key: false });
  const status = describeStatus(createFakeGladys(), config);
  assert.equal(status.connected, false);
  assert.match(status.message.en, /STM API key/);
});

test('inventory', () => {
  assert.deepEqual(inventory({ stops: 1, stations: 2, metro: true }), {
    en: '1 bus stop, 2 BIXI stations and the metro',
    fr: '1 arrêt, 2 stations BIXI et le métro',
  });
});
