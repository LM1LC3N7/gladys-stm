// -----------------------------------------------------------------------------
// The connection status shown in the Configuration screen of the integration.
//
// For somebody who is not technical, this line IS the user interface: it is
// the one place Gladys shows what the integration is doing. So it never says
// "connected" and stops there — it says what the user has to do next, in the
// order they have to do it:
//   1. nothing to show yet: locate the house in Gladys, or type a stop code;
//   2. devices waiting: open the Discovery tab and press "Add";
//   3. everything added: what is watched, and what an STM key would add.
//
// Each message fits in a couple of lines of the Configuration screen.
// -----------------------------------------------------------------------------

import { buildDiscoveredDevices } from './devices/index.js';
import { DEVICE_TYPE as BUS_STOP_TYPE } from './devices/busStop.js';
import { DEVICE_TYPE as BIXI_TYPE } from './devices/bixiStation.js';
import { DEVICE_TYPE as METRO_TYPE } from './devices/metroStatus.js';
import { getSuggestions } from './devices/suggestions.js';
import { departuresSource, estimatedDailyRequests, hasStmApiKey } from './config.js';

/** The kind of a discovered device, from its external id (`…:<type>:<id>`). */
function kindOf(device) {
  for (const type of [BUS_STOP_TYPE, BIXI_TYPE, METRO_TYPE]) {
    if (device.external_id.includes(`${type}:`)) return type;
  }
  return null;
}

/** "3 arrêts, 1 station BIXI et le métro" — or its English twin. */
export function inventory({ stops, stations, metro }) {
  const plural = (count, word) => `${count} ${word}${count > 1 ? 's' : ''}`;
  const join = (parts, and) =>
    parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} ${and} ${parts.at(-1)}`;
  const en = [];
  const fr = [];
  if (stops > 0) {
    en.push(plural(stops, 'bus stop'));
    fr.push(plural(stops, 'arrêt'));
  }
  if (stations > 0) {
    en.push(plural(stations, 'BIXI station'));
    fr.push(stations > 1 ? `${stations} stations BIXI` : '1 station BIXI');
  }
  if (metro) {
    en.push('the metro');
    fr.push('le métro');
  }
  return { en: join(en, 'and'), fr: join(fr, 'et') };
}

const NOTHING_YET = {
  no_location: {
    en: 'To find the stops near you, set the address of your house in Gladys (Settings → Houses), then save this configuration again. Or type a stop code below.',
    fr: 'Pour trouver les arrêts près de chez vous, indiquez l’adresse de votre maison dans Gladys (Paramètres → Maisons), puis enregistrez à nouveau cette configuration. Ou tapez un code d’arrêt ci-dessous.',
  },
  no_house: {
    en: 'Gladys did not share the location of your house: type a stop code below, or reinstall the integration and accept the location access.',
    fr: 'Gladys n’a pas partagé la position de votre maison : tapez un code d’arrêt ci-dessous, ou réinstallez l’intégration en acceptant l’accès à la position.',
  },
  failed: {
    en: 'The stops near your house could not be looked up right now: save the configuration again in a few minutes, or type a stop code below.',
    fr: 'Les arrêts près de chez vous n’ont pas pu être cherchés : enregistrez à nouveau la configuration dans quelques minutes, ou tapez un code d’arrêt ci-dessous.',
  },
  disabled: {
    en: 'Nothing to watch yet: type a bus stop code or a BIXI station below, or turn the suggestions near your house back on.',
    fr: 'Rien à surveiller : tapez un code d’arrêt ou une station BIXI ci-dessous, ou réactivez les suggestions près de chez vous.',
  },
};

/**
 * What the status line says, and whether the integration counts as connected.
 *
 * @param {object} gladys
 * @param {ReturnType<import('./config.js').normalizeConfig>} config
 * @returns {{ connected: boolean, message: { en: string, fr: string } }}
 */
export function describeStatus(gladys, config) {
  const discovered = buildDiscoveredDevices(gladys, config);
  if (discovered.length === 0) {
    const reason = NOTHING_YET[getSuggestions().status] ?? NOTHING_YET.disabled;
    return { connected: false, message: reason };
  }

  const count = (devices, type) => devices.filter((device) => kindOf(device) === type).length;
  const stops = count(discovered, BUS_STOP_TYPE);

  if (stops > 0 && departuresSource(config) === 'none') {
    return {
      connected: false,
      message: {
        en: 'Bus stops need an STM API key, or the scheduled times turned on: see the documentation of the integration.',
        fr: 'Les arrêts d’autobus demandent une clé d’API STM, ou les horaires prévus activés : voir la documentation de l’intégration.',
      },
    };
  }

  const created = new Set((gladys.devices ?? []).map((device) => device.external_id));
  const waiting = discovered.filter((device) => !created.has(device.external_id));
  const keyHint = hasStmApiKey(config)
    ? { en: '', fr: '' }
    : config.watched.metro
      ? {
          en: ' Scheduled times only: an STM key adds real time and the metro status.',
          fr: ' Horaires prévus seulement : une clé STM ajoute le temps réel et l’état du métro.',
        }
      : {
          en: ' Scheduled times only: an STM key adds real time.',
          fr: ' Horaires prévus seulement : une clé STM ajoute le temps réel.',
        };

  if (waiting.length > 0) {
    const what = inventory({
      stops: count(waiting, BUS_STOP_TYPE),
      stations: count(waiting, BIXI_TYPE),
      metro: count(waiting, METRO_TYPE) > 0,
    });
    return {
      connected: true,
      message: {
        en: `Ready: ${what.en} to add. Open the “Discover” tab of this integration and press “Add”.${keyHint.en}`,
        fr: `Prêt : ${what.fr} à ajouter. Ouvrez l’onglet « Découverte » de cette intégration et cliquez sur « Ajouter ».${keyHint.fr}`,
      },
    };
  }

  const what = inventory({
    stops,
    stations: count(discovered, BIXI_TYPE),
    metro: count(discovered, METRO_TYPE) > 0,
  });
  const requests = estimatedDailyRequests(config, { busStops: stops });
  const quota = hasStmApiKey(config)
    ? {
        en: ` (about ${requests} STM requests a day).`,
        fr: ` (environ ${requests} requêtes STM par jour).`,
      }
    : { en: '.', fr: '.' };
  return {
    connected: true,
    message: {
      en: `Connected. Watching ${what.en}${quota.en}${keyHint.en}`,
      fr: `Connecté. Surveille ${what.fr}${quota.fr}${keyHint.fr}`,
    },
  };
}
