// -----------------------------------------------------------------------------
// Device registry.
//
// The device list is not a static catalog. One device is built per entry of
// three sources, merged by device identity:
//   1. the configuration: the stops and stations the user typed, and the
//      metro when it is watched (and an STM key is set);
//   2. the suggestions: the stops and stations closest to the house
//      (src/devices/suggestions.js);
//   3. the devices the user already created: rebuilt from their own params, so
//      a device keeps refreshing once it stops being suggested, or after the
//      entry that created it was removed from the configuration — the user
//      deletes a device in Gladys, not in a text field.
//
// Each blueprint (see the three modules of this folder) exposes:
//   - key                        : short identifier, used in logs and caches
//   - type                       : the device type
//   - deviceExternalId(gladys)   : the device external_id, used for dispatch
//   - pollIntervalMs(config)     : the configured refresh interval
//   - buildDevice(gladys, config): the discovery payload sent to Gladys
//   - read(config)               : one fresh read, no publication (the
//                                  widgets and the scene actions use it)
//   - onPoll(gladys, config)     : periodic read, publishes the states and
//                                  returns the reading (the scene triggers
//                                  compare two of them)
//
// Nothing here is controllable: transit data is read-only, so no blueprint
// implements onSetValue.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { createBusStopBlueprint, DEVICE_TYPE as BUS_STOP_TYPE } from './busStop.js';
import { createMetroStatusBlueprint, DEVICE_TYPE as METRO_TYPE } from './metroStatus.js';
import { createBixiStationBlueprint, DEVICE_TYPE as BIXI_TYPE } from './bixiStation.js';
import { dueForRead, forgetRead, readFailed } from './pollSchedule.js';
import { recordReading } from './readings.js';
import { forgetDeviceStates } from './stateCache.js';
import { getTripUpdates, StmApiError } from '../api/stm.js';
import { fetchMetroStatus } from '../api/metro.js';
import { searchStations } from '../api/bixi.js';
import { describeStop, formatRoutes, searchStops, TransitousError } from '../api/transitous.js';
import { estimatedDailyRequests, hasStmApiKey, metroEnabled, parseStopEntry } from '../config.js';
import { getSuggestions } from './suggestions.js';
import { publishSceneEvents } from '../scenes/triggers.js';

const logger = createLogger({ name: 'devices' });

/** The value of a device param, as the SDK lists created devices. */
function paramValue(device, name) {
  const param = (device?.params ?? []).find((candidate) => candidate?.name === name);
  return param?.value === undefined || param?.value === null ? undefined : String(param.value);
}

/**
 * The entries behind the devices the user created: a bus stop carries its
 * `stop_code` and `routes` params, a BIXI station its `station_id` (see
 * `buildDevice` in busStop.js and bixiStation.js). Their name is the one
 * Gladys holds, so it is left null here.
 *
 * @param {object} gladys
 */
export function createdEntries(gladys) {
  const stops = [];
  const bixiStations = [];
  for (const device of gladys?.devices ?? []) {
    const stopCode = paramValue(device, 'stop_code');
    if (stopCode) {
      const routes = paramValue(device, 'routes');
      const stop = parseStopEntry(routes ? `${stopCode}@${routes.split(',').join('|')}` : stopCode);
      if (stop) stops.push(stop);
      continue;
    }
    const stationId = paramValue(device, 'station_id');
    if (stationId) {
      bixiStations.push({ id: stationId, name: null });
    }
  }
  return { stops, bixiStations };
}

/** Keep the first blueprint of each device: the typed entry wins (its custom name). */
function uniqueBlueprints(blueprints) {
  const seen = new Set();
  return blueprints.filter((blueprint) =>
    seen.has(blueprint.key) ? false : seen.add(blueprint.key),
  );
}

/**
 * Build every blueprint: configuration, suggestions, created devices.
 * @param {object} gladys
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 */
export function buildBlueprints(gladys, config) {
  const suggested = getSuggestions();
  const created = createdEntries(gladys);
  return uniqueBlueprints([
    ...(metroEnabled(config) ? [createMetroStatusBlueprint()] : []),
    ...config.watched.stops.map(createBusStopBlueprint),
    ...suggested.stops.map(createBusStopBlueprint),
    ...created.stops.map(createBusStopBlueprint),
    ...config.watched.bixiStations.map(createBixiStationBlueprint),
    ...suggested.bixiStations.map(createBixiStationBlueprint),
    ...created.bixiStations.map(createBixiStationBlueprint),
  ]);
}

/**
 * Build the discovery payload for Gladys.
 * @param {object} gladys
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 */
export function buildDiscoveredDevices(gladys, config) {
  return buildBlueprints(gladys, config).map((blueprint) => blueprint.buildDevice(gladys, config));
}

/**
 * Find the blueprint owning a device, from its external_id.
 * @param {object} gladys
 * @param {{ external_id: string }} device
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 */
export function findBlueprintByDevice(gladys, device, config) {
  return buildBlueprints(gladys, config).find(
    (blueprint) => blueprint.deviceExternalId(gladys) === device.external_id,
  );
}

/**
 * How many bus stops are polled: the estimate of the STM requests counts one
 * feed read per interval as soon as there is one.
 * @param {object} gladys
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 */
export function countBusStops(gladys, config) {
  return buildBlueprints(gladys, config).filter((blueprint) => blueprint.type === BUS_STOP_TYPE)
    .length;
}

/**
 * Handle one `device.poll` from the Gladys scheduler (or from the internal
 * refresh loop): route it to the blueprint owning the device, and skip the
 * ticks that arrive before the configured refresh interval has elapsed.
 *
 * The skipping is what keeps the refresh intervals of the configuration
 * meaningful: the core scheduler tops out at one tick a minute, so without it,
 * a metro status configured to refresh every 5 minutes would cost the user's
 * STM quota a request every minute.
 *
 * @param {object} gladys
 * @param {{ external_id: string }} device
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 */
export async function pollDevice(gladys, device, config) {
  const blueprint = findBlueprintByDevice(gladys, device, config);
  if (!blueprint) {
    // The user removed the entry from the watch list but the device still
    // exists in Gladys: nothing to read, and nothing worth erroring about.
    logger.debug(`onPoll ignored, ${device.external_id} is no longer configured`);
    return;
  }
  const intervalMs = blueprint.pollIntervalMs(config);
  if (!dueForRead(blueprint.key, intervalMs)) {
    logger.debug(`onPoll skipped, ${blueprint.key} was refreshed less than an interval ago`);
    return;
  }
  let reading;
  try {
    reading = await blueprint.onPoll(gladys, config);
  } catch (err) {
    readFailed(blueprint.key, intervalMs);
    throw err;
  }
  recordReading(blueprint.key, reading);
  await publishSceneEvents(
    gladys,
    blueprint,
    deviceName(gladys, blueprint, config),
    reading,
    config.language,
  );
}

/**
 * Read a device the user just created or updated, now, and publish all of it:
 * Gladys dropped whatever was sent before the device existed.
 *
 * @param {object} gladys
 * @param {{ external_id: string }} device
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 */
export async function refreshDeviceNow(gladys, device, config) {
  const blueprint = findBlueprintByDevice(gladys, device, config);
  if (!blueprint) {
    return;
  }
  forgetDeviceStates(blueprint.deviceExternalId(gladys));
  forgetRead(blueprint.key);
  await pollDevice(gladys, device, config);
}

/**
 * The name the user sees for a device: the one of the created device (the
 * user may have renamed it in Gladys), else the one it is published with.
 *
 * @param {object} gladys
 * @param {object} blueprint
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @returns {string}
 */
export function deviceName(gladys, blueprint, config) {
  const externalId = blueprint.deviceExternalId(gladys);
  const created = (gladys.devices ?? []).find((device) => device.external_id === externalId);
  return created?.name || blueprint.buildDevice(gladys, config).name;
}

/**
 * Error raised when a widget or a scene action points at a device this
 * integration cannot read: nothing chosen, a device whose entry was removed
 * from the watch lists, or a device of another kind (the `source: "devices"`
 * selects list every device of the integration together). It carries the
 * bilingual explanation the widget displays.
 */
export class DeviceSelectionError extends Error {
  /** @param {{ en: string, fr: string }} userMessage */
  constructor(userMessage) {
    super(userMessage.en);
    this.name = 'DeviceSelectionError';
    this.userMessage = userMessage;
  }
}

const KIND_LABELS = {
  [BUS_STOP_TYPE]: { en: 'a bus stop', fr: 'un arrêt d’autobus' },
  [METRO_TYPE]: { en: 'the metro status', fr: 'l’état du métro' },
  [BIXI_TYPE]: { en: 'a BIXI station', fr: 'une station BIXI' },
};

/**
 * The blueprint behind the device a widget or a scene action was set up with.
 *
 * @param {object} gladys
 * @param {unknown} deviceExternalId the value of the `source: "devices"` field
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {string} type the device type the caller reads
 * @returns {object} the blueprint
 * @throws {DeviceSelectionError}
 */
export function findSelectedBlueprint(gladys, deviceExternalId, config, type) {
  const kind = KIND_LABELS[type];
  if (typeof deviceExternalId !== 'string' || deviceExternalId.length === 0) {
    throw new DeviceSelectionError({
      en: `Choose ${kind.en} in the settings.`,
      fr: `Choisissez ${kind.fr} dans les réglages.`,
    });
  }
  const blueprint = findBlueprintByDevice(gladys, { external_id: deviceExternalId }, config);
  if (!blueprint) {
    throw new DeviceSelectionError({
      en: 'This device is no longer in the integration configuration: add it back, or choose another one.',
      fr: 'Cet appareil n’est plus dans la configuration de l’intégration : ajoutez-le à nouveau, ou choisissez-en un autre.',
    });
  }
  if (blueprint.type !== type) {
    throw new DeviceSelectionError({
      en: `This device is ${KIND_LABELS[blueprint.type]?.en ?? 'another kind of device'}: choose ${kind.en}.`,
      fr: `Cet appareil est ${KIND_LABELS[blueprint.type]?.fr ?? 'd’un autre type'} : choisissez ${kind.fr}.`,
    });
  }
  return blueprint;
}

/**
 * The metro status blueprint, when the configuration watches the metro.
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @throws {DeviceSelectionError}
 */
export function metroBlueprint(config) {
  if (!config.watched.metro) {
    throw new DeviceSelectionError({
      en: 'The metro is not watched: turn on “Watch the metro” in the integration configuration.',
      fr: 'Le métro n’est pas surveillé : activez « Surveiller le métro » dans la configuration de l’intégration.',
    });
  }
  if (!metroEnabled(config)) {
    throw new DeviceSelectionError({
      en: 'The metro status needs an STM API key: see the integration documentation, it takes 5 minutes.',
      fr: 'L’état du métro demande une clé d’API STM : voir la documentation de l’intégration, c’est 5 minutes.',
    });
  }
  return createMetroStatusBlueprint();
}

/**
 * Handlers of the manifest actions (the buttons of the Configuration screen).
 */
const RAW_ACTIONS = {
  /**
   * Check the STM key against both APIs the integration reads. They are
   * probed separately: an application on the developer portal is subscribed
   * API by API, and "the key works for the metro but not for the buses" is
   * the answer that tells the user which subscription is missing.
   */
  async test_stm_api(gladys, { config }) {
    if (!hasStmApiKey(config)) {
      return {
        en: 'No STM API key: fill it in above.',
        fr: 'Aucune clé d’API STM : renseignez-la ci-dessus.',
      };
    }
    const probes = [
      {
        label: { en: 'Metro status (i3)', fr: 'État du métro (i3)' },
        run: () => fetchMetroStatus(config),
      },
      {
        // The probe decodes for the watched stops, which also checks the
        // payload is a well-formed feed.
        label: { en: 'Bus predictions (GTFS-RT)', fr: 'Prédictions autobus (GTFS-RT)' },
        run: () => getTripUpdates(config, { fresh: true }),
      },
    ];
    const results = [];
    for (const probe of probes) {
      try {
        await probe.run();
        results.push({ ok: true, label: probe.label });
      } catch (err) {
        results.push({ ok: false, label: probe.label, error: err });
      }
    }
    const lines = results.map((result) => {
      if (result.ok) {
        return { en: `✔ ${result.label.en}`, fr: `✔ ${result.label.fr}` };
      }
      const reason = result.error?.userMessage ?? {
        en: result.error?.message,
        fr: result.error?.message,
      };
      return {
        en: `✖ ${result.label.en}: ${reason.en}`,
        fr: `✖ ${result.label.fr} : ${reason.fr}`,
      };
    });
    const requests = estimatedDailyRequests(config, { busStops: countBusStops(gladys, config) });
    const summary = results.every((result) => result.ok)
      ? {
          en: `STM API OK. This configuration costs about ${requests} requests a day (quota: 10,000).`,
          fr: `API STM OK. Cette configuration coûte environ ${requests} requêtes par jour (quota : 10 000).`,
        }
      : {
          en: 'The STM API refused part of the requests:',
          fr: 'L’API STM a refusé une partie des requêtes :',
        };
    return {
      en: [summary.en, ...lines.map((line) => line.en)].join('\n'),
      fr: [summary.fr, ...lines.map((line) => line.fr)].join('\n'),
    };
  },

  /**
   * Search a bus stop by name and show the codes to paste, each with where
   * its routes go: the two sides of a street share a name, not a direction.
   */
  async search_stops(gladys, { fields }) {
    const query = String(fields?.query ?? '').trim();
    if (query.length < 2) {
      return { en: 'Type at least 2 characters.', fr: 'Saisissez au moins 2 caractères.' };
    }
    const results = (await searchStops(query)).slice(0, 8);
    if (results.length === 0) {
      return {
        en: `No STM bus stop matches "${query}". Try a street corner, e.g. "Sherbrooke Papineau".`,
        fr: `Aucun arrêt STM ne correspond à « ${query} ». Essayez une intersection, ex. « Sherbrooke Papineau ».`,
      };
    }
    const lines = [];
    for (const stop of results) {
      const description = await describeStop(stop.code);
      const routes = formatRoutes(description);
      lines.push(`${stop.code} — ${description?.name || stop.name}${routes ? ` (${routes})` : ''}`);
    }
    return {
      en: `Paste a code in "Bus stops" (several: separate with commas):\n${lines.join('\n')}`,
      fr: `Collez un code dans « Arrêts d'autobus » (plusieurs : séparez par des virgules) :\n${lines.join('\n')}`,
    };
  },

  /** Search a BIXI station by name and show the ids to paste. */
  async search_bixi_stations(gladys, { fields, config }) {
    const query = String(fields?.query ?? '').trim();
    if (query.length < 2) {
      return { en: 'Type at least 2 characters.', fr: 'Saisissez au moins 2 caractères.' };
    }
    const results = await searchStations(config, query);
    if (results.length === 0) {
      return {
        en: `No BIXI station matches "${query}".`,
        fr: `Aucune station BIXI ne correspond à « ${query} ».`,
      };
    }
    const list = results
      .map((station) => `${station.id} — ${station.name} (${station.capacity ?? '?'})`)
      .join('\n');
    return {
      en: `Paste one of these ids in "BIXI stations" (capacity in brackets):\n${list}`,
      fr: `Collez un de ces identifiants dans « Stations BIXI » (capacité entre parenthèses) :\n${list}`,
    };
  },
};

/**
 * Handlers of the manifest actions, with the STM refusals turned into what the
 * user can act on: an action that throws shows the raw error under the button.
 */
export const ACTIONS = Object.fromEntries(
  Object.entries(RAW_ACTIONS).map(([key, handler]) => [
    key,
    async (gladys, context) => {
      try {
        return await handler(gladys, context);
      } catch (err) {
        if (err instanceof StmApiError && err.userMessage) {
          logger.warn(`Action ${key} failed: ${err.message}`);
          return err.userMessage;
        }
        if (err instanceof TransitousError) {
          logger.warn(`Action ${key} failed: ${err.message}`);
          return {
            en: 'The stop directory (Transitous) does not answer right now: try again in a few minutes.',
            fr: 'L’annuaire des arrêts (Transitous) ne répond pas pour l’instant : réessayez dans quelques minutes.',
          };
        }
        throw err;
      }
    },
  ]),
);
