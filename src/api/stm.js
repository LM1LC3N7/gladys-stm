// -----------------------------------------------------------------------------
// STM open-data API client: real-time bus departures.
//
// The STM serves its data through an API hub (portail.developpeurs.stm.info).
// Every request carries the user's key in an `apiKey` header, and the hub
// counts a quota of 10 requests per second and 10,000 per day per ACCOUNT. Two
// consequences shape this module:
//
//   - the bus predictions come as ONE GTFS-Realtime feed covering the whole
//     network: it is read once per refresh interval, decoded for every watched
//     stop at once, and each stop takes its share from that cache. Watching
//     ten stops costs exactly what watching one does;
//   - the hub answers a bad key, a key not subscribed to the API and an
//     exhausted quota with HTTP errors whose bodies say which: they are turned
//     into a bilingual message the user can act on (`StmApiError`), rather
//     than a bare "HTTP 400".
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { request } from './http.js';
import {
  decodeTripUpdates,
  STOP_SCHEDULE_RELATIONSHIP,
  TRIP_SCHEDULE_RELATIONSHIP,
} from './gtfsRealtime.js';
import { stopPlatformId } from '../config.js';

const logger = createLogger({ name: 'stm' });

export const STM_API_BASE_URL = 'https://api.stm.info/pub/od';
export const TRIP_UPDATES_PATH = '/gtfs-rt/ic/v2/tripUpdates';

// A prediction this far in the past is a bus that has left: the feed keeps a
// stop time update for a short while after the vehicle served the stop.
const DEPARTED_GRACE_SECONDS = 30;

// A feed whose header is older than this is not real-time any more: the STM
// side has stalled. It is still served (it is the best information there is),
// but the logs say so once.
const STALE_FEED_SECONDS = 10 * 60;

/** Error of the STM API, with the explanation the user can act on. */
export class StmApiError extends Error {
  /**
   * @param {string} message technical message, for the logs
   * @param {{ status?: number, userMessage?: { en: string, fr: string } }} [details]
   */
  constructor(message, { status, userMessage } = {}) {
    super(message);
    this.name = 'StmApiError';
    this.status = status;
    this.userMessage = userMessage;
  }
}

const MISSING_KEY_MESSAGE = {
  en: 'No STM API key: create one on the STM developer portal and paste it in the configuration.',
  fr: 'Aucune clé d’API STM : créez-en une sur le portail développeurs de la STM et collez-la dans la configuration.',
};

/**
 * Turn a refused request into an StmApiError carrying what to do about it.
 *
 * The hub reports most refusals as a 400 with a short text body; its global
 * rate limit is the one 429. The body is matched loosely and never echoed
 * whole: it is the hub's, not ours.
 *
 * @param {number} status
 * @param {string} body
 * @param {string} path the API path, for the logs
 * @returns {StmApiError}
 */
export function stmErrorFor(status, body, path) {
  const text = String(body ?? '').toLowerCase();
  const message = `STM API ${path} answered HTTP ${status}`;
  if (text.includes('quota') || text.includes('rate limit')) {
    return new StmApiError(`${message} (quota)`, {
      status,
      userMessage: {
        en: 'The daily quota of your STM key is used up (10,000 requests a day for all your applications). Raise the refresh intervals.',
        fr: 'Le quota quotidien de votre clé STM est épuisé (10 000 requêtes par jour pour toutes vos applications). Augmentez les intervalles de rafraîchissement.',
      },
    });
  }
  if (status === 429) {
    return new StmApiError(`${message} (rate limited)`, {
      status,
      userMessage: {
        en: 'The STM API is rate limiting requests right now: the next refresh will try again.',
        fr: 'L’API de la STM limite les requêtes en ce moment : le prochain rafraîchissement réessaiera.',
      },
    });
  }
  if (text.includes('api key') || text.includes('apikey') || status === 401 || status === 403) {
    return new StmApiError(`${message} (key refused)`, {
      status,
      userMessage: {
        en: 'The STM refused the API key: check it, and check that your application is subscribed to this API on the developer portal.',
        fr: 'La STM a refusé la clé d’API : vérifiez-la, et vérifiez que votre application est abonnée à cette API sur le portail développeurs.',
      },
    });
  }
  return new StmApiError(message, { status });
}

/**
 * GET one STM API path with the user's key.
 *
 * @param {{ stm_api_key: string }} config
 * @param {string} path
 * @param {string} accept
 * @returns {Promise<Response>}
 */
export async function stmRequest(config, path, accept) {
  if (!config.stm_api_key) {
    throw new StmApiError('No STM API key configured', { userMessage: MISSING_KEY_MESSAGE });
  }
  const response = await request(`${STM_API_BASE_URL}${path}`, {
    headers: { apiKey: config.stm_api_key, Accept: accept },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw stmErrorFor(response.status, body, path);
  }
  return response;
}

// --- Bus departures ----------------------------------------------------------

/**
 * The decoded feed, shared by every stop for one refresh interval.
 * @type {{ at: number, key: string, stopTimes: object[], timestamp?: number } | null}
 */
let feedCache = null;
/** @type {{ key: string, promise: Promise<object> } | null} */
let feedInFlight = null;
let staleFeedReported = false;

/** Forget the cached feed (configuration change, tests). */
export function clearStmCache() {
  feedCache = null;
  feedInFlight = null;
  staleFeedReported = false;
}

/**
 * The identity of what the cache holds: the watched stop ids (the decoder only
 * keeps those) and the key that read them.
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 */
function cacheKey(config) {
  const ids = [...new Set(config.watched.stops.map((stop) => stop.id))].sort();
  return `${config.stm_api_key}\u0000${ids.join(',')}`;
}

/**
 * Read and decode the network feed for every watched stop.
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 */
async function readFeed(config) {
  const response = await stmRequest(config, TRIP_UPDATES_PATH, 'application/x-protobuf');
  const buffer = new Uint8Array(await response.arrayBuffer());
  const stopIds = config.watched.stops.map((stop) => stop.id);
  const decoded = decodeTripUpdates(buffer, stopIds);
  logger.debug(
    `TripUpdates: ${buffer.length} bytes, ${decoded.stopTimes.length} stop time(s) ` +
      `for ${stopIds.length} watched stop(s)`,
  );
  return decoded;
}

/**
 * The decoded feed, read at most once per refresh interval whatever the
 * number of stops asking, and once for concurrent askers.
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {{ now?: number, fresh?: boolean }} [options] `fresh` skips the
 *   cache (the connection test must reach the API, not the last poll)
 */
export async function getTripUpdates(config, { now = Date.now(), fresh = false } = {}) {
  const key = cacheKey(config);
  // A tenth of the interval of tolerance, like the poll schedule: the poll of
  // the last stop of a cycle must not trigger a second read of the feed.
  const maxAgeMs = config.departures_poll_frequency * 1000 * 0.9;
  if (!fresh && feedCache && feedCache.key === key && now - feedCache.at < maxAgeMs) {
    return feedCache;
  }
  if (feedInFlight && feedInFlight.key === key) {
    return feedInFlight.promise;
  }
  const promise = readFeed(config)
    .then((decoded) => {
      feedCache = { at: now, key, ...decoded };
      return feedCache;
    })
    .finally(() => {
      if (feedInFlight?.promise === promise) {
        feedInFlight = null;
      }
    });
  feedInFlight = { key, promise };
  return promise;
}

/**
 * The upcoming departures of one watched stop, soonest first, route filter
 * applied.
 *
 * A departure is a stop time update of the feed for that stop, from a trip
 * that is not cancelled, which the bus does not skip, and which carries a time.
 * Every such update is a prediction of the STM's vehicle tracking, hence
 * `realtime: true` (the field exists for the widget, which also renders
 * timetable estimates in other integrations).
 *
 * @param {{ stopTimes: object[], timestamp?: number }} feed
 * @param {{ id: string, routes: string[] }} stop
 * @param {number} nowSeconds POSIX time
 * @returns {{ route: string, tripId: string | undefined, directionId: number | undefined,
 *   time: number, minutes: number, delaySeconds: number | undefined, realtime: boolean }[]}
 */
export function departuresFromFeed(feed, stop, nowSeconds) {
  const departures = [];
  for (const stopTime of feed.stopTimes) {
    if (stopTime.stopId !== stop.id) continue;
    if (stopTime.tripScheduleRelationship === TRIP_SCHEDULE_RELATIONSHIP.CANCELED) continue;
    if (stopTime.scheduleRelationship === STOP_SCHEDULE_RELATIONSHIP.SKIPPED) continue;
    const event = stopTime.departure?.time ? stopTime.departure : stopTime.arrival;
    if (!event?.time) continue;
    if (event.time < nowSeconds - DEPARTED_GRACE_SECONDS) continue;
    const route = String(stopTime.routeId ?? '').toUpperCase();
    if (stop.routes.length > 0 && !stop.routes.includes(route)) continue;
    departures.push({
      route,
      tripId: stopTime.tripId,
      directionId: stopTime.directionId,
      time: event.time,
      minutes: Math.max(0, Math.floor((event.time - nowSeconds) / 60)),
      delaySeconds: event.delay,
      realtime: true,
    });
  }
  return departures.sort((a, b) => a.time - b.time);
}

/**
 * The upcoming departures of one watched stop (see `departuresFromFeed`).
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {{ id: string, routes: string[] }} stop
 * @param {{ now?: number }} [options]
 */
export async function fetchDepartures(config, stop, { now = Date.now() } = {}) {
  const feed = await getTripUpdates(config, { now });
  const nowSeconds = Math.floor(now / 1000);
  if (feed.timestamp && nowSeconds - feed.timestamp > STALE_FEED_SECONDS && !staleFeedReported) {
    staleFeedReported = true;
    logger.warn(
      `The STM feed is ${Math.round((nowSeconds - feed.timestamp) / 60)} minutes old: ` +
        'the predictions may be out of date.',
    );
  }
  const departures = departuresFromFeed(feed, stop, nowSeconds);
  logger.debug(`Stop ${stopPlatformId(stop)}: ${departures.length} departure(s)`);
  return departures;
}
