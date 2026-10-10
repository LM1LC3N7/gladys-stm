// -----------------------------------------------------------------------------
// Integration configuration.
//
// The values come from the `config_schema` declared in
// `gladys-assistant-integration.json`: Gladys renders the form, the SDK fetches
// the result (`gladys.getConfig()`) and notifies every change through
// `gladys.onConfigUpdated()`.
//
// This module owns the defaults, forces the types (a form may send strings)
// and parses the "list of things to watch" fields into the structures the
// device modules consume.
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest (test/manifest.test.js enforces it).
export const DEFAULT_CONFIG = {
  // --- STM developer portal ------------------------------------------------
  // One key per user: the STM counts its quota (10 requests per second, 10,000
  // per day) per ACCOUNT, across every application of that account, so a key
  // shipped with the integration would be exhausted by a handful of homes.
  stm_api_key: '',

  // --- What to watch --------------------------------------------------------
  // How many of the bus stops and BIXI stations closest to the house are
  // proposed in the Discovery screen (src/devices/suggestions.js). 0 turns the
  // suggestion off.
  nearby_bus_stops: 3,
  nearby_bixi_stations: 2,
  stops: '',
  watch_metro: true,
  bixi_stations: '',
  // Without an STM key, show the scheduled departures (Transitous) rather than
  // nothing: the integration works right after install, and the key turns the
  // schedule into real-time predictions.
  schedule_without_key: true,

  // --- Refresh intervals, in seconds ---------------------------------------
  // Gladys drives the refresh: each device is published with a
  // `poll_frequency` the core scheduler understands (see gladysPollFrequency
  // below — the core only schedules up to one tick a minute), and the ticks
  // that fall inside the configured interval are dropped by the integration.
  //   - bus departures are countdowns: one read of the whole network feed a
  //     minute serves every watched stop (1,440 requests a day);
  //   - the metro status changes a few times a day: every two minutes is
  //     plenty (720 requests a day);
  //   - BIXI is an open feed with no quota, refreshed by the operator about
  //     every ten seconds.
  departures_poll_frequency: 60,
  metro_poll_frequency: 120,
  bixi_poll_frequency: 120,

  // --- Misc -----------------------------------------------------------------
  max_departures: 3,
  language: 'fr',
};

// The scheduled departures come from Transitous, a free community service:
// a timetable does not move, and its usage policy asks to stay light.
export const MIN_SCHEDULE_POLL_FREQUENCY = 120;

// Below 30 s the STM feed returns the same payload anyway, and every read
// counts against the user's daily quota; above one hour a "real-time" sensor
// stops being real-time.
const MIN_POLL_FREQUENCY = 30;
const MAX_POLL_FREQUENCY = 3600;

/** Languages the text features can be published in. */
export const LANGUAGES = ['fr', 'en'];

// The intervals Gladys itself knows how to schedule (`DEVICE_POLL_FREQUENCIES`
// in the core), in MILLISECONDS. Publishing a `poll_frequency` outside this
// list makes the core reject the WHOLE `POST /discovered_device` batch with a
// 400, which leaves the Discovery screen empty.
export const GLADYS_POLL_FREQUENCIES_MS = [1000, 2000, 10000, 15000, 30000, 60000];

/**
 * The interval Gladys is asked to poll a device at, for a configured refresh
 * interval expressed in seconds: the fastest tick that stays under it (60 s
 * for anything above a minute). The extra ticks are dropped by `dueForRead`
 * in src/devices/pollSchedule.js, so the STM still sees one read per
 * configured interval.
 *
 * @param {number} seconds configured refresh interval
 * @returns {number} a value of GLADYS_POLL_FREQUENCIES_MS
 */
export function gladysPollFrequency(seconds) {
  const wanted = Number(seconds) * 1000;
  const supported = GLADYS_POLL_FREQUENCIES_MS.filter((frequency) => frequency <= wanted);
  return supported.length > 0 ? Math.max(...supported) : Math.min(...GLADYS_POLL_FREQUENCIES_MS);
}

/**
 * Clamp a refresh interval to the accepted range, falling back to the default
 * when the form sent something unusable (empty string, NaN...).
 * @param {unknown} value raw value from the config form
 * @param {number} fallback default declared in the manifest
 * @returns {number} a refresh interval in seconds
 */
export function normalizePollFrequency(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(MAX_POLL_FREQUENCY, Math.max(MIN_POLL_FREQUENCY, Math.round(parsed)));
}

/** The most suggestions of one kind: beyond that, the Discovery screen is a list to read. */
export const MAX_NEARBY = 8;

/**
 * A count of suggestions, bounded to 0..MAX_NEARBY.
 * @param {unknown} value
 * @param {number} fallback
 */
function normalizeCount(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? Math.min(MAX_NEARBY, Math.max(0, parsed)) : fallback;
}

/**
 * A boolean field, which a form may send as a string.
 * @param {unknown} value
 * @param {boolean} fallback
 */
function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return value === true || value === 'true' || value === 1 || value === '1';
}

/**
 * Split a user-provided list. Accepts commas, semicolons and newlines so the
 * user can paste a column from a spreadsheet as easily as a one-liner.
 * @param {unknown} raw
 * @returns {string[]} trimmed, non-empty entries
 */
function splitList(raw) {
  if (typeof raw !== 'string') {
    return [];
  }
  return raw
    .split(/[,;\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Parse a watched bus stop.
 *
 * Syntax: `<stop code>[@<route>[|<route>...]][:<custom name>]`
 *   - `51003`                    every bus calling at stop 51003
 *   - `51003@24`                 only route 24
 *   - `51003@24|747`             routes 24 and 747
 *   - `51003@24:Bus to work`     only route 24, displayed as "Bus to work"
 *
 * The stop code is the five-digit number written on every STM bus stop sign
 * (and in the STM app), which is also the stop_id of the GTFS feeds.
 *
 * @param {string} entry one raw entry of the `stops` field
 * @returns {{ id: string, routes: string[], name: string | null } | null}
 */
export function parseStopEntry(entry) {
  // The custom name is free text and may itself contain '@': cut on ':' first.
  const separatorIndex = entry.indexOf(':');
  const target = separatorIndex === -1 ? entry : entry.slice(0, separatorIndex);
  const name = separatorIndex === -1 ? null : entry.slice(separatorIndex + 1).trim() || null;

  const [rawId, rawRoutes] = target.split('@');
  const id = rawId.trim();
  if (id.length === 0) {
    return null;
  }

  const routes = (rawRoutes ?? '')
    .split('|')
    .map((route) => route.trim().toUpperCase())
    .filter((route) => route.length > 0);

  return { id, routes, name };
}

/**
 * Parse an entry of the BIXI list. Syntax: `<station id>[:<custom name>]`.
 * @param {string} entry
 * @returns {{ id: string, name: string | null } | null}
 */
export function parseSimpleEntry(entry) {
  const separatorIndex = entry.indexOf(':');
  const id = (separatorIndex === -1 ? entry : entry.slice(0, separatorIndex)).trim();
  if (id.length === 0) {
    return null;
  }
  const name = separatorIndex === -1 ? null : entry.slice(separatorIndex + 1).trim() || null;
  return { id, name };
}

/**
 * Keep the first entry of each identity: the same stop listed twice with the
 * same filter would be two blueprints publishing to one device.
 * @template T
 * @param {T[]} entries
 * @param {(entry: T) => string} identity
 * @returns {T[]}
 */
function uniqueBy(entries, identity) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = identity(entry);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** The identity of a watched stop: its id and its route filter. */
export function stopPlatformId(stop) {
  return stop.routes.length > 0 ? `${stop.id}@${stop.routes.join('|')}` : stop.id;
}

/**
 * Merge the user config with the defaults and pre-parse the watch lists, so
 * the rest of the code never deals with `undefined` nor with raw strings.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...raw,
    stm_api_key: String(raw.stm_api_key ?? '').trim(),
    watch_metro: normalizeBoolean(raw.watch_metro, DEFAULT_CONFIG.watch_metro),
    schedule_without_key: normalizeBoolean(
      raw.schedule_without_key,
      DEFAULT_CONFIG.schedule_without_key,
    ),
    nearby_bus_stops: normalizeCount(raw.nearby_bus_stops, DEFAULT_CONFIG.nearby_bus_stops),
    nearby_bixi_stations: normalizeCount(
      raw.nearby_bixi_stations,
      DEFAULT_CONFIG.nearby_bixi_stations,
    ),
    departures_poll_frequency: normalizePollFrequency(
      raw.departures_poll_frequency,
      DEFAULT_CONFIG.departures_poll_frequency,
    ),
    metro_poll_frequency: normalizePollFrequency(
      raw.metro_poll_frequency,
      DEFAULT_CONFIG.metro_poll_frequency,
    ),
    bixi_poll_frequency: normalizePollFrequency(
      raw.bixi_poll_frequency,
      DEFAULT_CONFIG.bixi_poll_frequency,
    ),
    max_departures: Math.min(
      5,
      Math.max(1, Math.round(Number(raw.max_departures ?? DEFAULT_CONFIG.max_departures)) || 1),
    ),
    language: LANGUAGES.includes(raw.language) ? raw.language : DEFAULT_CONFIG.language,
  };

  // Pre-parsed watch lists, consumed by src/devices/index.js.
  config.watched = {
    stops: uniqueBy(splitList(config.stops).map(parseStopEntry).filter(Boolean), stopPlatformId),
    bixiStations: uniqueBy(
      splitList(config.bixi_stations).map(parseSimpleEntry).filter(Boolean),
      (station) => station.id,
    ),
    metro: config.watch_metro,
  };

  return config;
}

/** Whether the STM API key is filled in. BIXI needs none. */
export function hasStmApiKey(config) {
  return config.stm_api_key.length > 0;
}

/**
 * Where the bus departures come from: the STM real-time feed with a key, the
 * Transitous timetable without one (unless the user turned that off).
 * @param {ReturnType<typeof normalizeConfig>} config
 * @returns {'stm' | 'schedule' | 'none'}
 */
export function departuresSource(config) {
  if (hasStmApiKey(config)) {
    return 'stm';
  }
  return config.schedule_without_key ? 'schedule' : 'none';
}

/** Whether the metro status can be read: it only exists in the STM API. */
export function metroEnabled(config) {
  return config.watched.metro && hasStmApiKey(config);
}

/**
 * The number of STM requests a day the configuration costs, for the
 * connection status: the quota is per account, and the user may run other
 * applications on the same key. `busStops` counts the stops actually polled
 * (the suggested and created ones included), not only the typed ones.
 * @param {ReturnType<typeof normalizeConfig>} config
 * @param {{ busStops?: number }} [options]
 */
export function estimatedDailyRequests(config, { busStops = config.watched.stops.length } = {}) {
  const day = 86_400;
  let requests = 0;
  if (!hasStmApiKey(config)) {
    return 0;
  }
  if (busStops > 0) {
    // One read of the network feed serves every watched stop.
    requests += Math.ceil(day / config.departures_poll_frequency);
  }
  if (config.watched.metro) {
    requests += Math.ceil(day / config.metro_poll_frequency);
  }
  return requests;
}
