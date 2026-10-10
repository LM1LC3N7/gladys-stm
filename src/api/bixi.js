// -----------------------------------------------------------------------------
// BIXI Montréal: the open GBFS feed (no account, no key).
//
// GBFS splits a bike-share system into files listed by a discovery document
// (`gbfs.json`): the stations themselves (`station_information`: name,
// capacity — changes rarely) and their live counts (`station_status`: bikes,
// e-bikes, free docks — refreshed by the operator every few seconds). Both are
// a few hundred kilobytes for the whole network, so each is read once per
// cycle and shared by every watched station, and the station list is kept for
// an hour.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { request } from './http.js';

const logger = createLogger({ name: 'bixi' });

export const BIXI_GBFS_URL = 'https://gbfs.velobixi.com/gbfs/2-2/gbfs.json';

// The station list (names, capacities) changes when a station is added for
// the season; an hour is fresh enough and spares a 400 KB download a minute.
const INFORMATION_MAX_AGE_MS = 60 * 60_000;

/** Error of the BIXI feed. */
export class BixiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BixiError';
  }
}

/** @type {Map<string, { at: number, value: unknown }>} */
const cache = new Map();
/** @type {Map<string, Promise<unknown>>} */
const inFlight = new Map();

/** Forget every cached file (configuration change, tests). */
export function clearBixiCache() {
  cache.clear();
  inFlight.clear();
}

/**
 * A cached read: the value when younger than `maxAgeMs`, else the read in
 * flight, else a new read.
 * @param {string} key
 * @param {number} maxAgeMs
 * @param {() => Promise<unknown>} read
 * @param {number} now
 */
function cached(key, maxAgeMs, read, now) {
  const hit = cache.get(key);
  if (hit && now - hit.at < maxAgeMs) {
    return Promise.resolve(hit.value);
  }
  const pending = inFlight.get(key);
  if (pending) {
    return pending;
  }
  const promise = read()
    .then((value) => {
      cache.set(key, { at: now, value });
      return value;
    })
    .finally(() => {
      if (inFlight.get(key) === promise) {
        inFlight.delete(key);
      }
    });
  inFlight.set(key, promise);
  return promise;
}

async function getJson(url) {
  const response = await request(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new BixiError(`BIXI GBFS ${url} answered HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * The URL of one GBFS file, from the discovery document. GBFS 2.x lists the
 * files per language (`data.fr.feeds`, `data.en.feeds`); the integration's
 * language is preferred, any other one will do — the files are the same.
 *
 * @param {object} discovery the parsed gbfs.json
 * @param {string} name e.g. 'station_status'
 * @param {string} language
 * @returns {string}
 */
export function feedUrl(discovery, name, language) {
  const data = discovery?.data ?? {};
  const languages = [language, ...Object.keys(data).filter((key) => key !== language)];
  for (const lang of languages) {
    const feed = data[lang]?.feeds?.find((candidate) => candidate?.name === name);
    if (feed?.url) {
      return feed.url;
    }
  }
  throw new BixiError(`The BIXI GBFS discovery document lists no "${name}" file`);
}

/**
 * Every station of the network, with its live counts.
 *
 * @param {{ bixi_poll_frequency: number, language: string }} config
 * @param {{ now?: number }} [options]
 * @returns {Promise<Map<string, {
 *   id: string, name: string, capacity?: number, bikes?: number,
 *   electricBikes?: number, docks?: number, installed: boolean,
 *   renting: boolean, returning: boolean, lastReported?: number }>>}
 */
export async function fetchStations(config, { now = Date.now() } = {}) {
  const discovery = await cached(
    'discovery',
    INFORMATION_MAX_AGE_MS,
    () => getJson(BIXI_GBFS_URL),
    now,
  );
  const [information, status] = await Promise.all([
    cached(
      'station_information',
      INFORMATION_MAX_AGE_MS,
      () => getJson(feedUrl(discovery, 'station_information', config.language)),
      now,
    ),
    cached(
      'station_status',
      config.bixi_poll_frequency * 1000 * 0.9,
      () => getJson(feedUrl(discovery, 'station_status', config.language)),
      now,
    ),
  ]);
  return mergeStations(information, status);
}

const count = (value) =>
  Number.isFinite(Number(value)) && value !== null ? Number(value) : undefined;
// GBFS 2.x booleans are true booleans, GBFS 1.x ones are 0/1: accept both.
const flag = (value, fallback) =>
  value === undefined || value === null ? fallback : Boolean(Number(value));

/**
 * Join the station list with the live counts, by station_id.
 *
 * @param {object} information parsed station_information.json
 * @param {object} status parsed station_status.json
 */
export function mergeStations(information, status) {
  const stations = new Map();
  for (const station of information?.data?.stations ?? []) {
    if (station?.station_id === undefined) continue;
    const id = String(station.station_id);
    stations.set(id, {
      id,
      name: String(station.name ?? id),
      capacity: count(station.capacity),
      lat: count(station.lat),
      lon: count(station.lon),
    });
  }
  for (const live of status?.data?.stations ?? []) {
    if (live?.station_id === undefined) continue;
    const id = String(live.station_id);
    const station = stations.get(id) ?? { id, name: id };
    // `num_ebikes_available` is part of the bikes count in GBFS: the e-bikes
    // are a subset, not an addition.
    stations.set(id, {
      ...station,
      bikes: count(live.num_bikes_available),
      electricBikes: count(live.num_ebikes_available),
      docks: count(live.num_docks_available),
      installed: flag(live.is_installed, true),
      renting: flag(live.is_renting, true),
      returning: flag(live.is_returning, true),
      lastReported: count(live.last_reported),
    });
  }
  logger.debug(`BIXI: ${stations.size} station(s) read`);
  return stations;
}

/**
 * One watched station.
 *
 * @param {{ bixi_poll_frequency: number, language: string }} config
 * @param {{ id: string }} station
 * @param {{ now?: number }} [options]
 */
export async function fetchStation(config, station, options) {
  const stations = await fetchStations(config, options);
  const found = stations.get(station.id);
  if (!found) {
    throw new BixiError(`BIXI station ${station.id} is not in the network feed`);
  }
  return found;
}

/**
 * Stations whose name contains the query (case and accents ignored), for the
 * search action of the configuration screen.
 *
 * @param {{ bixi_poll_frequency: number, language: string }} config
 * @param {string} query
 * @param {{ limit?: number, now?: number }} [options]
 */
export async function searchStations(config, query, { limit = 15, now } = {}) {
  const needle = fold(query);
  const stations = await fetchStations(config, { now });
  return [...stations.values()]
    .filter((station) => fold(station.name).includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
    .slice(0, limit);
}

/** Lower case, without accents: "Côte-des-Neiges" matches "cote des neiges". */
export function fold(text) {
  return String(text)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[-'’]/g, ' ')
    .toLowerCase()
    .trim();
}
