// -----------------------------------------------------------------------------
// Payloads shared by the suites. The BIXI ones follow the live feed (GBFS 2.2,
// station flags as 0/1 integers); the i3 ones follow the shape documented by
// the open-source readers of the STM API (see CLAUDE.md).
// -----------------------------------------------------------------------------

import { BIXI_GBFS_URL } from '../../src/api/bixi.js';

export const DISCOVERY = {
  ttl: 10,
  version: '2.2',
  data: {
    en: {
      feeds: [
        { name: 'station_information', url: 'https://gbfs.example/en/station_information.json' },
        { name: 'station_status', url: 'https://gbfs.example/en/station_status.json' },
      ],
    },
    fr: {
      feeds: [
        { name: 'station_information', url: 'https://gbfs.example/fr/station_information.json' },
        { name: 'station_status', url: 'https://gbfs.example/fr/station_status.json' },
      ],
    },
  },
};

export const INFORMATION = {
  data: {
    stations: [
      {
        station_id: '1',
        name: 'Drummond / de Maisonneuve',
        short_name: '6001',
        capacity: 23,
        lat: 45.4996545,
        lon: -73.5763353,
      },
      { station_id: '2', name: 'Métro Côte-des-Neiges', capacity: 31, lat: 45.4955, lon: -73.6224 },
      // 200 m from the ÉTS, the house of the fake Gladys.
      {
        station_id: '3',
        name: 'de la Montagne / Notre-Dame',
        capacity: 19,
        lat: 45.4949,
        lon: -73.565,
      },
    ],
  },
};

export const STATUS = {
  data: {
    stations: [
      {
        station_id: '1',
        num_bikes_available: 8,
        num_ebikes_available: 2,
        num_docks_available: 15,
        is_installed: 1,
        is_renting: 1,
        is_returning: 0,
        last_reported: 1791644363,
      },
      { station_id: '2', num_bikes_available: 0, num_docks_available: 31, is_installed: 0 },
      { station_id: '3', num_bikes_available: 4, num_docks_available: 15, is_installed: 1 },
    ],
  },
};

export function bixiRoutes() {
  return {
    [BIXI_GBFS_URL]: DISCOVERY,
    'fr/station_information.json': INFORMATION,
    'fr/station_status.json': STATUS,
  };
}

const texts = (fr, en = null) => [
  { language: 'fr', text: fr },
  { language: 'en', text: en },
];

/** An i3 payload with the four lines running normally, plus extra alerts. */
export function etatService(extraAlerts = [], timestamp = 1_760_100_000) {
  const normal = (line) => ({
    active_periods: { start: timestamp - 3600, end: null },
    informed_entities: [{ route_short_name: line }],
    header_texts: texts('Métro'),
    description_texts: texts('Service normal du métro', 'Normal métro service'),
  });
  return { header: { timestamp }, alerts: [...['1', '2', '4', '5'].map(normal), ...extraAlerts] };
}

/** An alert interrupting a line. */
export function interruption(line, text = 'Interruption de service. Reprise prévue vers 8 h 30.') {
  return {
    effect: 'NO_SERVICE',
    informed_entities: [{ route_short_name: line }],
    description_texts: texts(text),
  };
}

// --- Transitous ---------------------------------------------------------------
// Shapes captured from api.transitous.org on 2026-10-10 (trimmed to the fields
// the integration reads), around the ÉTS, a public landmark.

/** /v1/map/stops around (45.4954, -73.5627). */
export const MAP_STOPS = [
  // Another network: dropped.
  { name: 'Terminus Centre-Ville', stopId: 'ca-qc-Exo-citsud_74213', lat: 45.4951, lon: -73.5631 },
  {
    name: 'École de technologie supérieure (Peel / Notre-Dame',
    stopId: 'ca-qc-STM_52743',
    stopCode: '52743',
    lat: 45.49541,
    lon: -73.5627,
    modes: ['BUS'],
  },
  {
    name: 'École de technologie supérieure (Peel / Notre-Dame',
    stopId: 'ca-qc-STM_52744',
    stopCode: '52744',
    lat: 45.4956,
    lon: -73.5629,
    modes: ['BUS'],
  },
  // A metro platform: not a bus stop.
  { name: 'STATION BONAVENTURE', stopId: 'ca-qc-STM_9999021', lat: 45.4955, lon: -73.5626 },
  { name: 'Peel / Ottawa', stopId: 'ca-qc-STM_62053', lat: 45.4975, lon: -73.5605 },
  // Beyond 600 m: dropped by the radius.
  { name: 'Peel / Sherbrooke', stopId: 'ca-qc-STM_52275', lat: 45.50176, lon: -73.5733 },
];

/** /v1/geocode?text=sherbrooke papineau&type=STOP */
export const GEOCODE = [
  { type: 'STOP', name: 'Papineau / Sherbrooke', id: 'ca-qc-STM_52682' },
  { type: 'STOP', name: 'Papineau / Loranger', id: 'ca-qc-STS-Sherbrooke_1772' },
  { type: 'STOP', name: 'STATION SHERBROOKE', id: 'ca-qc-STM_STATION_M262' },
  { type: 'STOP', name: 'Peel / Sherbrooke', id: 'ca-qc-STM_52275' },
];

/**
 * /v5/stoptimes for one stop: departures `minutes` from `now` (ms), route 61
 * towards "Est" unless told otherwise.
 */
export function stopTimesPayload(
  now,
  entries,
  name = 'École de technologie supérieure (Peel / Notre-Dame',
) {
  const iso = (ms) => new Date(ms).toISOString();
  return {
    place: { name },
    stopTimes: entries.map(
      (
        { minutes, route = '61', headsign = 'Est', delayMinutes = 0, cancelled = false },
        index,
      ) => ({
        place: {
          name,
          departure: iso(now + (minutes + delayMinutes) * 60_000),
          scheduledDeparture: iso(now + minutes * 60_000),
        },
        realTime: false,
        headsign,
        tripId: `20261010_ca-qc-STM_${route}_${index}`,
        routeShortName: route,
        cancelled,
        tripCancelled: false,
      }),
    ),
  };
}
