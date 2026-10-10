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
      { station_id: '1', name: 'Drummond / de Maisonneuve', short_name: '6001', capacity: 23 },
      { station_id: '2', name: 'Métro Côte-des-Neiges', capacity: 31 },
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
