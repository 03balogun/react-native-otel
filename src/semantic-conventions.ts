// Incubating/experimental OTel semantic convention attributes inlined here to
// avoid the `@opentelemetry/semantic-conventions/incubating` subpath export,
// which React Native bundlers (Metro) cannot resolve.
// Values sourced from @opentelemetry/semantic-conventions experimental_attributes.js

export const ATTR_APP_BUILD_ID = 'app.build_id' as const;
export const ATTR_APP_SCREEN_NAME = 'app.screen.name' as const;
export const ATTR_DEPLOYMENT_ENVIRONMENT_NAME =
  'deployment.environment.name' as const;
export const ATTR_DEVICE_MANUFACTURER = 'device.manufacturer' as const;
export const ATTR_DEVICE_MODEL_NAME = 'device.model.name' as const;
export const ATTR_OS_NAME = 'os.name' as const;
export const ATTR_OS_VERSION = 'os.version' as const;
