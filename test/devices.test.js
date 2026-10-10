// -----------------------------------------------------------------------------
// Devices: discovery payloads, polling, publication, manifest actions.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { restoreFetch, stubFetch } from './helpers/stubFetch.js';
import { bixiRoutes, etatService, interruption } from './helpers/fixtures.js';
import { encodeFeed } from './helpers/gtfsRealtimeEncoder.js';
import { GLADYS_POLL_FREQUENCIES_MS, normalizeConfig } from '../src/config.js';
import {
  ACTIONS,
  buildBlueprints,
  buildDiscoveredDevices,
  findSelectedBlueprint,
  DeviceSelectionError,
  pollDevice,
  refreshDeviceNow,
} from '../src/devices/index.js';
import { NO_DEPARTURE_MINUTES } from '../src/devices/busStop.js';
import { clearPollSchedule } from '../src/devices/pollSchedule.js';
import { clearStateCache } from '../src/devices/stateCache.js';
import { clearPublishReports } from '../src/devices/publish.js';
import { clearReadings } from '../src/devices/readings.js';
import { clearSceneMemory } from '../src/scenes/triggers.js';
import { clearStmCache, TRIP_UPDATES_PATH } from '../src/api/stm.js';
import { clearBixiCache } from '../src/api/bixi.js';
import { ETAT_SERVICE_PATH } from '../src/api/metro.js';

const config = normalizeConfig({
  stm_api_key: 'k',
  stops: '52743, 51003@24:Bus du travail',
  bixi_stations: '1',
  max_departures: 2,
});

function busFeed(nowSeconds) {
  return encodeFeed({
    timestamp: nowSeconds,
    entities: [
      {
        tripUpdate: {
          trip: { tripId: 'T1', routeId: '24' },
          stopTimeUpdates: [{ stopId: '52743', departure: { time: nowSeconds + 185 } }],
        },
      },
    ],
  });
}

function routes(extra = {}) {
  return {
    [TRIP_UPDATES_PATH]: busFeed(Math.floor(Date.now() / 1000)),
    [ETAT_SERVICE_PATH]: etatService(),
    ...bixiRoutes(),
    ...extra,
  };
}

beforeEach(() => {
  clearPollSchedule();
  clearStateCache();
  clearPublishReports();
  clearReadings();
  clearSceneMemory();
  clearStmCache();
  clearBixiCache();
});
afterEach(() => restoreFetch());

test('one device per watched entry, plus the metro', () => {
  const gladys = createFakeGladys();
  const devices = buildDiscoveredDevices(gladys, config);
  assert.deepEqual(
    devices.map((device) => device.name),
    ['Métro STM', 'Arrêt STM 52743', 'Bus du travail', 'Station BIXI 1'],
  );
  assert.deepEqual(
    devices.map((device) => device.external_id),
    ['stm-metro:network', 'stm-bus-stop:52743', 'stm-bus-stop:51003@24', 'bixi-station:1'],
  );
});

test('every discovery payload is one the core accepts', () => {
  const gladys = createFakeGladys();
  for (const device of buildDiscoveredDevices(gladys, config)) {
    assert.ok(GLADYS_POLL_FREQUENCIES_MS.includes(device.poll_frequency), device.name);
    assert.equal(device.should_poll, true, `${device.name} must be scheduled by the core`);
    const ids = new Set();
    for (const feature of device.features) {
      // t_device_feature.min / max are NOT NULL in the core.
      assert.equal(typeof feature.min, 'number', `${feature.name} needs a min`);
      assert.equal(typeof feature.max, 'number', `${feature.name} needs a max`);
      assert.equal(feature.read_only, true);
      assert.ok(!ids.has(feature.external_id), `duplicate feature ${feature.external_id}`);
      ids.add(feature.external_id);
    }
  }
  // 2 departures x (minutes + route) + summary.
  const stop = buildDiscoveredDevices(gladys, config)[1];
  assert.equal(stop.features.length, 5);
});

test('feature names follow the configured language', () => {
  const gladys = createFakeGladys();
  const english = normalizeConfig({ ...config, language: 'en' });
  const [metro, stop] = buildDiscoveredDevices(gladys, english);
  assert.equal(metro.name, 'STM metro');
  assert.equal(metro.features[0].name, 'Green line – status');
  assert.equal(stop.features[0].name, 'Next departure');
});

test('polling a bus stop publishes the board, and the sentinel for missing departures', async () => {
  stubFetch(routes());
  const gladys = createFakeGladys();
  await pollDevice(gladys, { external_id: 'stm-bus-stop:52743' }, config);

  const byFeature = Object.fromEntries(
    gladys.published.map((state) => [state.featureExternalId, state.state ?? state.text]),
  );
  assert.equal(byFeature['stm-bus-stop:52743:departure_1'], 3);
  assert.equal(byFeature['stm-bus-stop:52743:departure_1_route'], '24');
  assert.equal(byFeature['stm-bus-stop:52743:departure_2'], NO_DEPARTURE_MINUTES);
  assert.equal(byFeature['stm-bus-stop:52743:departure_2_route'], '');
  assert.equal(byFeature['stm-bus-stop:52743:departures'], '24 3 min');
});

test('polling the metro publishes a status and a message per line', async () => {
  stubFetch(routes({ [ETAT_SERVICE_PATH]: etatService([interruption('2')]) }));
  const gladys = createFakeGladys();
  await pollDevice(gladys, { external_id: 'stm-metro:network' }, config);

  const byFeature = Object.fromEntries(
    gladys.published.map((state) => [state.featureExternalId, state.text]),
  );
  assert.equal(byFeature['stm-metro:network:line_1_status'], 'Normal');
  assert.equal(byFeature['stm-metro:network:line_2_status'], 'Perturbé');
  assert.match(byFeature['stm-metro:network:line_2_message'], /^Interruption de service/);
});

test('polling a BIXI station publishes its counts and status', async () => {
  stubFetch(routes());
  const gladys = createFakeGladys();
  await pollDevice(gladys, { external_id: 'bixi-station:1' }, config);
  const byFeature = Object.fromEntries(
    gladys.published.map((state) => [state.featureExternalId, state.state ?? state.text]),
  );
  assert.equal(byFeature['bixi-station:1:bikes'], 8);
  assert.equal(byFeature['bixi-station:1:electric_bikes'], 2);
  assert.equal(byFeature['bixi-station:1:docks'], 15);
  assert.equal(byFeature['bixi-station:1:status'], 'retour impossible');
});

test('the ticks inside the refresh interval do not read the API again', async () => {
  const calls = stubFetch(routes());
  const gladys = createFakeGladys();
  await pollDevice(gladys, { external_id: 'stm-metro:network' }, config);
  await pollDevice(gladys, { external_id: 'stm-metro:network' }, config);
  assert.equal(calls.filter((call) => call.url.includes(ETAT_SERVICE_PATH)).length, 1);

  // A device just created is read right away, whole.
  const before = gladys.published.length;
  await refreshDeviceNow(gladys, { external_id: 'stm-metro:network' }, config);
  assert.equal(calls.filter((call) => call.url.includes(ETAT_SERVICE_PATH)).length, 2);
  assert.equal(gladys.published.length - before, 8);
});

test('unchanged values are not published twice', async () => {
  stubFetch(routes());
  const gladys = createFakeGladys();
  await pollDevice(gladys, { external_id: 'stm-metro:network' }, config);
  clearPollSchedule();
  clearStmCache();
  const before = gladys.published.length;
  await pollDevice(gladys, { external_id: 'stm-metro:network' }, config);
  assert.equal(gladys.published.length, before);
});

test('a device removed from the configuration is ignored', async () => {
  const calls = stubFetch({});
  await pollDevice(createFakeGladys(), { external_id: 'stm-bus-stop:00000' }, config);
  assert.equal(calls.length, 0);
});

test('the metro is not built when it is not watched', () => {
  const blueprints = buildBlueprints(normalizeConfig({ watch_metro: false, stops: '1' }));
  assert.deepEqual(
    blueprints.map((blueprint) => blueprint.type),
    ['stm-bus-stop'],
  );
});

test('a widget pointing at a device of another kind gets an explanation', () => {
  const gladys = createFakeGladys();
  assert.throws(
    () => findSelectedBlueprint(gladys, 'bixi-station:1', config, 'stm-bus-stop'),
    (err) => err instanceof DeviceSelectionError && /BIXI/.test(err.userMessage.en),
  );
  assert.throws(
    () => findSelectedBlueprint(gladys, '', config, 'stm-bus-stop'),
    DeviceSelectionError,
  );
});

test('test_stm_api reports each API on its own line', async () => {
  stubFetch(routes({ [TRIP_UPDATES_PATH]: { status: 400, body: 'Invalid API Key' } }));
  const message = await ACTIONS.test_stm_api(createFakeGladys(), { config });
  assert.match(message.en, /✔ Metro status/);
  assert.match(message.en, /✖ Bus predictions \(GTFS-RT\): The STM refused the API key/);

  const noKey = await ACTIONS.test_stm_api(createFakeGladys(), {
    config: normalizeConfig({}),
  });
  assert.match(noKey.fr, /Aucune clé/);
});

test('test_stm_api gives the daily request estimate when everything works', async () => {
  stubFetch(routes());
  const message = await ACTIONS.test_stm_api(createFakeGladys(), { config });
  assert.match(message.en, /^STM API OK\. This configuration costs about 2160 requests a day/);
});

test('search_bixi_stations lists the ids to paste', async () => {
  stubFetch(routes());
  const message = await ACTIONS.search_bixi_stations(createFakeGladys(), {
    fields: { query: 'drummond' },
    config,
  });
  assert.match(message.fr, /1 — Drummond \/ de Maisonneuve \(23\)/);
  const tooShort = await ACTIONS.search_bixi_stations(createFakeGladys(), {
    fields: { query: 'd' },
    config,
  });
  assert.match(tooShort.en, /at least 2/);
});
