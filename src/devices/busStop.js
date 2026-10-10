// -----------------------------------------------------------------------------
// Device type: BUS STOP (arrêt d'autobus STM)
//
// One device per stop the user watches. Read-only, refreshed by polling at
// `departures_poll_frequency` (departures are countdowns: they are only useful
// while fresh). Every watched stop reads the same network feed, read once per
// interval (see src/api/stm.js).
//
// Features, for each of the N next departures (N = `max_departures`):
//   - "Departure n"        : minutes to wait     (duration sensor)
//   - "Departure n route"  : "24"                (text sensor)
// plus one "Next departures" text feature summarizing the board
// ("24 3 min · 24 11 min · 747 14 min"), handy for a dashboard tile or a chat
// answer.
//
// None of them keeps an history, and the states that did not move are not even
// published (see stateCache.js): a countdown re-read every minute is the one
// value whose past is worth nothing and whose storage cost is the highest.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { gladysPollFrequency, stopPlatformId } from '../config.js';
import { TEXT_FEATURE_RANGE } from './featureRange.js';
import { changedStates } from './stateCache.js';
import { publishDeviceStates } from './publish.js';
import { fetchDepartures } from '../api/stm.js';

export const DEVICE_TYPE = 'stm-bus-stop';

const logger = createLogger({ name: DEVICE_TYPE });

// A departure further away than this is reported as "no departure": the feed
// only ever predicts the next hour or so anyway.
export const NO_DEPARTURE_MINUTES = 999;

/** Feature key of the n-th departure countdown (n starts at 1). */
export const departureFeatureKey = (rank) => `departure_${rank}`;
/** Feature key of the n-th departure route. */
export const departureRouteFeatureKey = (rank) => `departure_${rank}_route`;
export const SUMMARY_FEATURE = 'departures';

const LABELS = {
  en: {
    departure: (rank) => (rank === 1 ? 'Next departure' : `Departure ${rank}`),
    route: (rank) => (rank === 1 ? 'Next departure route' : `Departure ${rank} route`),
    summary: 'Next departures',
    none: 'No upcoming departure',
    device: 'STM stop',
  },
  fr: {
    departure: (rank) => (rank === 1 ? 'Prochain passage' : `Passage ${rank}`),
    route: (rank) => (rank === 1 ? 'Ligne du prochain passage' : `Ligne du passage ${rank}`),
    summary: 'Prochains passages',
    none: 'Aucun passage à venir',
    device: 'Arrêt STM',
  },
};

/**
 * One-line board: "24 3 min · 24 11 min · 747 14 min".
 * @param {{ route: string, minutes: number }[]} departures
 * @param {string} language
 */
export function formatSummary(departures, language = 'fr') {
  if (departures.length === 0) {
    return LABELS[language].none;
  }
  return departures.map((departure) => `${departure.route} ${departure.minutes} min`).join(' · ');
}

/**
 * Default device name when the user did not give one: the stop code plus the
 * route filter, e.g. "Arrêt STM 51003 (24)".
 * @param {{ id: string, routes: string[], name: string | null }} stop
 * @param {string} language
 */
function deviceName(stop, language) {
  if (stop.name) {
    return stop.name;
  }
  const routes = stop.routes.length > 0 ? ` (${stop.routes.join(', ')})` : '';
  return `${LABELS[language].device} ${stop.id}${routes}`;
}

/**
 * The blueprint of one watched stop. Built per configured entry (see
 * src/devices/index.js), because how many stops exist is a user decision.
 *
 * @param {{ id: string, routes: string[], name: string | null }} stop
 */
export function createBusStopBlueprint(stop) {
  // The route filter is part of the platform id: watching the same stop twice
  // with two different filters must yield two distinct devices.
  const platformId = stopPlatformId(stop);

  return {
    key: `${DEVICE_TYPE}:${platformId}`,
    type: DEVICE_TYPE,
    stop,

    deviceExternalId(gladys) {
      return gladys.externalIds(DEVICE_TYPE, platformId).device;
    },

    pollIntervalMs(config) {
      return config.departures_poll_frequency * 1000;
    },

    buildDevice(gladys, config) {
      const ids = gladys.externalIds(DEVICE_TYPE, platformId);
      const labels = LABELS[config.language];
      const features = [];

      for (let rank = 1; rank <= config.max_departures; rank += 1) {
        features.push({
          name: labels.departure(rank),
          external_id: ids.feature(departureFeatureKey(rank)),
          category: DEVICE_FEATURE_CATEGORIES.DURATION,
          type: DEVICE_FEATURE_TYPES.DURATION.INTEGER,
          unit: DEVICE_FEATURE_UNITS.MINUTES,
          min: 0,
          max: NO_DEPARTURE_MINUTES,
          read_only: true,
          has_feedback: false,
          // A countdown re-read every minute: its history is the shape of
          // every timetable, and would write thousands of rows a day.
          keep_history: false,
        });
        features.push({
          name: labels.route(rank),
          external_id: ids.feature(departureRouteFeatureKey(rank)),
          category: DEVICE_FEATURE_CATEGORIES.TEXT,
          type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
          ...TEXT_FEATURE_RANGE,
          read_only: true,
          has_feedback: false,
          keep_history: false,
        });
      }

      features.push({
        name: labels.summary,
        external_id: ids.feature(SUMMARY_FEATURE),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        ...TEXT_FEATURE_RANGE,
        read_only: true,
        has_feedback: false,
        keep_history: false,
      });

      return {
        name: deviceName(stop, config.language),
        external_id: ids.device,
        // Gladys calls onPoll at this interval, in milliseconds, and only
        // accepts the values its own scheduler knows: the configured refresh
        // interval is honored by pollSchedule.js, not by this field.
        poll_frequency: gladysPollFrequency(config.departures_poll_frequency),
        // `should_poll` is what actually schedules the device: the core only
        // inserts it in its poll scheduler when the flag is set at creation.
        should_poll: true,
        params: [
          { name: 'stop_code', value: stop.id },
          { name: 'routes', value: stop.routes.join(',') },
          { name: 'source', value: 'api.stm.info' },
        ],
        features,
      };
    },

    /**
     * The upcoming departures of the stop, soonest first, route filter
     * applied. Shared by the poll, the dashboard widget and the scene action,
     * so the three always agree on what "the next bus" is.
     */
    read(config) {
      return fetchDepartures(config, stop);
    },

    async onPoll(gladys, config) {
      const ids = gladys.externalIds(DEVICE_TYPE, platformId);
      const departures = await this.read(config);

      logger.info(`Stop ${platformId}: ${departures.length} departure(s) upcoming`);

      const states = [
        {
          device_feature_external_id: ids.feature(SUMMARY_FEATURE),
          text: formatSummary(departures.slice(0, config.max_departures), config.language),
        },
      ];

      for (let rank = 1; rank <= config.max_departures; rank += 1) {
        const departure = departures[rank - 1];
        states.push({
          device_feature_external_id: ids.feature(departureFeatureKey(rank)),
          // A sentinel rather than nothing: a stale "2 min" left over from the
          // last read would read as a bus that is never coming.
          state: departure
            ? Math.min(departure.minutes, NO_DEPARTURE_MINUTES)
            : NO_DEPARTURE_MINUTES,
        });
        states.push({
          device_feature_external_id: ids.feature(departureRouteFeatureKey(rank)),
          text: departure ? departure.route : '',
        });
      }

      const updates = changedStates(states);
      if (updates.length > 0) {
        await publishDeviceStates(gladys, ids.device, updates);
      }
      // The whole board, not the published slice: the scene triggers watch
      // every route of the stop (see src/scenes/triggers.js).
      return departures;
    },
  };
}
