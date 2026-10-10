// -----------------------------------------------------------------------------
// BIXI GBFS client. The payloads follow the live BIXI feed (GBFS 2.2), where
// the station flags are 0/1 integers rather than booleans.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearBixiCache,
  feedUrl,
  fetchStation,
  fold,
  mergeStations,
  searchStations,
} from '../src/api/bixi.js';
import { normalizeConfig } from '../src/config.js';
import { restoreFetch, stubFetch } from './helpers/stubFetch.js';
import { bixiRoutes, DISCOVERY } from './helpers/fixtures.js';

const config = normalizeConfig({ bixi_stations: '1' });

beforeEach(() => clearBixiCache());
afterEach(() => restoreFetch());

test('a station joins its information and its live counts, flags read as 0/1', async () => {
  stubFetch(bixiRoutes());
  const station = await fetchStation(config, { id: '1' });
  assert.deepEqual(station, {
    id: '1',
    name: 'Drummond / de Maisonneuve',
    capacity: 23,
    lat: 45.4996545,
    lon: -73.5763353,
    bikes: 8,
    electricBikes: 2,
    docks: 15,
    installed: true,
    renting: true,
    returning: false,
    lastReported: 1791644363,
  });
});

test('the feeds of the configured language are preferred, others will do', () => {
  assert.equal(
    feedUrl(DISCOVERY, 'station_status', 'en'),
    'https://gbfs.example/en/station_status.json',
  );
  assert.equal(
    feedUrl({ data: { en: DISCOVERY.data.en } }, 'station_status', 'fr'),
    'https://gbfs.example/en/station_status.json',
  );
  assert.throws(() => feedUrl({ data: {} }, 'station_status', 'fr'), /no "station_status"/);
});

test('the network files are read once for every station of a cycle', async () => {
  const calls = stubFetch(bixiRoutes());
  await fetchStation(config, { id: '1' }, { now: 1000 });
  await fetchStation(config, { id: '2' }, { now: 2000 });
  assert.equal(calls.length, 3);
  // The live counts expire with the refresh interval, the station list later.
  await fetchStation(config, { id: '1' }, { now: 1000 + config.bixi_poll_frequency * 1000 });
  assert.equal(calls.length, 4);
});

test('a station missing from the feed is a removed station, not a failed read', async () => {
  stubFetch(bixiRoutes());
  const station = await fetchStation(config, { id: '999' });
  assert.equal(station.absent, true);
  assert.equal(station.installed, false);
  assert.equal(station.bikes, 0);
});

test('an empty network is a broken feed, not every station removed', async () => {
  stubFetch({
    ...bixiRoutes(),
    'fr/station_status.json': { data: { stations: [] } },
    'fr/station_information.json': { data: { stations: [] } },
  });
  await assert.rejects(fetchStation(config, { id: '1' }), /lists no station/);
});

test('the search ignores case and accents', async () => {
  stubFetch(bixiRoutes());
  const results = await searchStations(config, 'cote des neiges');
  assert.deepEqual(
    results.map((station) => station.id),
    ['2'],
  );
  assert.equal(fold('Côte-des-Neiges'), 'cote des neiges');
});

test('mergeStations tolerates a status for a station missing from the list', () => {
  const stations = mergeStations({ data: {} }, { data: { stations: [{ station_id: 7 }] } });
  assert.equal(stations.get('7').name, '7');
  assert.equal(stations.get('7').bikes, undefined);
});
