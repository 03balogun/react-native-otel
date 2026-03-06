import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import {
  ATTR_APP_BUILD_ID,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_DEVICE_MANUFACTURER,
  ATTR_DEVICE_MODEL_NAME,
  ATTR_OS_NAME,
  ATTR_OS_VERSION,
} from '../semantic-conventions';

import type { Attributes } from './attributes';

export interface Resource {
  [ATTR_SERVICE_NAME]: string; // 'service.name'
  [ATTR_SERVICE_VERSION]: string; // 'service.version'
  [ATTR_OS_NAME]: string; // 'os.name'
  [ATTR_OS_VERSION]: string; // 'os.version'
  [ATTR_DEVICE_MANUFACTURER]: string; // 'device.manufacturer'
  [ATTR_DEVICE_MODEL_NAME]: string; // 'device.model.name'
  'device.type': string | number; // custom — no OTel equivalent
  [ATTR_APP_BUILD_ID]: string; // 'app.build_id'
  [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: string; // 'deployment.environment.name'
  [key: string]: unknown; // extra user-supplied resource attributes
}

// Populated at init time from device/app info passed in by the caller.
// Immutable after creation — user identity is NOT stored here.
export function buildResource(params: {
  serviceName: string;
  serviceVersion: string;
  osName: string;
  osVersion: string;
  deviceBrand: string;
  deviceModel: string;
  deviceType: string | number;
  appBuild: string;
  environment: string;
  // Optional extra attributes merged last (user-supplied overrides nothing standard).
  extra?: Attributes;
}): Readonly<Resource> {
  return Object.freeze({
    ...params.extra,
    [ATTR_SERVICE_NAME]: params.serviceName,
    [ATTR_SERVICE_VERSION]: params.serviceVersion,
    [ATTR_OS_NAME]: params.osName,
    [ATTR_OS_VERSION]: params.osVersion,
    [ATTR_DEVICE_MANUFACTURER]: params.deviceBrand,
    [ATTR_DEVICE_MODEL_NAME]: params.deviceModel,
    'device.type': params.deviceType,
    [ATTR_APP_BUILD_ID]: params.appBuild,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: params.environment,
  });
}
