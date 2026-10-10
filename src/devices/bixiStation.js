// -----------------------------------------------------------------------------
// Device type: BIXI STATION
//
// One device per BIXI station the user watches. Read-only, refreshed at
// `bixi_poll_frequency` from the open GBFS feed (no key, no quota).
//
// Features:
//   - Bikes          : bikes available, e-bikes included (counter sensor)
//   - Electric bikes : e-bikes available                  (counter sensor)
//   - Free docks     : docks available                    (counter sensor)
//   - Status         : OK / no bike / no dock / out of service (text sensor)
//
// The counts keep an history: "is there still a bike at 8:15 on weekdays" is
// what a week of curve answers.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
} from '@gladysassistant/integration-sdk';
import { gladysPollFrequency } from '../config.js';
import { TEXT_FEATURE_RANGE } from './featureRange.js';
import { changedStates } from './stateCache.js';
import { publishDeviceStates } from './publish.js';
import { fetchStation, knownStationName } from '../api/bixi.js';

export const DEVICE_TYPE = 'bixi-station';

const logger = createLogger({ name: DEVICE_TYPE });

/** Feature keys. Never rename one: Gladys keys the history on them. */
export const FEATURE = {
  BIKES: 'bikes',
  ELECTRIC_BIKES: 'electric_bikes',
  DOCKS: 'docks',
  STATUS: 'status',
};

// The largest BIXI stations hold a few dozen docks; the gauge only needs a
// ceiling no station reaches.
const MAX_COUNT = 200;

/** What every BIXI station device name starts with (see busStop.js). */
export const NAME_PREFIX = 'BIXI – ';

const LABELS = {
  en: {
    station: 'station',
    bikes: 'Bikes',
    electricBikes: 'Electric bikes',
    docks: 'Free docks',
    status: 'Status',
  },
  fr: {
    station: 'station',
    bikes: 'Vélos',
    electricBikes: 'Vélos électriques',
    docks: 'Points d’ancrage libres',
    status: 'État',
  },
};

const STATUS_TEXT = {
  en: {
    ok: 'OK',
    outOfService: 'Out of service',
    noRental: 'no rental',
    noReturn: 'no return',
    noBike: 'no bike',
    noDock: 'no free dock',
  },
  fr: {
    ok: 'OK',
    outOfService: 'Hors service',
    noRental: 'location impossible',
    noReturn: 'retour impossible',
    noBike: 'aucun vélo',
    noDock: 'aucun point d’ancrage libre',
  },
};

/**
 * The state of a station, in one language.
 * @param {{ installed: boolean, renting: boolean, returning: boolean,
 *   bikes?: number, docks?: number }} station
 * @param {string} language
 */
export function formatStatus(station, language = 'fr') {
  const text = STATUS_TEXT[language];
  if (!station.installed) {
    return text.outOfService;
  }
  const issues = [];
  if (!station.renting) issues.push(text.noRental);
  if (!station.returning) issues.push(text.noReturn);
  if (station.bikes === 0) issues.push(text.noBike);
  if (station.docks === 0) issues.push(text.noDock);
  return issues.length === 0 ? text.ok : issues.join(', ');
}

/**
 * The fill of a station, in percent of its docks holding a bike.
 * @param {{ bikes?: number, docks?: number }} station
 * @returns {number | null}
 */
export function computeOccupancy(station) {
  if (!Number.isFinite(station.bikes) || !Number.isFinite(station.docks)) {
    return null;
  }
  const total = station.bikes + station.docks;
  return total > 0 ? Math.round((station.bikes / total) * 100) : null;
}

/**
 * Device name when the user did not give one: "BIXI – " then the station name
 * (from the suggestion, else from the last read of the network), else its id.
 * @param {{ id: string, name: string | null, label?: string }} station
 * @param {string} language
 */
export function deviceName(station, language) {
  if (station.name) {
    return station.name;
  }
  const place = station.label || knownStationName(station.id);
  return `${NAME_PREFIX}${place || `${LABELS[language].station} ${station.id}`}`;
}

/**
 * The blueprint of one watched station.
 * @param {{ id: string, name: string | null }} station
 */
export function createBixiStationBlueprint(station) {
  return {
    key: `${DEVICE_TYPE}:${station.id}`,
    type: DEVICE_TYPE,
    station,

    deviceExternalId(gladys) {
      return gladys.externalIds(DEVICE_TYPE, station.id).device;
    },

    pollIntervalMs(config) {
      return config.bixi_poll_frequency * 1000;
    },

    buildDevice(gladys, config) {
      const ids = gladys.externalIds(DEVICE_TYPE, station.id);
      const labels = LABELS[config.language];
      const counter = (key, name) => ({
        name,
        external_id: ids.feature(key),
        category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
        min: 0,
        max: MAX_COUNT,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      });

      return {
        name: deviceName(station, config.language),
        external_id: ids.device,
        poll_frequency: gladysPollFrequency(config.bixi_poll_frequency),
        should_poll: true,
        params: [
          { name: 'station_id', value: station.id },
          { name: 'source', value: 'gbfs.velobixi.com' },
        ],
        features: [
          counter(FEATURE.BIKES, labels.bikes),
          counter(FEATURE.ELECTRIC_BIKES, labels.electricBikes),
          counter(FEATURE.DOCKS, labels.docks),
          {
            name: labels.status,
            external_id: ids.feature(FEATURE.STATUS),
            category: DEVICE_FEATURE_CATEGORIES.TEXT,
            type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
            ...TEXT_FEATURE_RANGE,
            read_only: true,
            has_feedback: false,
            keep_history: false,
          },
        ],
      };
    },

    /** The live counts of the station (see src/api/bixi.js). */
    read(config) {
      return fetchStation(config, station);
    },

    async onPoll(gladys, config) {
      const ids = gladys.externalIds(DEVICE_TYPE, station.id);
      const live = await this.read(config);

      logger.info(
        `BIXI ${station.id}: ${live.bikes ?? '?'} bike(s), ${live.docks ?? '?'} free dock(s)`,
      );

      const states = [];
      const pushCount = (key, value) => {
        // A count the feed did not send is left alone rather than published
        // as 0: "no information" is not "no bike".
        if (Number.isFinite(value)) {
          states.push({ device_feature_external_id: ids.feature(key), state: value });
        }
      };
      pushCount(FEATURE.BIKES, live.bikes);
      pushCount(FEATURE.ELECTRIC_BIKES, live.electricBikes);
      pushCount(FEATURE.DOCKS, live.docks);
      states.push({
        device_feature_external_id: ids.feature(FEATURE.STATUS),
        text: formatStatus(live, config.language),
      });

      const updates = changedStates(states);
      if (updates.length > 0) {
        await publishDeviceStates(gladys, ids.device, updates);
      }
      return live;
    },
  };
}
