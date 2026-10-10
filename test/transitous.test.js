// -----------------------------------------------------------------------------
// Transitous client: stops near a point, search, timetable, descriptions.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearTransitousCache,
  describeStop,
  distanceMeters,
  formatRoutes,
  knownStop,
  scheduledDepartures,
  searchStops,
  stmStopCode,
  stopsNear,
  stopTimes,
  tidyName,
  TransitousError,
} from '../src/api/transitous.js';
import { GEOCODE, MAP_STOPS, stopTimesPayload } from './helpers/fixtures.js';
import { restoreFetch, stubFetch } from './helpers/stubFetch.js';

const HOME = { lat: 45.4954, lon: -73.5627 };
const NOW = Date.UTC(2026, 9, 10, 16, 0, 0);

beforeEach(() => clearTransitousCache());
afterEach(() => restoreFetch());

test('only STM bus stops have a stop code', () => {
  assert.equal(stmStopCode('ca-qc-STM_52743'), '52743');
  assert.equal(stmStopCode('ca-qc-STM_STATION_M146'), null);
  assert.equal(stmStopCode('ca-qc-STM_9999111'), null);
  assert.equal(stmStopCode('ca-qc-Exo-citsud_74213'), null);
  assert.equal(stmStopCode(undefined), null);
});

test('the stops near a point: STM buses only, within the radius, closest first', async () => {
  const calls = stubFetch({ '/v1/map/stops': MAP_STOPS });
  const stops = await stopsNear(HOME, 600);
  assert.deepEqual(
    stops.map((stop) => stop.code),
    ['52743', '52744', '62053'],
  );
  assert.ok(stops[0].distance < stops[2].distance);
  assert.match(calls[0].url, /min=45\.49\d+,-73\.57\d+&max=45\.50\d+,-73\.55\d+/);
  assert.match(calls[0].headers['User-Agent'], /^gladys-stm\/.*github\.com/);
});

test('the search keeps the STM bus stops', async () => {
  stubFetch({ '/v1/geocode': GEOCODE });
  assert.deepEqual(await searchStops('sherbrooke papineau'), [
    { code: '52682', name: 'Papineau / Sherbrooke' },
    { code: '52275', name: 'Peel / Sherbrooke' },
  ]);
});

test('the timetable: cancelled trips dropped, delays computed, routes upper case', async () => {
  stubFetch({
    '/v5/stoptimes': stopTimesPayload(NOW, [
      { minutes: 3, route: '61' },
      { minutes: 7, route: '107', headsign: 'Nord', delayMinutes: 2 },
      { minutes: 9, cancelled: true },
    ]),
  });
  const { name, departures } = await stopTimes('52743');
  assert.equal(name, 'École de technologie supérieure (Peel / Notre-Dame');
  assert.deepEqual(
    departures.map(({ route, headsign, delaySeconds, realtime }) => [
      route,
      headsign,
      delaySeconds,
      realtime,
    ]),
    [
      ['61', 'Est', 0, false],
      ['107', 'Nord', 120, false],
    ],
  );
});

test('scheduled departures have the shape of the real-time board', async () => {
  stubFetch({
    '/v5/stoptimes': stopTimesPayload(NOW, [
      { minutes: -5 },
      { minutes: 4, route: '107', headsign: 'Nord' },
      { minutes: 2 },
    ]),
  });
  const board = await scheduledDepartures({ id: '52743', routes: [] }, { now: NOW });
  assert.deepEqual(
    board.map(({ route, minutes, realtime, headsign }) => [route, minutes, realtime, headsign]),
    [
      ['61', 2, false, 'Est'],
      ['107', 4, false, 'Nord'],
    ],
  );
  const filtered = await scheduledDepartures({ id: '52743', routes: ['107'] }, { now: NOW });
  assert.deepEqual(
    filtered.map((departure) => departure.route),
    ['107'],
  );
});

test('a stop description is cached for a day, and survives a failed refresh', async () => {
  const calls = stubFetch({
    '/v5/stoptimes': stopTimesPayload(NOW, [
      { minutes: 1, route: '107', headsign: 'Nord' },
      { minutes: 2, route: '61' },
      { minutes: 3, route: '61' },
    ]),
  });
  const description = await describeStop('52743', { now: NOW });
  assert.equal(formatRoutes(description), '61 → Est, 107 → Nord');
  await describeStop('52743', { now: NOW + 3_600_000 });
  assert.equal(calls.length, 1);
  assert.equal(knownStop('52743').name, 'École de technologie supérieure (Peel / Notre-Dame)');

  restoreFetch();
  stubFetch({ '/v5/stoptimes': { status: 503, body: 'down' } });
  const stale = await describeStop('52743', { now: NOW + 2 * 86_400_000 });
  assert.equal(stale, description);
  assert.equal(await describeStop('11111', { now: NOW }), null);
});

test('an unavailable Transitous is a TransitousError', async () => {
  stubFetch({ '/v1/geocode': { status: 429, body: 'slow down' } });
  await assert.rejects(searchStops('x'), TransitousError);
});

test('a route serving both directions lists both, and names are tidied', async () => {
  stubFetch({
    '/v5/stoptimes': stopTimesPayload(NOW, [
      { minutes: 1, headsign: 'Ouest' },
      { minutes: 2, headsign: 'Est' },
      { minutes: 3, headsign: 'Ouest' },
    ]),
  });
  assert.equal(formatRoutes(await describeStop('52743', { now: NOW })), '61 → Ouest/Est');
  assert.equal(tidyName('A (B'), 'A (B)');
  assert.equal(tidyName('A (B)'), 'A (B)');
});

test('distances', () => {
  assert.equal(distanceMeters(HOME, HOME), 0);
  const oneKmNorth = { lat: HOME.lat + 1 / 111.2, lon: HOME.lon };
  assert.ok(Math.abs(distanceMeters(HOME, oneKmNorth) - 1000) < 5);
});
