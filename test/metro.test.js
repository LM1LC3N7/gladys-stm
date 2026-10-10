// -----------------------------------------------------------------------------
// Metro status: parsing the i3 "état du service" payload.
//
// The payloads below follow the shape the open-source readers of this API
// document (see CLAUDE.md): one alert per line, each informed entity carrying
// one attribute, French always filled and English sometimes null.
// -----------------------------------------------------------------------------

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAlert,
  ETAT_SERVICE_PATH,
  fetchMetroStatus,
  isActive,
  METRO_STATUS,
  parseEtatService,
  pickText,
} from '../src/api/metro.js';
import { normalizeConfig } from '../src/config.js';
import { restoreFetch, stubFetch } from './helpers/stubFetch.js';

const NOW_MS = 1_760_100_000_000;
const NOW = NOW_MS / 1000;

const texts = (fr, en = null) => [
  { language: 'fr', text: fr },
  { language: 'en', text: en },
];

const normal = (line) => ({
  active_periods: { start: NOW - 3600, end: null },
  informed_entities: [{ route_short_name: line }],
  header_texts: texts('Métro'),
  description_texts: texts('Service normal du métro', 'Normal métro service'),
});

function payload(alerts) {
  return { header: { timestamp: NOW }, alerts };
}

afterEach(() => restoreFetch());

test('four lines running normally', () => {
  const status = parseEtatService(payload(['1', '2', '4', '5'].map(normal)), {
    language: 'en',
    now: NOW_MS,
  });
  assert.equal(status.timestamp, NOW);
  assert.deepEqual(
    status.lines.map((line) => [line.id, line.status, line.message]),
    [
      ['1', 'normal', 'Normal métro service'],
      ['2', 'normal', 'Normal métro service'],
      ['4', 'normal', 'Normal métro service'],
      ['5', 'normal', 'Normal métro service'],
    ],
  );
});

test('a disruption wins over the normal-service alert of the same line', () => {
  const status = parseEtatService(
    payload([
      normal('1'),
      normal('2'),
      {
        active_periods: { start: NOW - 60, end: null },
        effect: 'NO_SERVICE',
        informed_entities: [{ route_short_name: '2' }, { direction_id: 'N' }],
        description_texts: texts(
          'Interruption de service entre Berri-UQAM et Côte-Vertu. Reprise prévue vers 8 h 30.',
        ),
      },
    ]),
    { language: 'en', now: NOW_MS },
  );
  const orange = status.lines.find((line) => line.id === '2');
  assert.equal(orange.status, METRO_STATUS.DISRUPTED);
  // English missing: the French text is the reference, and the normal-service
  // message of the same line is not mixed in.
  assert.match(orange.message, /^Interruption de service/);
  assert.equal(status.lines.find((line) => line.id === '1').status, METRO_STATUS.NORMAL);
  // No alert at all for the yellow line: unknown, not normal.
  assert.equal(status.lines.find((line) => line.id === '4').status, METRO_STATUS.UNKNOWN);
});

test('station-level alerts and inactive alerts do not change a line status', () => {
  const status = parseEtatService(
    payload([
      normal('5'),
      {
        informed_entities: [{ route_short_name: '5' }, { stop_code: '10146' }],
        description_texts: texts('Ascenseur fermé à la station Snowdon'),
      },
      {
        active_periods: [{ start: NOW + 3600, end: NOW + 7200 }],
        informed_entities: [{ route_short_name: '5' }],
        description_texts: texts('Interruption de service planifiée ce soir'),
      },
    ]),
    { language: 'fr', now: NOW_MS },
  );
  assert.equal(status.lines.find((line) => line.id === '5').status, METRO_STATUS.NORMAL);
});

test('an unusual message is a notice, a closure is a disruption', () => {
  assert.equal(
    classifyAlert({ description_texts: texts('Reprise graduelle du service') }),
    METRO_STATUS.NOTICE,
  );
  assert.equal(
    classifyAlert({ description_texts: texts('Station Peel fermée') }),
    METRO_STATUS.DISRUPTED,
  );
});

test('pickText falls back to French, then to any text', () => {
  assert.equal(pickText(texts('Bonjour', null), 'en'), 'Bonjour');
  assert.equal(pickText([{ language: 'xx', text: 'Autre' }], 'en'), 'Autre');
  assert.equal(pickText(undefined, 'fr'), '');
});

test('active periods: missing bounds are open', () => {
  assert.equal(isActive({}, NOW), true);
  assert.equal(isActive({ active_periods: { start: null, end: null } }, NOW), true);
  assert.equal(isActive({ active_periods: { start: NOW - 10, end: NOW - 1 } }, NOW), false);
});

test('fetchMetroStatus reads the i3 API with the key', async () => {
  const calls = stubFetch({ [ETAT_SERVICE_PATH]: payload(['1', '2', '4', '5'].map(normal)) });
  const status = await fetchMetroStatus(normalizeConfig({ stm_api_key: 'k' }), { now: NOW_MS });
  assert.equal(calls[0].headers.apiKey, 'k');
  assert.ok(status.lines.every((line) => line.status === METRO_STATUS.NORMAL));
});

test('a payload of an unexpected shape yields unknown lines, not an exception', () => {
  const status = parseEtatService({ result: { ligne1: 'ok' } }, { language: 'fr', now: NOW_MS });
  assert.ok(status.lines.every((line) => line.status === METRO_STATUS.UNKNOWN));
});
