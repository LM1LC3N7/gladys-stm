// -----------------------------------------------------------------------------
// Entry point of the STM Gladys integration.
//
// Role of this file: wire the SDK to the device catalog (src/devices/). It
// holds no transit logic: reading the APIs lives in src/api/, and turning a
// reading into features lives in src/devices/. This file only:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. connects and publishes the discovered devices.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { estimatedDailyRequests, hasStmApiKey, normalizeConfig } from './src/config.js';
import {
  ACTIONS,
  buildDiscoveredDevices,
  pollDevice,
  refreshDeviceNow,
} from './src/devices/index.js';
import { clearPollSchedule } from './src/devices/pollSchedule.js';
import { clearStateCache } from './src/devices/stateCache.js';
import { clearPublishReports } from './src/devices/publish.js';
import { clearReadings } from './src/devices/readings.js';
import { startRefreshLoop, stopRefreshLoop } from './src/devices/refreshLoop.js';
import { clearStmCache } from './src/api/stm.js';
import { clearBixiCache } from './src/api/bixi.js';
import { clearSceneMemory } from './src/scenes/triggers.js';
import { SCENE_ACTIONS } from './src/scenes/actions.js';
import { WIDGETS } from './src/widgets/index.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> publishing the configured stops, metro and stations');
  await publishDevices();
});

// --- Polling: Gladys asks to refresh a device --------------------------------
// The core scheduler ticks at the `poll_frequency` the device was published
// with (one minute at the slowest); `pollDevice` routes the tick to the right
// blueprint and drops the ones inside the configured refresh interval. The
// container also ticks on its own (src/devices/refreshLoop.js); both paths go
// through the same gate, so each source is read once per interval.
gladys.onPoll(async (device) => {
  await pollDevice(gladys, device, config);
});

// --- A device was just created, or updated from the Discovery screen --------
// Gladys dropped the states sent before the feature existed: read it now
// rather than after whatever remains of the refresh interval.
const refreshAddedDevice = (event) => async (device) => {
  try {
    await refreshDeviceNow(gladys, device, config);
  } catch (err) {
    logger.warn(`Reading ${device?.external_id} after it was ${event} failed: ${err.message}`);
  }
};
gladys.onDeviceCreated(refreshAddedDevice('created'));
gladys.onDeviceUpdated(refreshAddedDevice('updated'));

// --- Manifest actions: buttons in the Configuration screen -------------------
for (const [actionKey, handler] of Object.entries(ACTIONS)) {
  gladys.onAction(actionKey, (fields) => handler(gladys, { fields: fields ?? {}, config }));
}

// --- Scene actions (Gladys >= 5.1) -------------------------------------------
// The scene TRIGGERS need no handler: they are fired from the poll path (see
// src/scenes/triggers.js).
for (const [actionKey, handler] of Object.entries(SCENE_ACTIONS)) {
  gladys.onSceneAction(actionKey, (fields) => handler(gladys, { fields: fields ?? {}, config }));
}

// --- Dashboard widgets (Gladys >= 5.1) ---------------------------------------
for (const [widgetKey, handler] of Object.entries(WIDGETS)) {
  gladys.onWidgetGet(widgetKey, ({ settings }) =>
    handler(gladys, { settings: settings ?? {}, config }),
  );
}

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
  // The key or the watch lists may have changed: anything cached or
  // remembered under the previous configuration is now suspect.
  clearStmCache();
  clearBixiCache();
  clearPollSchedule();
  clearReadings();
  clearStateCache();
  clearPublishReports();
  clearSceneMemory();
  await publishDevices();
  await reportConnectionStatus();
  startRefreshLoop(gladys, () => config);
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  try {
    // 1) Fetch the config filled in by the user.
    config = normalizeConfig(await gladys.getConfig());

    // A (re)connection may be another Gladys: publish everything once, then
    // only the changes (see src/devices/stateCache.js).
    clearStateCache();
    clearPublishReports();

    // 2) Refresh the devices the user already created, now and at every tick.
    // It comes before the publication on purpose: a publication that fails
    // must not leave the existing devices without anything refreshing them.
    startRefreshLoop(gladys, () => config);

    // 3) (Re)publish all configured devices.
    await publishDevices();

    // 4) Report the application-level status, shown in the Configuration
    // screen.
    await reportConnectionStatus();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

// Reading the APIs while Gladys is unreachable would only throw the result
// away — and spend the STM quota for nothing.
gladys.on('disconnected', () => {
  stopRefreshLoop();
});

/** Publish the devices described by the current configuration, by name. */
async function publishDevices() {
  const devices = buildDiscoveredDevices(gladys, config);
  logger.info(
    devices.length === 0
      ? 'No device to publish: nothing is watched in the configuration'
      : `Publishing ${devices.length} device(s): ${devices.map((device) => device.name).join(', ')}`,
  );
  await gladys.publishDiscoveredDevices(devices);
}

/**
 * A short bilingual inventory of what the configuration asks for, shown next
 * to the connection status: how the user checks that the entry they just typed
 * was understood, without opening the container logs.
 */
function describeWatchList({ stops, bixiStations, metro }) {
  const parts = [
    { count: stops.length, en: 'bus stop', fr: 'arrêt' },
    { count: bixiStations.length, en: 'BIXI station', fr: 'station BIXI' },
  ].filter((part) => part.count > 0);
  const plural = (part, language) => `${part.count} ${part[language]}${part.count > 1 ? 's' : ''}`;
  const en = parts.map((part) => plural(part, 'en'));
  const fr = parts.map((part) => plural(part, 'fr'));
  if (metro) {
    en.unshift('the metro');
    fr.unshift('le métro');
  }
  return { en: en.join(', '), fr: fr.join(', ') };
}

/**
 * Tell Gladys whether the integration is actually able to do its job. BIXI
 * needs no key: an integration watching only BIXI stations is fully
 * operational without one.
 */
async function reportConnectionStatus() {
  const { stops, bixiStations, metro } = config.watched;
  const needsKey = stops.length > 0 || metro;

  if (needsKey && !hasStmApiKey(config)) {
    await gladys.setConnectionStatus(false, {
      en: 'Bus stops and the metro status need an STM API key: create one on the STM developer portal.',
      fr: 'Les arrêts et l’état du métro nécessitent une clé d’API STM : créez-la sur le portail développeurs de la STM.',
    });
    return;
  }

  if (stops.length + bixiStations.length === 0 && !metro) {
    await gladys.setConnectionStatus(false, {
      en: 'Nothing to watch yet: add a bus stop or a BIXI station, or turn on the metro.',
      fr: 'Rien à surveiller : ajoutez un arrêt ou une station BIXI, ou activez le métro.',
    });
    return;
  }

  const watched = describeWatchList(config.watched);
  const requests = estimatedDailyRequests(config);
  await gladys.setConnectionStatus(true, {
    en: `Connected. Watching ${watched.en} (about ${requests} STM requests a day).`,
    fr: `Connecté. Surveille ${watched.fr} (environ ${requests} requêtes STM par jour).`,
  });
}

// --- Safety net for a forgotten promise --------------------------------------
// A promise that slips through one day would, by Node's default, kill the
// container — and every device with it. Log it and keep running: the next tick
// reads again. An uncaught EXCEPTION is left alone on purpose: the process
// state is then unknown, and restarting is the right call.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', reason);
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stopRefreshLoop();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the STM integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
