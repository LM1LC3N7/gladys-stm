// -----------------------------------------------------------------------------
// Dashboard widgets: every content must pass the SDK's own validator (the
// vocabulary and the budget the core enforces), and no failure may reach the
// dashboard as an exception.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { restoreFetch, stubFetch } from './helpers/stubFetch.js';
import { bixiRoutes, etatService, interruption, stopTimesPayload } from './helpers/fixtures.js';
import { encodeFeed } from './helpers/gtfsRealtimeEncoder.js';
import { normalizeConfig } from '../src/config.js';
import { clearReadings } from '../src/devices/readings.js';
import { clearStmCache, TRIP_UPDATES_PATH } from '../src/api/stm.js';
import { clearBixiCache } from '../src/api/bixi.js';
import { bixiStationContent, departuresContent } from '../src/widgets/index.js';
import { absentStation } from '../src/api/bixi.js';
import { ETAT_SERVICE_PATH } from '../src/api/metro.js';
import { truncate, WIDGETS } from '../src/widgets/index.js';

const config = normalizeConfig({ stm_api_key: 'k', stops: '52743', bixi_stations: '1' });

function routes(extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    [TRIP_UPDATES_PATH]: encodeFeed({
      entities: Array.from({ length: 12 }, (_, index) => ({
        tripUpdate: {
          trip: { tripId: `T${index}`, routeId: index % 2 ? '24' : '747' },
          stopTimeUpdates: [
            {
              stopId: '52743',
              departure: { time: now + index * 240, delay: index === 3 ? 600 : 0 },
            },
          ],
        },
      })),
    }),
    [ETAT_SERVICE_PATH]: etatService([interruption('2', 'x'.repeat(600))]),
    ...bixiRoutes(),
    ...extra,
  };
}

function assertValid(content) {
  assert.deepEqual(validateWidgetContent(content), []);
}

beforeEach(() => {
  clearReadings();
  clearStmCache();
  clearBixiCache();
});
afterEach(() => restoreFetch());

test('the departures board is valid and capped', async () => {
  stubFetch(routes());
  const content = await WIDGETS.departures(createFakeGladys(), {
    settings: { stop: 'stm-bus-stop:52743' },
    config,
  });
  assertValid(content);
  const board = content.components.find((component) => component.type === 'status');
  assert.equal(board.items.length, 8);
  assert.equal(board.items[3].color, 'warning');
});

test('the metro card is valid, and truncates a long message to the budget', async () => {
  stubFetch(routes());
  const content = await WIDGETS.metro_status(createFakeGladys(), { settings: {}, config });
  assertValid(content);
  const status = content.components.find((component) => component.type === 'status');
  assert.deepEqual(
    status.items.map((item) => item.color),
    ['success', 'danger', 'success', 'success'],
  );
});

test('the BIXI card is valid', async () => {
  stubFetch(routes());
  const content = await WIDGETS.bixi_station(createFakeGladys(), {
    settings: { station: 'bixi-station:1' },
    config,
  });
  assertValid(content);
});

test('failures become a card that says what is wrong', async () => {
  stubFetch(routes({ [ETAT_SERVICE_PATH]: { status: 400, body: 'Invalid API Key' } }));
  const refused = await WIDGETS.metro_status(createFakeGladys(), { settings: {}, config });
  assertValid(refused);
  assert.match(refused.components[0].text.en, /refused the API key/);

  const unset = await WIDGETS.departures(createFakeGladys(), { settings: {}, config });
  assertValid(unset);
  assert.match(unset.components[0].text.en, /Choose a bus stop/);

  const notWatched = await WIDGETS.metro_status(createFakeGladys(), {
    settings: {},
    config: normalizeConfig({ watch_metro: false }),
  });
  assert.match(notWatched.components[0].text.fr, /pas surveillé/);
});

test('a slow API gets a loading card rather than a dashboard error', async () => {
  // An answer that comes, but long after the card's deadline.
  globalThis.fetch = () =>
    new Promise((resolve) =>
      setTimeout(() => resolve({ ok: false, status: 503, text: async () => '' }), 100),
    );
  const content = await WIDGETS.metro_status(
    createFakeGladys(),
    { settings: {}, config },
    { deadlineMs: 10 },
  );
  assertValid(content);
  assert.match(content.components[0].text.en, /longer than usual/);
});

test('truncate', () => {
  assert.equal(truncate('abc', 5), 'abc');
  assert.equal(truncate('abcdef', 5), 'abcd…');
});

test('a scheduled board is grey, marked "~", and says what a key adds', async () => {
  stubFetch({
    '/v5/stoptimes': stopTimesPayload(Date.now(), [
      { minutes: 5 },
      { minutes: 20, route: '107', headsign: 'Nord' },
    ]),
  });
  const content = await WIDGETS.departures(createFakeGladys(), {
    settings: { stop: 'stm-bus-stop:52743' },
    config: normalizeConfig({ stops: '52743' }),
  });
  assertValid(content);
  const board = content.components.find((component) => component.type === 'status');
  assert.deepEqual(
    board.items.map((item) => [item.label.fr, item.color]),
    [
      ['Ligne 61 → Est', 'neutral'],
      ['Ligne 107 → Nord', 'neutral'],
    ],
  );
  assert.match(board.items[0].value, /^~[45] min$/);
  assert.match(content.components.at(-1).text.fr, /clé STM pour le temps réel/);
});

test('an empty board says so', () => {
  const content = departuresContent('Arrêt', []);
  assertValid(content);
  assert.match(content.components[1].text.fr, /Aucun passage/);
});

test('a removed BIXI station gets a card that says so, not three zeros', () => {
  const content = bixiStationContent('BIXI – Peel / Notre-Dame', absentStation('974'));
  assertValid(content);
  assert.equal(
    content.components.some((component) => component.type === 'value'),
    false,
  );
  assert.match(content.components[1].text.fr, /retirée pour l’hiver/);
});
