// -----------------------------------------------------------------------------
// Device type: METRO STATUS (état du service du métro)
//
// One device for the whole network, created when "Watch the metro" is on.
// Read-only, refreshed at `metro_poll_frequency` from the STM i3 API.
//
// Features, for each of the four lines:
//   - "<line> status"  : normal / disrupted / notice / unknown, as a short
//                        label in the configured language (text sensor) —
//                        what a scene condition or a dashboard tile compares;
//   - "<line> message" : the STM message itself ("Service normal du métro",
//                        or the disruption text) (text sensor).
//
// The statuses keep an history: "how often was the orange line down this
// month" is a question the history answers, and a status changes a few times
// a day at most — the state cache only publishes the changes.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
} from '@gladysassistant/integration-sdk';
import { gladysPollFrequency } from '../config.js';
import { TEXT_FEATURE_RANGE } from './featureRange.js';
import { changedStates } from './stateCache.js';
import { publishDeviceStates } from './publish.js';
import { fetchMetroStatus, METRO_LINES, METRO_STATUS } from '../api/metro.js';

export const DEVICE_TYPE = 'stm-metro';
const PLATFORM_ID = 'network';

const logger = createLogger({ name: DEVICE_TYPE });

/** Feature key of a line's status label. */
export const statusFeatureKey = (lineId) => `line_${lineId}_status`;
/** Feature key of a line's message. */
export const messageFeatureKey = (lineId) => `line_${lineId}_message`;

/** The status labels, as published in the text features. */
export const STATUS_LABELS = {
  [METRO_STATUS.NORMAL]: { en: 'Normal', fr: 'Normal' },
  [METRO_STATUS.DISRUPTED]: { en: 'Disrupted', fr: 'Perturbé' },
  [METRO_STATUS.NOTICE]: { en: 'Notice', fr: 'Avis' },
  [METRO_STATUS.UNKNOWN]: { en: 'Unknown', fr: 'Inconnu' },
};

const LABELS = {
  en: { device: 'STM metro', status: 'status', message: 'message' },
  fr: { device: 'Métro STM', status: 'état', message: 'message' },
};

/** The blueprint of the metro status device. */
export function createMetroStatusBlueprint() {
  return {
    key: `${DEVICE_TYPE}:${PLATFORM_ID}`,
    type: DEVICE_TYPE,

    deviceExternalId(gladys) {
      return gladys.externalIds(DEVICE_TYPE, PLATFORM_ID).device;
    },

    pollIntervalMs(config) {
      return config.metro_poll_frequency * 1000;
    },

    buildDevice(gladys, config) {
      const ids = gladys.externalIds(DEVICE_TYPE, PLATFORM_ID);
      const labels = LABELS[config.language];
      const features = METRO_LINES.flatMap((line) => [
        {
          name: `${line.name[config.language]} – ${labels.status}`,
          external_id: ids.feature(statusFeatureKey(line.id)),
          category: DEVICE_FEATURE_CATEGORIES.TEXT,
          type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
          ...TEXT_FEATURE_RANGE,
          read_only: true,
          has_feedback: false,
          keep_history: true,
        },
        {
          name: `${line.name[config.language]} – ${labels.message}`,
          external_id: ids.feature(messageFeatureKey(line.id)),
          category: DEVICE_FEATURE_CATEGORIES.TEXT,
          type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
          ...TEXT_FEATURE_RANGE,
          read_only: true,
          has_feedback: false,
          keep_history: false,
        },
      ]);

      return {
        name: labels.device,
        external_id: ids.device,
        poll_frequency: gladysPollFrequency(config.metro_poll_frequency),
        should_poll: true,
        params: [{ name: 'source', value: 'api.stm.info' }],
        features,
      };
    },

    /** The status of the four lines (see src/api/metro.js). */
    read(config) {
      return fetchMetroStatus(config);
    },

    async onPoll(gladys, config) {
      const ids = gladys.externalIds(DEVICE_TYPE, PLATFORM_ID);
      const status = await this.read(config);

      logger.info(`Metro: ${status.lines.map((line) => `${line.id}=${line.status}`).join(', ')}`);

      const states = status.lines.flatMap((line) => [
        {
          device_feature_external_id: ids.feature(statusFeatureKey(line.id)),
          text: STATUS_LABELS[line.status][config.language],
        },
        {
          device_feature_external_id: ids.feature(messageFeatureKey(line.id)),
          text: line.message,
        },
      ]);

      const updates = changedStates(states);
      if (updates.length > 0) {
        await publishDeviceStates(gladys, ids.device, updates);
      }
      return status;
    },
  };
}
