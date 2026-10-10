// -----------------------------------------------------------------------------
// Dashboard widgets (manifest `widgets`, Gladys >= 5.1.0).
//
// The devices already put every value on the dashboard, one feature per tile,
// and that is exactly what a departure board is bad at. A widget is a card
// the integration composes itself:
//   - departures   : the board of a bus stop, soonest first;
//   - metro_status : the four lines, colored, with the STM message of any
//                    line that is not running normally;
//   - bixi_station : bikes, e-bikes and docks, the fill gauge, the day's curve.
//
// Each card reads through the same `read` as the poll, and takes the poll's
// last reading while it is younger than the card's own lifetime on the
// dashboard (src/devices/readings.js): a dashboard left open on a tablet must
// not eat the user's STM quota.
//
// Nothing here throws at the dashboard. A device of the wrong kind, a device
// removed from the watch lists or an API that is down all render as a card
// saying so — an empty or failed widget tells the user nothing.
// -----------------------------------------------------------------------------

import {
  createLogger,
  WIDGET_CHART_INTERVALS,
  WIDGET_COLORS,
  WIDGET_TEXT_VARIANTS,
} from '@gladysassistant/integration-sdk';
import {
  DeviceSelectionError,
  deviceName,
  findSelectedBlueprint,
  metroBlueprint,
} from '../devices/index.js';
import { createdFeatures } from '../devices/publish.js';
import { sharedReading } from '../devices/readings.js';
import { DEVICE_TYPE as BUS_STOP_TYPE } from '../devices/busStop.js';
import { STATUS_LABELS } from '../devices/metroStatus.js';
import {
  computeOccupancy,
  DEVICE_TYPE as BIXI_TYPE,
  FEATURE as BIXI_FEATURE,
  formatStatus as formatBixiStatus,
} from '../devices/bixiStation.js';
import { METRO_STATUS } from '../api/metro.js';
import { StmApiError } from '../api/stm.js';

const logger = createLogger({ name: 'widgets' });

/** Keys of the `widgets` declared in the manifest. Never rename one. */
export const WIDGET_KEYS = {
  DEPARTURES: 'departures',
  METRO_STATUS: 'metro_status',
  BIXI_STATION: 'bixi_station',
};

// How long the core may serve a card before pulling it again.
const TTL_SECONDS = {
  [WIDGET_KEYS.DEPARTURES]: 30,
  [WIDGET_KEYS.METRO_STATUS]: 120,
  [WIDGET_KEYS.BIXI_STATION]: 60,
};

// The core waits 15 s for a widget, then shows "data unavailable" until the
// dashboard is reloaded. Past this deadline the card says it is loading, and
// the read keeps going: it is remembered, so the re-pull finds it.
export const PULL_DEADLINE_MS = 9000;
const LOADING_TTL_SECONDS = 15;

// The core caps a status list at ten rows, and a card is read at a glance.
const BOARD_ROWS = 8;
// The content budget of the widget contract (see the SDK's
// validateWidgetContent): a body text holds 300 characters, a heading 40.
const BODY_MAX = 300;
const HEADING_MAX = 40;

const { NEUTRAL, SUCCESS, WARNING, DANGER, INFO } = WIDGET_COLORS;

/** Cut a text to a budget, with an ellipsis when it was longer. */
export function truncate(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Settle with the promise, or with null once the deadline passed.
 * @param {Promise<object>} promise
 * @param {number} deadlineMs
 * @returns {Promise<object|null>}
 */
function withDeadline(promise, deadlineMs) {
  promise.catch((err) => logger.debug(`Widget read failed after the deadline: ${err.message}`));
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), deadlineMs);
    timer.unref?.();
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** A one-paragraph card, for everything that is not data. */
function messageContent(ttlSeconds, message) {
  return {
    ttl_seconds: ttlSeconds,
    components: [{ type: 'text', variant: WIDGET_TEXT_VARIANTS.BODY, text: message }],
  };
}

const heading = (name) => ({
  type: 'text',
  variant: WIDGET_TEXT_VARIANTS.HEADING,
  text: truncate(name, HEADING_MAX),
});

/**
 * The countdown of one departure as the board displays it.
 * @param {number} minutes
 */
function formatMinutes(minutes) {
  return minutes === 0 ? { en: 'Now', fr: 'À l’arrêt' } : `${minutes} min`;
}

/**
 * The card of a bus stop: the next departure as a tile, the board below.
 *
 * @param {string} name
 * @param {{ route: string, minutes: number, delaySeconds?: number }[]} departures
 */
export function departuresContent(name, departures) {
  const components = [heading(name)];
  const [next] = departures;
  if (!next) {
    components.push({
      type: 'text',
      variant: WIDGET_TEXT_VARIANTS.BODY,
      text: { en: 'No upcoming departure.', fr: 'Aucun passage à venir.' },
    });
    return { ttl_seconds: TTL_SECONDS[WIDGET_KEYS.DEPARTURES], components };
  }

  const scheduled = departures.slice(0, BOARD_ROWS).some((departure) => !departure.realtime);
  components.push({
    type: 'value',
    value: next.minutes,
    unit: 'min',
    label: routeLabel(next, 24),
    icon: 'clock',
    color: next.realtime ? SUCCESS : NEUTRAL,
  });
  components.push({
    type: 'status',
    items: departures.slice(0, BOARD_ROWS).map((departure) => ({
      label: routeLabel(departure, 40),
      value: departure.realtime
        ? formatMinutes(departure.minutes)
        : formatScheduled(departure.minutes),
      // Green is a bus the STM tracks, grey the timetable; a tracked bus more
      // than five minutes late is worth a glance before leaving.
      color: !departure.realtime
        ? NEUTRAL
        : (departure.delaySeconds ?? 0) > 300
          ? WARNING
          : SUCCESS,
    })),
  });
  if (scheduled) {
    components.push({
      type: 'text',
      variant: WIDGET_TEXT_VARIANTS.CAPTION,
      text: {
        en: '~ scheduled time. Add an STM key for real time.',
        fr: '~ horaire prévu. Ajoutez une clé STM pour le temps réel.',
      },
    });
  }
  return { ttl_seconds: TTL_SECONDS[WIDGET_KEYS.DEPARTURES], components };
}

/**
 * "Ligne 61 → Est": the route, and where it goes when the source said so (the
 * timetable does, the real-time feed does not).
 * @param {{ route: string, headsign?: string }} departure
 * @param {number} max the budget of the component
 */
function routeLabel(departure, max) {
  const direction = departure.headsign ? ` → ${departure.headsign}` : '';
  return {
    en: truncate(`Route ${departure.route}${direction}`, max),
    fr: truncate(`Ligne ${departure.route}${direction}`, max),
  };
}

/** A scheduled countdown, marked "~" like on the STM signs. */
function formatScheduled(minutes) {
  return minutes === 0 ? { en: '~ Now', fr: '~ À l’arrêt' } : `~${minutes} min`;
}

const METRO_COLORS = {
  [METRO_STATUS.NORMAL]: SUCCESS,
  [METRO_STATUS.DISRUPTED]: DANGER,
  [METRO_STATUS.NOTICE]: WARNING,
  [METRO_STATUS.UNKNOWN]: NEUTRAL,
};

/**
 * The card of the metro: one row per line, then the message of each line
 * that is not running normally (the "Service normal" ones would only repeat
 * the green dots).
 *
 * @param {{ lines: { id: string, name: { en: string, fr: string }, status: string,
 *   message: string }[] }} status
 */
export function metroStatusContent(status) {
  const components = [heading({ en: 'STM metro', fr: 'Métro STM' })];
  components.push({
    type: 'status',
    items: status.lines.map((line) => ({
      label: line.name,
      value: STATUS_LABELS[line.status],
      color: METRO_COLORS[line.status],
    })),
  });
  for (const line of status.lines) {
    if (line.status === METRO_STATUS.NORMAL || !line.message) continue;
    components.push({
      type: 'text',
      variant: WIDGET_TEXT_VARIANTS.BODY,
      // The message is in the language of the configuration (a text feature
      // holds one string); the line name follows the viewer's.
      text: {
        en: truncate(`${line.name.en}: ${line.message}`, BODY_MAX),
        fr: truncate(`${line.name.fr} : ${line.message}`, BODY_MAX),
      },
    });
  }
  if (status.lines.every((line) => line.status === METRO_STATUS.UNKNOWN)) {
    components.push({
      type: 'text',
      variant: WIDGET_TEXT_VARIANTS.CAPTION,
      text: {
        en: 'The STM published no status for the lines.',
        fr: 'La STM n’a publié aucun état pour les lignes.',
      },
    });
  }
  return { ttl_seconds: TTL_SECONDS[WIDGET_KEYS.METRO_STATUS], components };
}

/**
 * The card of a BIXI station.
 *
 * @param {string} name
 * @param {object} station a reading of the station (src/api/bixi.js)
 * @param {string[]} chartFeatures feature external_ids to draw the day of
 */
export function bixiStationContent(name, station, chartFeatures = []) {
  const components = [heading(name)];
  if (Number.isFinite(station.bikes)) {
    components.push({
      type: 'value',
      value: station.bikes,
      label: { en: 'Bikes', fr: 'Vélos' },
      color: station.bikes === 0 ? DANGER : SUCCESS,
    });
  }
  if (Number.isFinite(station.electricBikes)) {
    components.push({
      type: 'value',
      value: station.electricBikes,
      label: { en: 'E-bikes', fr: 'Vélos électriques' },
      icon: 'zap',
      color: INFO,
    });
  }
  if (Number.isFinite(station.docks)) {
    components.push({
      type: 'value',
      value: station.docks,
      label: { en: 'Free docks', fr: 'Ancrages libres' },
      color: station.docks === 0 ? WARNING : NEUTRAL,
    });
  }
  const occupancy = computeOccupancy(station);
  if (occupancy !== null) {
    components.push({
      type: 'gauge',
      value: occupancy,
      min: 0,
      max: 100,
      unit: '%',
      label: { en: 'Fill', fr: 'Remplissage' },
    });
  }
  if (chartFeatures.length > 0) {
    components.push({
      type: 'chart',
      device_features: chartFeatures,
      interval: WIDGET_CHART_INTERVALS.LAST_DAY,
      chart_type: 'line',
      title: { en: 'Last 24 hours', fr: 'Dernières 24 heures' },
    });
  }
  const ok = station.installed && station.renting && station.returning;
  components.push({
    type: 'status',
    items: [
      {
        label: { en: 'State', fr: 'État' },
        value: {
          en: truncate(formatBixiStatus(station, 'en'), 40),
          fr: truncate(formatBixiStatus(station, 'fr'), 40),
        },
        color: !station.installed ? DANGER : ok && station.bikes !== 0 ? SUCCESS : WARNING,
      },
    ],
  });
  return { ttl_seconds: TTL_SECONDS[WIDGET_KEYS.BIXI_STATION], components };
}

/**
 * The curves of a device, restricted to the features the created device
 * actually carries: a chart pointing at a missing feature is an empty frame.
 */
function chartableFeatures(gladys, deviceExternalId, featureExternalIds) {
  const created = createdFeatures(gladys, deviceExternalId);
  return created ? featureExternalIds.filter((id) => created.has(id)) : [];
}

/** The poll's last reading when fresh enough, else one shared read. */
function latestReading(blueprint, config, widgetKey) {
  return sharedReading(blueprint, config, { maxAgeMs: TTL_SECONDS[widgetKey] * 1000 });
}

const RAW_WIDGETS = {
  async [WIDGET_KEYS.DEPARTURES](gladys, { settings, config }) {
    const blueprint = findSelectedBlueprint(gladys, settings.stop, config, BUS_STOP_TYPE);
    const departures = await latestReading(blueprint, config, WIDGET_KEYS.DEPARTURES);
    return departuresContent(deviceName(gladys, blueprint, config), departures);
  },

  async [WIDGET_KEYS.METRO_STATUS](gladys, { config }) {
    const blueprint = metroBlueprint(config);
    const status = await latestReading(blueprint, config, WIDGET_KEYS.METRO_STATUS);
    return metroStatusContent(status);
  },

  async [WIDGET_KEYS.BIXI_STATION](gladys, { settings, config }) {
    const blueprint = findSelectedBlueprint(gladys, settings.station, config, BIXI_TYPE);
    const station = await latestReading(blueprint, config, WIDGET_KEYS.BIXI_STATION);
    const ids = gladys.externalIds(BIXI_TYPE, blueprint.station.id);
    const chart = chartableFeatures(gladys, ids.device, [
      ids.feature(BIXI_FEATURE.BIKES),
      ids.feature(BIXI_FEATURE.DOCKS),
    ]);
    return bixiStationContent(deviceName(gladys, blueprint, config), station, chart);
  },
};

/**
 * Handlers of the widgets, by key, with every failure turned into a card that
 * says what is wrong.
 */
export const WIDGETS = Object.fromEntries(
  Object.entries(RAW_WIDGETS).map(([key, handler]) => [
    key,
    async (gladys, context, { deadlineMs = PULL_DEADLINE_MS } = {}) => {
      try {
        const content = await withDeadline(handler(gladys, context), deadlineMs);
        if (content === null) {
          logger.info(`Widget ${key}: no answer within ${deadlineMs} ms, serving a loading card`);
          return messageContent(LOADING_TTL_SECONDS, {
            en: 'Reading the data, this takes longer than usual…',
            fr: 'Lecture des données, plus longue que d’habitude…',
          });
        }
        return content;
      } catch (err) {
        if (err instanceof DeviceSelectionError) {
          return messageContent(TTL_SECONDS[key], err.userMessage);
        }
        if (err instanceof StmApiError && err.userMessage) {
          logger.warn(`Widget ${key} failed: ${err.message}`);
          return messageContent(TTL_SECONDS[key], err.userMessage);
        }
        logger.warn(`Widget ${key} failed: ${err.message}`);
        return messageContent(TTL_SECONDS[key], {
          en: truncate(`The data could not be read right now (${err.message}).`, BODY_MAX),
          fr: truncate(
            `Les données n’ont pas pu être lues pour l’instant (${err.message}).`,
            BODY_MAX,
          ),
        });
      }
    },
  ]),
);
