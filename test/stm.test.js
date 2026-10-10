// -----------------------------------------------------------------------------
// STM API client: departures, the shared feed cache, the refusals.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import {
  clearStmCache,
  departuresFromFeed,
  fetchDepartures,
  getTripUpdates,
  stmErrorFor,
  StmApiError,
  TRIP_UPDATES_PATH,
} from '../src/api/stm.js';
import { encodeFeed } from './helpers/gtfsRealtimeEncoder.js';
import { restoreFetch, stubFetch } from './helpers/stubFetch.js';

const NOW_MS = 1_760_100_000_000;
const NOW = NOW_MS / 1000;

const config = normalizeConfig({ stm_api_key: 'k3y', stops: '52743, 51003@24' });

function feed() {
  return encodeFeed({
    timestamp: NOW,
    entities: [
      {
        tripUpdate: {
          trip: { tripId: 'late', routeId: '24' },
          stopTimeUpdates: [{ stopId: '52743', departure: { time: NOW + 600, delay: 400 } }],
        },
      },
      {
        tripUpdate: {
          trip: { tripId: 'soon', routeId: '24' },
          stopTimeUpdates: [
            { stopId: '52743', arrival: { time: NOW + 125 } },
            { stopId: '51003', arrival: { time: NOW + 300 } },
          ],
        },
      },
      {
        tripUpdate: {
          trip: { tripId: 'other-route', routeId: '747' },
          stopTimeUpdates: [{ stopId: '51003', arrival: { time: NOW + 60 } }],
        },
      },
      {
        tripUpdate: {
          trip: { tripId: 'cancelled', routeId: '24', scheduleRelationship: 3 },
          stopTimeUpdates: [{ stopId: '52743', arrival: { time: NOW + 200 } }],
        },
      },
      {
        tripUpdate: {
          trip: { tripId: 'skips', routeId: '24' },
          stopTimeUpdates: [
            { stopId: '52743', scheduleRelationship: 1, arrival: { time: NOW + 90 } },
          ],
        },
      },
      {
        tripUpdate: {
          trip: { tripId: 'gone', routeId: '24' },
          stopTimeUpdates: [{ stopId: '52743', arrival: { time: NOW - 120 } }],
        },
      },
    ],
  });
}

beforeEach(() => clearStmCache());
afterEach(() => restoreFetch());

test('departures are sorted, filtered, and counted in whole minutes', async () => {
  stubFetch({ [TRIP_UPDATES_PATH]: feed() });
  const [stop52743, stop51003] = config.watched.stops;

  const board = await fetchDepartures(config, stop52743, { now: NOW_MS });
  assert.deepEqual(
    board.map((departure) => [departure.tripId, departure.route, departure.minutes]),
    [
      ['soon', '24', 2],
      ['late', '24', 10],
    ],
  );
  assert.equal(board[1].delaySeconds, 400);

  // The route filter keeps the 24 and drops the 747 calling at the same stop.
  const filtered = await fetchDepartures(config, stop51003, { now: NOW_MS });
  assert.deepEqual(
    filtered.map((departure) => departure.tripId),
    ['soon'],
  );
});

test('one read of the feed serves every stop, and sends the key in the apiKey header', async () => {
  const calls = stubFetch({ [TRIP_UPDATES_PATH]: feed() });
  for (const stop of config.watched.stops) {
    await fetchDepartures(config, stop, { now: NOW_MS });
  }
  await fetchDepartures(config, config.watched.stops[0], { now: NOW_MS + 30_000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.apiKey, 'k3y');
  assert.match(calls[0].headers['User-Agent'], /^gladys-stm\//);

  // A new interval reads again; so does a forced fresh read.
  await fetchDepartures(config, config.watched.stops[0], { now: NOW_MS + 60_000 });
  await getTripUpdates(config, { now: NOW_MS + 61_000, fresh: true });
  assert.equal(calls.length, 3);
});

test('a departure just past its time stays on the board for a few seconds', () => {
  const board = departuresFromFeed(
    {
      stopTimes: [
        {
          stopId: '1',
          routeId: '24',
          tripScheduleRelationship: 0,
          scheduleRelationship: 0,
          arrival: { time: NOW - 20 },
        },
      ],
    },
    { id: '1', routes: [] },
    NOW,
  );
  assert.equal(board[0].minutes, 0);
});

test('no key: a bilingual explanation, and no request', async () => {
  const calls = stubFetch({});
  const noKey = normalizeConfig({ stops: '52743' });
  await assert.rejects(fetchDepartures(noKey, noKey.watched.stops[0]), (err) => {
    assert.ok(err instanceof StmApiError);
    assert.match(err.userMessage.fr, /clé d’API STM/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test('the refusals of the API hub become messages the user can act on', async () => {
  stubFetch({ [TRIP_UPDATES_PATH]: { status: 400, body: 'Invalid API Key' } });
  await assert.rejects(fetchDepartures(config, config.watched.stops[0], { now: NOW_MS }), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.userMessage.en, /refused the API key/);
    return true;
  });

  assert.match(stmErrorFor(400, 'Rate limit and/or quota exceeded', '/x').userMessage.en, /quota/);
  assert.match(
    stmErrorFor(429, '{"error.message" : "API level rate limit exceeded"}', '/x').userMessage.en,
    /quota|rate limiting/,
  );
  assert.equal(stmErrorFor(503, 'Service Unavailable', '/x').userMessage, undefined);
});
