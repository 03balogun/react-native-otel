import { Tracer } from '../core/tracer';

// Capture the module-load timestamp as a proxy for the earliest possible
// start time.  Importing this module before SDK init will give a longer
// (more accurate) cold-start duration.
const MODULE_LOAD_TIME_MS = Date.now();

let startupSpanInstalled = false;

/**
 * Emits a single `app.startup` span whose duration covers the period from
 * module-load time (or SDK init time if this module was imported later) to
 * the point when this function is called — typically just before rendering
 * the first screen.
 *
 * Call this once, as early as possible in your app entry point, after
 * `otel.init()` completes.
 *
 * Returns the span so callers can add custom attributes before it ends.
 */
export function installStartupInstrumentation(tracer: Tracer): void {
  if (startupSpanInstalled) return;
  startupSpanInstalled = true;

  const sdkInitTime = Date.now();
  const startTime = Math.min(MODULE_LOAD_TIME_MS, sdkInitTime);

  const span = tracer.startSpan('app.startup', {
    kind: 'INTERNAL',
    attributes: {
      'app.startup.module_load_ms': MODULE_LOAD_TIME_MS,
      'app.startup.sdk_init_ms': sdkInitTime,
    },
    // Force root span — startup is not a child of any screen span.
    parent: null,
  });

  // Back-date the span start to when the module was loaded.
  if ('startTimeMs' in span) {
    (span as { startTimeMs: number }).startTimeMs = startTime;
  }

  span.end();
}

/** Reset for testing purposes only. */
export function _resetStartupInstrumentation(): void {
  startupSpanInstalled = false;
}
