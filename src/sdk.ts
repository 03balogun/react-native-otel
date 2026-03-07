import { Platform } from 'react-native';

import type { Attributes } from './core/attributes';
import type { Resource } from './core/resource';
import type {
  SpanExporter,
  MetricExporter,
  LogExporter,
} from './exporters/types';
import type { StorageAdapter } from './instrumentation/errors';
import type { Sampler } from './core/sampler';
import type { SpanProcessor } from './core/span';
import { spanContext } from './context/span-context';
import { setMaxStringLength } from './core/attributes';
import { OtelLogger } from './core/log-record';
import { Meter } from './core/meter';
import { buildResource } from './core/resource';
import { Tracer } from './core/tracer';
import { installErrorInstrumentation } from './instrumentation/errors';
import { installLifecycleInstrumentation } from './instrumentation/lifecycle';
import {
  createFetchInstrumentation,
  uninstallFetchInstrumentation,
} from './instrumentation/fetch';
import type { FetchInstrumentationOptions } from './instrumentation/fetch';
import { setFetchImpl } from './exporters/wal';

/**
 * Implement this interface to let the SDK pause/resume flush operations based
 * on network connectivity — without adding a native dependency.
 *
 * Example (using @react-native-community/netinfo):
 * ```ts
 * import NetInfo from '@react-native-community/netinfo';
 *
 * const networkAdapter: NetworkAdapter = {
 *   addListener(cb) {
 *     const unsub = NetInfo.addEventListener(state => cb(!!state.isConnected));
 *     return unsub;
 *   },
 * };
 * otel.init({ ..., networkAdapter });
 * ```
 */
export interface NetworkAdapter {
  /**
   * Register a callback that is called with `true` when the device comes
   * online and `false` when it goes offline.
   * Returns an unsubscribe function.
   */
  addListener(cb: (isConnected: boolean) => void): () => void;
}

export interface OtelConfig {
  serviceName: string;
  serviceVersion?: string;
  osName?: string;
  osVersion?: string;
  deviceBrand?: string;
  deviceModel?: string;
  deviceType?: string | number;
  appBuild?: string;
  environment?: string;
  exporter?: SpanExporter;
  metricExporter?: MetricExporter;
  logExporter?: LogExporter;
  sampleRate?: number;
  sampler?: Sampler;
  processors?: SpanProcessor[];
  debug?: boolean;
  storage?: StorageAdapter;
  // Extra resource attributes merged into the resource (after standard fields).
  resourceAttributes?: Attributes;
  // Plug in a connectivity adapter to pause flushing when offline.
  networkAdapter?: NetworkAdapter;
  // Truncate string attribute values longer than this. Default: 1024.
  maxAttributeStringLength?: number;
  // Dot-notation paths to redact from network captures.
  // Sections: header, body, param, response
  // Examples: ['header.authorization', 'body.password', 'response.token']
  sensitiveKeys?: string[];
  // Options forwarded to the auto-installed fetch instrumentation.
  fetchOptions?: FetchInstrumentationOptions;
}

class OtelSDK {
  private userAttributes_: Attributes = {};
  private tracer_: Tracer | undefined;
  private meter_: Meter | undefined;
  private logger_: OtelLogger | undefined;
  private resource_: Readonly<Resource> | undefined;
  private exporter_: SpanExporter | undefined;
  private metricExporter_: MetricExporter | undefined;
  private logExporter_: LogExporter | undefined;
  private sensitiveKeys_: string[] = [];
  private isOnline_ = true;
  private networkUnsubscribe_: (() => void) | undefined;
  private initialized = false;

  init(config: OtelConfig): void {
    if (this.initialized) return;
    this.initialized = true;

    if (config.maxAttributeStringLength !== undefined) {
      setMaxStringLength(config.maxAttributeStringLength);
    }

    this.sensitiveKeys_ = config.sensitiveKeys ?? [];
    this.exporter_ = config.exporter;
    this.metricExporter_ = config.metricExporter;
    this.logExporter_ = config.logExporter;

    // Auto-detect platform fields when not explicitly provided.
    const osName = config.osName ?? Platform.OS;
    const osVersion = config.osVersion ?? String(Platform.Version);

    this.resource_ = buildResource({
      serviceName: config.serviceName,
      serviceVersion: config.serviceVersion ?? '0.0.0',
      osName,
      osVersion,
      deviceBrand: config.deviceBrand ?? '',
      deviceModel: config.deviceModel ?? '',
      deviceType: config.deviceType ?? '',
      appBuild: config.appBuild ?? '',
      environment: config.environment ?? 'production',
      extra: config.resourceAttributes,
    });

    // If any exporter supports resource/storage injection (e.g. OtlpHttp*Exporter),
    // hand it the resource and optional storage so it can include them in payloads
    // and persist undelivered batches across sessions.
    const injectResource = (exp: unknown) => {
      if (exp && typeof exp === 'object' && 'setResource' in exp) {
        (exp as { setResource(r: Readonly<Resource>): void }).setResource(
          this.resource_ as Readonly<Resource>
        );
      }
    };
    const injectStorage = (exp: unknown) => {
      if (
        config.storage &&
        exp &&
        typeof exp === 'object' &&
        'setStorage' in exp
      ) {
        (exp as { setStorage(s: typeof config.storage): void }).setStorage(
          config.storage
        );
      }
    };
    injectResource(config.exporter);
    injectResource(config.metricExporter);
    injectResource(config.logExporter);
    injectStorage(config.exporter);
    injectStorage(config.metricExporter);
    injectStorage(config.logExporter);

    this.tracer_ = new Tracer({
      exporter: config.exporter,
      sampleRate: config.sampleRate,
      sampler: config.sampler,
      processors: config.processors,
      getUserAttributes: () => ({ ...this.userAttributes_ }),
    });

    this.meter_ = new Meter(config.metricExporter);
    this.logger_ = new OtelLogger(config.logExporter);

    // Wire up connectivity-aware flushing when a NetworkAdapter is supplied.
    if (config.networkAdapter) {
      this.networkUnsubscribe_ = config.networkAdapter.addListener(
        (isConnected) => {
          this.isOnline_ = isConnected;
          if (isConnected) {
            // Flush buffered data immediately when coming back online.
            this.flush();
          }
        }
      );
    }

    // Lock the WAL's fetch to the original (pre-patch) implementation so that
    // OTLP delivery calls are never themselves instrumented — which would cause
    // infinite recursion once fetch instrumentation is installed below.
    setFetchImpl(globalThis.fetch);

    // Auto-install fetch instrumentation. Wraps globalThis.fetch to create a
    // CLIENT span for every app-level HTTP request. The OTLP exporter is immune
    // because it uses the pre-patch fetch captured above.
    createFetchInstrumentation(this.tracer_, config.fetchOptions);

    // Check for pending crash span and install global error handler
    installErrorInstrumentation({
      tracer: this.tracer_,
      storage: config.storage,
      exporter: config.exporter,
    });

    // Install lifecycle instrumentation
    installLifecycleInstrumentation(this.meter_);
  }

  // Records a named event on the current screen span.
  // Safe to call before init() — silently no-ops if SDK is not yet initialized.
  recordEvent(name: string, properties?: Record<string, unknown>): void {
    this.tracer_?.recordEvent(name, properties as unknown as Attributes);
  }

  setUser(user: { id?: string; email?: string }): void {
    this.userAttributes_ = {
      ...(user.id ? { 'user.id': user.id } : {}),
      ...(user.email ? { 'user.email': user.email } : {}),
    };
  }

  getTracer(): Tracer {
    if (!this.tracer_) {
      throw new Error(
        '[react-native-otel] SDK not initialized. Call otel.init() first.'
      );
    }
    return this.tracer_;
  }

  getMeter(): Meter {
    if (!this.meter_) {
      throw new Error(
        '[react-native-otel] SDK not initialized. Call otel.init() first.'
      );
    }
    return this.meter_;
  }

  getSensitiveKeys(): string[] {
    return this.sensitiveKeys_;
  }

  getLogger(): OtelLogger {
    if (!this.logger_) {
      throw new Error(
        '[react-native-otel] SDK not initialized. Call otel.init() first.'
      );
    }
    return this.logger_;
  }

  // Flush all buffered spans and metrics without tearing down the SDK.
  // When a NetworkAdapter is configured, flush is a no-op while offline —
  // data stays buffered until connectivity is restored.
  flush(): void {
    if (!this.isOnline_) return;
    this.meter_?.flush();
    const flushExporter = (exp: unknown) => {
      if (exp && typeof exp === 'object' && 'flush' in exp) {
        (exp as { flush(): void }).flush();
      }
    };
    flushExporter(this.exporter_);
    flushExporter(this.logExporter_);
  }

  async shutdown(): Promise<void> {
    // Remove connectivity listener.
    this.networkUnsubscribe_?.();
    this.networkUnsubscribe_ = undefined;

    // Restore the original fetch.
    uninstallFetchInstrumentation();

    // End active screen span
    const current = spanContext.current();
    if (current) {
      current.end();
      spanContext.setCurrent(undefined);
    }

    // Flush buffered metrics
    this.meter_?.flush();

    // Flush + tear down exporter timers (e.g. OtlpHttp*Exporter)
    const destroyExporter = (exp: unknown) => {
      if (exp && typeof exp === 'object' && 'destroy' in exp) {
        (exp as { destroy(): void }).destroy();
      }
    };
    destroyExporter(this.exporter_);
    destroyExporter(this.metricExporter_);
    destroyExporter(this.logExporter_);
  }
}

export const otel = new OtelSDK();
