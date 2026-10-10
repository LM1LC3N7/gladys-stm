// -----------------------------------------------------------------------------
// "Near my home": the stops and stations the integration proposes by itself.
//
// The hardest part of setting a transit integration up is not the integration,
// it is knowing that the stop across the street is "52743". Gladys knows where
// the house is (the manifest declares `location: true`, which the user grants
// at install time), so the integration looks the closest bus stops and BIXI
// stations up itself and publishes them in the Discovery screen, named the way
// people know them and prefixed with what they are — "Bus – Peel / Notre-Dame
// (61 → Est)", "BIXI – Peel / Notre-Dame". Adding one is a click.
//
// The suggestions are computed at every connection and configuration change,
// and only ever ADD to what the user typed in the configuration. They are not
// what keeps a created device working: a device the user added is rebuilt from
// its own params (see `createdEntries` in src/devices/index.js), so a stop that
// stops being "among the three closest" — another one opened nearby — keeps
// refreshing.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { describeStop, distanceMeters, formatRoutes, stopsNear } from '../api/transitous.js';
import { fetchStations } from '../api/bixi.js';

const logger = createLogger({ name: 'suggestions' });

// A bus stop further than this is not "near the house": a ten-minute walk.
export const BUS_STOP_RADIUS_METERS = 600;
// BIXI stations are sparser than bus stops, and a bike ride starts with a walk.
export const BIXI_RADIUS_METERS = 1000;

/**
 * What the last lookup found. `status` says why there is nothing, for the
 * connection status: the user must be told what to do about it.
 *
 * The entries carry a `label` (the place, as people know it) and no `name`:
 * a `name` is the user's own, published as is, while a label gets the "Bus –"
 * or "BIXI –" prefix of the device modules.
 *
 * @type {{ status: 'disabled' | 'no_house' | 'no_location' | 'failed' | 'ok',
 *   stops: { id: string, routes: string[], name: null, label: string, distance: number }[],
 *   bixiStations: { id: string, name: null, label: string, distance: number }[] }}
 */
let suggestions = emptySuggestions('disabled');

function emptySuggestions(status) {
  return { status, stops: [], bixiStations: [] };
}

/** The current suggestions (empty until the first lookup). */
export function getSuggestions() {
  return suggestions;
}

/** Forget the suggestions (tests). */
export function clearSuggestions() {
  suggestions = emptySuggestions('disabled');
}

/**
 * The first house of Gladys that has coordinates. Several houses may exist (a
 * cottage, the parents' home): the integration only looks around one, and the
 * documentation says which.
 *
 * @param {object} gladys
 * @returns {Promise<{ lat: number, lon: number, name: string } | null | undefined>}
 *   null when no house is located, undefined when Gladys refused to tell
 */
async function homeLocation(gladys) {
  let houses;
  try {
    houses = await gladys.getHouses();
  } catch (err) {
    // A 403 means the location permission was not granted (or an older
    // manifest is installed): nothing to suggest, and nothing broken.
    logger.warn(`The house location is not available: ${err.message}`);
    return undefined;
  }
  const house = (Array.isArray(houses) ? houses : []).find(
    (candidate) => Number.isFinite(candidate?.latitude) && Number.isFinite(candidate?.longitude),
  );
  return house ? { lat: house.latitude, lon: house.longitude, name: house.name } : null;
}

/**
 * The label of a suggested stop: the stop name, then where its routes go,
 * which is what tells the two sides of a street apart.
 * @param {{ code: string, name: string }} stop
 * @param {{ name: string, routes: object[] } | null} description
 */
export function suggestedStopLabel(stop, description) {
  const name = description?.name || stop.name || stop.code;
  const routes = formatRoutes(description);
  return routes ? `${name} (${routes})` : name;
}

/**
 * Look the stops and stations around the house up again.
 *
 * Never throws: a failed lookup leaves the integration exactly as useful as
 * the configuration makes it, and the status says why.
 *
 * @param {object} gladys
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 */
export async function refreshSuggestions(gladys, config) {
  const wantedStops = config.nearby_bus_stops;
  const wantedStations = config.nearby_bixi_stations;
  if (wantedStops === 0 && wantedStations === 0) {
    suggestions = emptySuggestions('disabled');
    return suggestions;
  }

  const home = await homeLocation(gladys);
  if (home === undefined) {
    suggestions = emptySuggestions('no_house');
    return suggestions;
  }
  if (home === null) {
    suggestions = emptySuggestions('no_location');
    return suggestions;
  }

  const next = { status: 'ok', stops: [], bixiStations: [] };
  let failures = 0;

  if (wantedStops > 0) {
    try {
      const near = (await stopsNear(home, BUS_STOP_RADIUS_METERS)).slice(0, wantedStops);
      for (const stop of near) {
        // One request per stop, once a day at most (cached): the name and the
        // directions are what make the suggestion recognizable.
        const description = await describeStop(stop.code);
        next.stops.push({
          id: stop.code,
          routes: [],
          name: null,
          label: suggestedStopLabel(stop, description),
          distance: stop.distance,
        });
      }
    } catch (err) {
      failures += 1;
      logger.warn(`The bus stops near the house could not be looked up: ${err.message}`);
    }
  }

  if (wantedStations > 0) {
    try {
      const stations = await fetchStations(config);
      next.bixiStations = [...stations.values()]
        .filter((station) => Number.isFinite(station.lat) && Number.isFinite(station.lon))
        .map((station) => ({
          id: station.id,
          name: null,
          label: station.name,
          distance: distanceMeters(home, station),
        }))
        .filter((station) => station.distance <= BIXI_RADIUS_METERS)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, wantedStations);
    } catch (err) {
      failures += 1;
      logger.warn(`The BIXI stations near the house could not be looked up: ${err.message}`);
    }
  }

  // The two sides of a street often share a name AND a direction (a terminus,
  // a loop): the stop code, written on the sign, is then what tells them apart.
  const labels = next.stops.map((stop) => stop.label);
  for (const stop of next.stops) {
    if (labels.filter((label) => label === stop.label).length > 1) {
      stop.label = `${stop.label} · ${stop.id}`;
    }
  }

  if (failures > 0 && next.stops.length === 0 && next.bixiStations.length === 0) {
    next.status = 'failed';
  }
  logger.info(
    `Near ${home.name ?? 'the house'}: ${next.stops.length} bus stop(s), ` +
      `${next.bixiStations.length} BIXI station(s) suggested`,
  );
  suggestions = next;
  return suggestions;
}
