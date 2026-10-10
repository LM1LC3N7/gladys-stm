// -----------------------------------------------------------------------------
// Configuration: defaults, type coercion, watch-list mini-syntax.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  departuresSource,
  metroEnabled,
  estimatedDailyRequests,
  gladysPollFrequency,
  hasStmApiKey,
  normalizeConfig,
  parseSimpleEntry,
  parseStopEntry,
  stopPlatformId,
} from '../src/config.js';

test('an empty configuration gets the defaults and watches the metro only', () => {
  const config = normalizeConfig();
  assert.equal(config.departures_poll_frequency, DEFAULT_CONFIG.departures_poll_frequency);
  assert.equal(config.language, 'fr');
  assert.deepEqual(config.watched, { stops: [], bixiStations: [], metro: true });
  assert.equal(hasStmApiKey(config), false);
  // Without a key: the timetable for the buses, and no metro (STM API only).
  assert.equal(departuresSource(config), 'schedule');
  assert.equal(metroEnabled(config), false);
  assert.equal(config.nearby_bus_stops, 3);
  assert.equal(config.nearby_bixi_stations, 2);
});

test('the stop syntax: code, route filter, custom name', () => {
  assert.deepEqual(parseStopEntry('52743'), { id: '52743', routes: [], name: null });
  assert.deepEqual(parseStopEntry(' 51003 @ 24 | 747 : Bus du travail '), {
    id: '51003',
    routes: ['24', '747'],
    name: 'Bus du travail',
  });
  // The name may hold an '@': the name is cut first.
  assert.deepEqual(parseStopEntry('51003:Moi@maison'), {
    id: '51003',
    routes: [],
    name: 'Moi@maison',
  });
  assert.equal(parseStopEntry('@24'), null);
  assert.deepEqual(parseSimpleEntry('42:Maison'), { id: '42', name: 'Maison' });
  assert.equal(parseSimpleEntry(' :x'), null);
});

test('lists accept commas, semicolons and new lines, and drop duplicates', () => {
  const config = normalizeConfig({
    stops: '52743;51003@24\n52743, 51003@747',
    bixi_stations: '1, 1:Again, 2',
  });
  assert.deepEqual(config.watched.stops.map(stopPlatformId), ['52743', '51003@24', '51003@747']);
  assert.deepEqual(
    config.watched.bixiStations.map((station) => station.id),
    ['1', '2'],
  );
});

test('numbers, booleans and the language are coerced and bounded', () => {
  const config = normalizeConfig({
    departures_poll_frequency: '5',
    metro_poll_frequency: 'abc',
    bixi_poll_frequency: 99999,
    max_departures: '9',
    watch_metro: 'false',
    language: 'de',
    stm_api_key: '  key  ',
  });
  assert.equal(config.departures_poll_frequency, 30);
  assert.equal(config.metro_poll_frequency, DEFAULT_CONFIG.metro_poll_frequency);
  assert.equal(config.bixi_poll_frequency, 3600);
  assert.equal(config.max_departures, 5);
  assert.equal(config.watched.metro, false);
  assert.equal(config.language, 'fr');
  assert.equal(config.stm_api_key, 'key');
});

test('poll frequencies map onto the values the Gladys scheduler accepts', () => {
  assert.equal(gladysPollFrequency(30), 30_000);
  assert.equal(gladysPollFrequency(60), 60_000);
  assert.equal(gladysPollFrequency(300), 60_000);
});

test('the daily STM request estimate counts one feed read per interval', () => {
  assert.equal(
    estimatedDailyRequests(normalizeConfig({ stm_api_key: 'k', stops: '1, 2, 3' })),
    1440 + 720,
  );
  assert.equal(
    estimatedDailyRequests(normalizeConfig({ stm_api_key: 'k', watch_metro: false })),
    0,
  );
  // The suggested and created stops count too: one feed read serves them all.
  assert.equal(
    estimatedDailyRequests(normalizeConfig({ stm_api_key: 'k', watch_metro: false }), {
      busStops: 4,
    }),
    1440,
  );
  // Without a key, nothing is read from the STM.
  assert.equal(estimatedDailyRequests(normalizeConfig({ stops: '1' })), 0);
  // The most aggressive configuration still fits in the 10,000 daily quota.
  const fastest = normalizeConfig({
    stm_api_key: 'k',
    stops: '1',
    departures_poll_frequency: 30,
    metro_poll_frequency: 30,
  });
  assert.ok(estimatedDailyRequests(fastest) <= 10_000);
});

test('the departures source: STM with a key, timetable without, nothing when turned off', () => {
  assert.equal(departuresSource(normalizeConfig({ stm_api_key: 'k' })), 'stm');
  assert.equal(departuresSource(normalizeConfig({ schedule_without_key: false })), 'none');
  assert.equal(metroEnabled(normalizeConfig({ stm_api_key: 'k' })), true);
});

test('the suggestion counts are bounded, 0 turning them off', () => {
  const config = normalizeConfig({ nearby_bus_stops: '0', nearby_bixi_stations: 99 });
  assert.equal(config.nearby_bus_stops, 0);
  assert.equal(config.nearby_bixi_stations, 8);
  assert.equal(normalizeConfig({ nearby_bus_stops: 'x' }).nearby_bus_stops, 3);
});
