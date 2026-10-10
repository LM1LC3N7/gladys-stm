// -----------------------------------------------------------------------------
// STM metro service status: the "i3" API (état du service).
//
// The STM publishes its service messages — the ones shown on the station
// screens and in the app — as a JSON list of alerts:
//
//   { header: { timestamp },
//     alerts: [ { active_periods, cause, effect,
//                 informed_entities: [ { route_short_name: "2" }, { stop_code: "10146" } ],
//                 header_texts:      [ { language: "fr", text }, { language: "en", text } ],
//                 description_texts: [ { language: "fr", text }, { language: "en", text } ] } ] }
//
// The format is not documented in the open (the developer portal is behind a
// login); this shape comes from the open-source projects that read the API,
// MTransit first (see CLAUDE.md for the references), and is parsed
// defensively:
//   - each informed entity carries ONE attribute (a route, a direction or a
//     stop): an alert about a line has a `route_short_name` entity, an alert
//     about a station adds a `stop_code` one;
//   - `active_periods` is an object in v2 and was an array in v1;
//   - the English text may be null, the French one is the reference.
//
// There is no "status" field: every metro line carries an alert whose text is
// "Service normal du métro" / "Normal métro service" when nothing is wrong, and
// the disruption message otherwise. The status is therefore read from the text
// — the same phrases MTransit and other readers of this API match.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { stmRequest } from './stm.js';

const logger = createLogger({ name: 'metro' });

export const ETAT_SERVICE_PATH = '/i3/v2/messages/etatservice';

/** The four lines of the network, by route_short_name. Never rename a key. */
export const METRO_LINES = [
  { id: '1', name: { en: 'Green line', fr: 'Ligne verte' } },
  { id: '2', name: { en: 'Orange line', fr: 'Ligne orange' } },
  { id: '4', name: { en: 'Yellow line', fr: 'Ligne jaune' } },
  { id: '5', name: { en: 'Blue line', fr: 'Ligne bleue' } },
];

/** What a line can be doing, from the integration's point of view. */
export const METRO_STATUS = {
  NORMAL: 'normal',
  DISRUPTED: 'disrupted',
  NOTICE: 'notice',
  UNKNOWN: 'unknown',
};

const NORMAL_TEXT = /service normal du m[eé]tro|normal m[eé]tro service/i;
const DISRUPTED_TEXT =
  /interruption de service|service interrompu|service disrupt|service interruption|ferm[ée]e?|closed|arr[eê]t de service|no service/i;
const DISRUPTED_EFFECTS = new Set(['NO_SERVICE', 'REDUCED_SERVICE', 'SIGNIFICANT_DELAYS']);

/**
 * The text of a translated field, in the wanted language, else in French
 * (always filled), else in any language at all.
 *
 * @param {{ language?: string, text?: string | null }[] | undefined} texts
 * @param {string} language
 * @returns {string}
 */
export function pickText(texts, language) {
  const list = Array.isArray(texts) ? texts : [];
  const byLanguage = (lang) => list.find((entry) => entry?.language === lang && entry.text)?.text;
  return String(
    byLanguage(language) ?? byLanguage('fr') ?? list.find((entry) => entry?.text)?.text ?? '',
  ).trim();
}

/**
 * Whether an alert applies now. A missing bound is open, and a missing period
 * means "always" — that is how the permanent "normal service" alerts come.
 *
 * @param {object} alert
 * @param {number} nowSeconds
 */
export function isActive(alert, nowSeconds) {
  const raw = alert?.active_periods;
  const periods = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (periods.length === 0) {
    return true;
  }
  return periods.some((period) => {
    const start = Number(period?.start);
    const end = Number(period?.end);
    const started = !Number.isFinite(start) || start === 0 || start <= nowSeconds;
    const notEnded = !Number.isFinite(end) || end === 0 || end >= nowSeconds;
    return started && notEnded;
  });
}

/**
 * The status an alert's text and effect describe.
 * @param {object} alert
 * @returns {string} a METRO_STATUS value
 */
export function classifyAlert(alert) {
  const texts = [...(alert?.description_texts ?? []), ...(alert?.header_texts ?? [])]
    .map((entry) => entry?.text ?? '')
    .join(' ');
  if (NORMAL_TEXT.test(texts)) {
    return METRO_STATUS.NORMAL;
  }
  if (DISRUPTED_TEXT.test(texts) || DISRUPTED_EFFECTS.has(String(alert?.effect ?? ''))) {
    return METRO_STATUS.DISRUPTED;
  }
  // A service resuming, a planned closure announced for later tonight, an
  // elevator out of order on the line: worth showing, not worth an alarm.
  return METRO_STATUS.NOTICE;
}

// The worst status wins when a line has several alerts.
const SEVERITY = {
  [METRO_STATUS.UNKNOWN]: 0,
  [METRO_STATUS.NORMAL]: 1,
  [METRO_STATUS.NOTICE]: 2,
  [METRO_STATUS.DISRUPTED]: 3,
};

/**
 * The status of the four metro lines out of an etatservice payload.
 *
 * Only the alerts about a whole line count: an alert that also names a
 * station (`stop_code`) is about that station — an elevator, an entrance —
 * and a line running normally with one closed entrance is running normally.
 *
 * @param {object} payload parsed JSON
 * @param {{ language: string, now?: number }} options
 * @returns {{ timestamp: number | undefined,
 *   lines: { id: string, name: { en: string, fr: string }, status: string, message: string }[] }}
 */
export function parseEtatService(payload, { language, now = Date.now() }) {
  const nowSeconds = Math.floor(now / 1000);
  const lines = new Map(
    METRO_LINES.map((line) => [
      line.id,
      { ...line, status: METRO_STATUS.UNKNOWN, message: '', messages: [] },
    ]),
  );

  for (const alert of Array.isArray(payload?.alerts) ? payload.alerts : []) {
    const entities = Array.isArray(alert?.informed_entities) ? alert.informed_entities : [];
    if (entities.some((entity) => entity?.stop_code)) continue;
    if (!isActive(alert, nowSeconds)) continue;
    const routes = entities
      .map((entity) => (entity?.route_short_name == null ? null : String(entity.route_short_name)))
      .filter((route) => route !== null && lines.has(route));
    if (routes.length === 0) continue;

    const status = classifyAlert(alert);
    const message =
      pickText(alert.description_texts, language) || pickText(alert.header_texts, language);
    for (const route of new Set(routes)) {
      const line = lines.get(route);
      if (SEVERITY[status] > SEVERITY[line.status]) {
        line.status = status;
      }
      if (message && !line.messages.some((entry) => entry.text === message)) {
        line.messages.push({ status, text: message });
      }
    }
  }

  const result = [...lines.values()].map(({ messages, ...line }) => {
    // The message shown is the one of the status retained: a normal-service
    // line under a disruption would otherwise read "Service normal du métro".
    const shown = messages
      .filter((entry) => entry.status === line.status)
      .map((entry) => entry.text);
    return { ...line, message: shown.join(' ') };
  });

  const timestamp = Number(payload?.header?.timestamp);
  return { timestamp: Number.isFinite(timestamp) ? timestamp : undefined, lines: result };
}

/**
 * Read the current status of the metro lines.
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {{ now?: number }} [options]
 */
export async function fetchMetroStatus(config, { now = Date.now() } = {}) {
  const response = await stmRequest(config, ETAT_SERVICE_PATH, 'application/json');
  const payload = await response.json();
  const status = parseEtatService(payload, { language: config.language, now });
  logger.debug(
    `Metro status: ${status.lines.map((line) => `${line.id}=${line.status}`).join(', ')}`,
  );
  return status;
}
