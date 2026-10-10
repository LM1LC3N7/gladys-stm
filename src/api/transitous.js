// -----------------------------------------------------------------------------
// Transitous (https://transitous.org): the keyless half of the integration.
//
// Transitous is a free, community-run public transport routing service (MOTIS)
// that loads the STM timetables among a thousand other feeds. It needs no key,
// and it answers the three questions the STM API cannot answer without one —
// or at all:
//   - which STM stops are near this house          (map/stops, a bounding box);
//   - which stops match "Sherbrooke / Papineau"    (geocode);
//   - what is the name of stop 52743, which routes serve it, which way they
//     go, and when do they leave                    (stoptimes).
//
// Its usage policy (https://transitous.org/api/) asks for a User-Agent naming
// the application and a contact (src/api/http.js sends it), for open-source,
// non-commercial use only, and to stay light: every answer here is cached,
// the stop descriptions for a day, and the departures are only read when the
// user has no STM key (see src/devices/busStop.js), never faster than every
// two minutes.
//
// Transitous ids are the GTFS ids prefixed with the feed: `ca-qc-STM_52743` is
// the STM stop 52743 — the five-digit code on the sign, which is also the
// stop_id of the STM's own feeds.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { request } from './http.js';

const logger = createLogger({ name: 'transitous' });

export const TRANSITOUS_API_URL = 'https://api.transitous.org/api';
const STM_PREFIX = 'ca-qc-STM_';
// A bus stop code: five digits. Metro stations and platforms have other ids
// (STATION_M146, 9999111) and no bus departures of their own.
const BUS_STOP_CODE = /^\d{5}$/;

// What a stop is (its name, the routes calling there) only changes with the
// STM schedule, a few times a year: a day is plenty.
const DESCRIPTION_MAX_AGE_MS = 24 * 60 * 60_000;

/** Error of the Transitous API. */
export class TransitousError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransitousError';
  }
}

/** The STM stop code of a Transitous stop id, or null for another network. */
export function stmStopCode(transitousId) {
  if (typeof transitousId !== 'string' || !transitousId.startsWith(STM_PREFIX)) {
    return null;
  }
  const code = transitousId.slice(STM_PREFIX.length);
  return BUS_STOP_CODE.test(code) ? code : null;
}

async function getJson(path) {
  const response = await request(`${TRANSITOUS_API_URL}${path}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new TransitousError(`Transitous ${path.split('?')[0]} answered HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Distance in meters between two points (haversine): enough precision to sort
 * the stops of a neighborhood.
 */
export function distanceMeters(a, b) {
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(6_371_000 * 2 * Math.asin(Math.sqrt(h)));
}

/**
 * The STM bus stops within `radiusMeters` of a point, closest first.
 *
 * @param {{ lat: number, lon: number }} point
 * @param {number} radiusMeters
 * @returns {Promise<{ code: string, name: string, lat: number, lon: number, distance: number }[]>}
 */
export async function stopsNear(point, radiusMeters) {
  // A bounding box around the point; the corners beyond the radius are
  // dropped by the distance filter below.
  const dLat = radiusMeters / 111_320;
  const dLon = radiusMeters / (111_320 * Math.cos((point.lat * Math.PI) / 180));
  const min = `${(point.lat - dLat).toFixed(6)},${(point.lon - dLon).toFixed(6)}`;
  const max = `${(point.lat + dLat).toFixed(6)},${(point.lon + dLon).toFixed(6)}`;
  const stops = await getJson(`/v1/map/stops?min=${min}&max=${max}`);
  const seen = new Set();
  return (Array.isArray(stops) ? stops : [])
    .map((stop) => ({
      code: stmStopCode(stop?.stopId),
      name: tidyName(stop?.name),
      lat: Number(stop?.lat),
      lon: Number(stop?.lon),
    }))
    .filter((stop) => stop.code && Number.isFinite(stop.lat) && Number.isFinite(stop.lon))
    .filter((stop) => (seen.has(stop.code) ? false : seen.add(stop.code)))
    .map((stop) => ({ ...stop, distance: distanceMeters(point, stop) }))
    .filter((stop) => stop.distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance);
}

/**
 * STM bus stops whose name matches a query, best match first.
 *
 * @param {string} query e.g. "Sherbrooke Papineau"
 * @returns {Promise<{ code: string, name: string }[]>}
 */
export async function searchStops(query) {
  const results = await getJson(`/v1/geocode?text=${encodeURIComponent(query)}&type=STOP`);
  const seen = new Set();
  return (Array.isArray(results) ? results : [])
    .map((result) => ({ code: stmStopCode(result?.id), name: tidyName(result?.name) }))
    .filter((stop) => stop.code && !seen.has(stop.code) && seen.add(stop.code));
}

/**
 * The next departures of a stop, from the STM timetable as Transitous holds
 * it (real time only when Transitous has it, which it did not for the STM
 * when this was written: these are scheduled times).
 *
 * @param {string} code STM stop code
 * @param {{ count?: number }} [options]
 * @returns {Promise<{ name: string, departures: { route: string, headsign: string,
 *   tripId: string, time: number, realtime: boolean, delaySeconds: number }[] }>}
 */
export async function stopTimes(code, { count = 10 } = {}) {
  const payload = await getJson(
    `/v5/stoptimes?stopId=${encodeURIComponent(STM_PREFIX + code)}&n=${count}`,
  );
  const entries = Array.isArray(payload?.stopTimes) ? payload.stopTimes : [];
  const departures = [];
  let name = String(payload?.place?.name ?? '');
  for (const entry of entries) {
    if (entry?.cancelled || entry?.tripCancelled) continue;
    const place = entry?.place ?? {};
    name = name || String(place.name ?? '');
    const at = Date.parse(place.departure ?? place.arrival);
    const scheduled = Date.parse(place.scheduledDeparture ?? place.scheduledArrival);
    if (!Number.isFinite(at)) continue;
    departures.push({
      route: String(entry.routeShortName ?? entry.displayName ?? '').toUpperCase(),
      headsign: String(entry.headsign ?? ''),
      tripId: String(entry.tripId ?? ''),
      time: Math.floor(at / 1000),
      realtime: entry.realTime === true,
      delaySeconds: Number.isFinite(scheduled) ? Math.round((at - scheduled) / 1000) : 0,
    });
  }
  return { name, departures };
}

/** @type {Map<string, { at: number, value: object }>} */
const descriptions = new Map();

/** Forget every stop description (tests). */
export function clearTransitousCache() {
  descriptions.clear();
}

/**
 * The name of a stop and the routes calling there, each with its direction —
 * what tells "Peel / Notre-Dame (61 → Est)" from the stop across the street.
 * Cached for a day; `null` when Transitous cannot answer (the caller falls
 * back on the bare stop code).
 *
 * @param {string} code
 * @param {{ now?: number }} [options]
 * @returns {Promise<{ code: string, name: string, routes: { route: string, headsigns: string[] }[] } | null>}
 */
export async function describeStop(code, { now = Date.now() } = {}) {
  const cached = descriptions.get(code);
  if (cached && now - cached.at < DESCRIPTION_MAX_AGE_MS) {
    return cached.value;
  }
  try {
    // Twenty departures cover every route of all but the busiest stops.
    const { name, departures } = await stopTimes(code, { count: 20 });
    // A route may call in both directions at a terminus or on a loop: keep
    // every direction, in order of appearance.
    const byRoute = new Map();
    for (const departure of departures) {
      const headsigns = byRoute.get(departure.route) ?? [];
      if (departure.headsign && !headsigns.includes(departure.headsign)) {
        headsigns.push(departure.headsign);
      }
      byRoute.set(departure.route, headsigns);
    }
    const routes = [...byRoute]
      .map(([route, headsigns]) => ({ route, headsigns }))
      .sort((a, b) => a.route.localeCompare(b.route, 'fr', { numeric: true }));
    const value = { code, name: tidyName(name), routes };
    descriptions.set(code, { at: now, value });
    return value;
  } catch (err) {
    logger.debug(`Stop ${code} could not be described: ${err.message}`);
    return cached?.value ?? null;
  }
}

/** The description already known for a stop, without any request. */
export function knownStop(code) {
  return descriptions.get(code)?.value ?? null;
}

/**
 * "61 → Est, 107 → Nord/Sud": the routes of a stop with their directions.
 * @param {{ routes: { route: string, headsigns: string[] }[] }} description
 */
export function formatRoutes(description) {
  return (description?.routes ?? [])
    .map(({ route, headsigns }) =>
      headsigns?.length ? `${route} → ${headsigns.join('/')}` : route,
    )
    .join(', ');
}

/**
 * A stop name as the STM publishes it, with the closing parenthesis some of
 * them lack ("École de technologie supérieure (Peel / Notre-Dame").
 * @param {string} name
 */
export function tidyName(name) {
  const value = String(name ?? '').trim();
  const open = (value.match(/\(/g) ?? []).length;
  const close = (value.match(/\)/g) ?? []).length;
  return open > close ? `${value}${')'.repeat(open - close)}` : value;
}

/**
 * The upcoming departures of a watched stop from the timetable, in the shape
 * the STM real-time path produces (src/api/stm.js `departuresFromFeed`), so
 * the devices, widgets and scenes do not care where the board came from.
 *
 * @param {{ id: string, routes: string[] }} stop
 * @param {{ now?: number }} [options]
 */
export async function scheduledDepartures(stop, { now = Date.now() } = {}) {
  const nowSeconds = Math.floor(now / 1000);
  const { departures } = await stopTimes(stop.id, { count: 10 });
  return departures
    .filter((departure) => departure.time >= nowSeconds - 30)
    .filter((departure) => stop.routes.length === 0 || stop.routes.includes(departure.route))
    .map((departure) => ({
      route: departure.route,
      headsign: departure.headsign,
      tripId: departure.tripId,
      time: departure.time,
      minutes: Math.max(0, Math.floor((departure.time - nowSeconds) / 60)),
      delaySeconds: departure.delaySeconds,
      realtime: departure.realtime,
    }))
    .sort((a, b) => a.time - b.time);
}
