// -----------------------------------------------------------------------------
// Scene triggers (computed between two polls) and scene actions.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { restoreFetch, stubFetch } from './helpers/stubFetch.js';
import { etatService, interruption } from './helpers/fixtures.js';
import { encodeFeed } from './helpers/gtfsRealtimeEncoder.js';
import { normalizeConfig } from '../src/config.js';
import { pollDevice } from '../src/devices/index.js';
import { clearPollSchedule } from '../src/devices/pollSchedule.js';
import { clearStateCache } from '../src/devices/stateCache.js';
import { clearReadings } from '../src/devices/readings.js';
import {
  bixiStationEvents,
  clearSceneMemory,
  departureCrossings,
  metroEvents,
  SCENE_TRIGGERS,
} from '../src/scenes/triggers.js';
import { SCENE_ACTIONS } from '../src/scenes/actions.js';
import { clearStmCache, TRIP_UPDATES_PATH } from '../src/api/stm.js';
import { ETAT_SERVICE_PATH, METRO_STATUS } from '../src/api/metro.js';

const config = normalizeConfig({ stm_api_key: 'k', stops: '52743' });

beforeEach(() => {
  clearPollSchedule();
  clearStateCache();
  clearReadings();
  clearSceneMemory();
  clearStmCache();
});
afterEach(() => restoreFetch());

const bus = (tripId, minutes, route = '24') => ({ tripId, route, minutes });

test('a bus is followed by its trip: every threshold it crosses fires once', () => {
  assert.deepEqual(
    departureCrossings([bus('A', 11)], [bus('A', 4)]).map((crossing) => crossing.threshold),
    [5, 10],
  );
  // The next bus taking the place of the one that left is not a crossing.
  assert.deepEqual(departureCrossings([bus('A', 1)], [bus('B', 9)]), []);
  // A bus appearing on the board did not approach.
  assert.deepEqual(departureCrossings([], [bus('A', 2)]), []);
});

test('metro events: one per line whose status changed, unknown is a hole', () => {
  const lines = (statuses) =>
    Object.entries(statuses).map(([id, status]) => ({
      id,
      status,
      message: '',
      name: { en: id, fr: id },
    }));
  const { NORMAL, DISRUPTED, NOTICE, UNKNOWN } = METRO_STATUS;
  assert.deepEqual(
    metroEvents(
      { lines: lines({ 1: NORMAL, 2: DISRUPTED, 4: NORMAL, 5: DISRUPTED }) },
      { lines: lines({ 1: DISRUPTED, 2: NORMAL, 4: NOTICE, 5: UNKNOWN }) },
    ).map(({ line, event }) => [line.id, event]),
    [
      ['1', 'disrupted'],
      ['2', 'restored'],
      ['4', 'notice'],
    ],
  );
});

test('BIXI events', () => {
  assert.deepEqual(bixiStationEvents({ bikes: 2, docks: 0 }, { bikes: 0, docks: 2 }), [
    'no_bike',
    'docks_back',
  ]);
  assert.deepEqual(bixiStationEvents({ installed: true }, { installed: false }), [
    'out_of_service',
  ]);
  assert.deepEqual(bixiStationEvents({}, { bikes: 0 }), []);
});

test('the metro trigger fires on the second poll, never on the first', async () => {
  const gladys = createFakeGladys();
  stubFetch({ [ETAT_SERVICE_PATH]: etatService() });
  await pollDevice(gladys, { external_id: 'stm-metro:network' }, config);
  assert.deepEqual(gladys.sceneEvents, []);

  restoreFetch();
  stubFetch({ [ETAT_SERVICE_PATH]: etatService([interruption('2')]) });
  clearPollSchedule();
  await pollDevice(gladys, { external_id: 'stm-metro:network' }, config);
  assert.equal(gladys.sceneEvents.length, 1);
  assert.equal(gladys.sceneEvents[0].key, SCENE_TRIGGERS.METRO_STATUS_CHANGED);
  assert.deepEqual(
    { ...gladys.sceneEvents[0].data, message: undefined },
    { line: '2', line_name: 'Ligne orange', event: 'disrupted', message: undefined },
  );
});

test('the departure trigger carries the stop device and the threshold as a string', async () => {
  const gladys = createFakeGladys();
  const now = Math.floor(Date.now() / 1000);
  const feedAt = (seconds) =>
    encodeFeed({
      entities: [
        {
          tripUpdate: {
            trip: { tripId: 'T1', routeId: '24' },
            stopTimeUpdates: [{ stopId: '52743', departure: { time: now + seconds } }],
          },
        },
      ],
    });
  stubFetch({ [TRIP_UPDATES_PATH]: feedAt(7 * 60 + 30) });
  await pollDevice(gladys, { external_id: 'stm-bus-stop:52743' }, config);
  restoreFetch();
  stubFetch({ [TRIP_UPDATES_PATH]: feedAt(4 * 60 + 30) });
  clearPollSchedule();
  clearStmCache();
  await pollDevice(gladys, { external_id: 'stm-bus-stop:52743' }, config);

  assert.deepEqual(gladys.sceneEvents, [
    {
      key: SCENE_TRIGGERS.DEPARTURE_APPROACHING,
      data: {
        stop: 'stm-bus-stop:52743',
        stop_name: 'Bus – arrêt 52743',
        route: '24',
        threshold: '5',
        minutes: 4,
      },
    },
  ]);
});

test('scene action get_next_departures reads now and filters by route', async () => {
  const now = Math.floor(Date.now() / 1000);
  stubFetch({
    [TRIP_UPDATES_PATH]: encodeFeed({
      entities: [
        {
          tripUpdate: {
            trip: { tripId: 'A', routeId: '747' },
            stopTimeUpdates: [{ stopId: '52743', departure: { time: now + 90 } }],
          },
        },
        {
          tripUpdate: {
            trip: { tripId: 'B', routeId: '24' },
            stopTimeUpdates: [{ stopId: '52743', departure: { time: now + 400 } }],
          },
        },
      ],
    }),
  });
  const outputs = await SCENE_ACTIONS.get_next_departures(createFakeGladys(), {
    fields: { stop: 'stm-bus-stop:52743', route: '24' },
    config,
  });
  assert.deepEqual(outputs, {
    route: '24',
    minutes: 6,
    following_minutes: null,
    summary: '24 6 min',
    count: 1,
  });
});

test('scene action get_metro_status', async () => {
  stubFetch({ [ETAT_SERVICE_PATH]: etatService([interruption('5')]) });
  const outputs = await SCENE_ACTIONS.get_metro_status(createFakeGladys(), {
    fields: { line: '5' },
    config,
  });
  assert.equal(outputs.line_name, 'Ligne bleue');
  assert.equal(outputs.status, 'disrupted');
  assert.equal(outputs.status_label, 'Perturbé');
  assert.equal(outputs.normal, false);

  await assert.rejects(
    SCENE_ACTIONS.get_metro_status(createFakeGladys(), {
      fields: { line: '5' },
      config: normalizeConfig({ watch_metro: false }),
    }),
    /metro is not watched/,
  );
});
