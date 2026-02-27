import { spanContext } from './context/span-context';
import { Attributes, setMaxStringLength } from './core/attributes';
import { OtelLogger } from './core/log-record';
import { Meter } from './core/meter';
import { buildResource, Resource } from './core/resource';
import { Tracer } from './core/tracer';
import { SpanExporter, MetricExporter, LogExporter } from './exporters/types';
import {
  StorageAdapter,
  installErrorInstrumentation,
} from './instrumentation/errors';
import { installLifecycleInstrumentation } from './instrumentation/lifecycle';

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
  debug?: boolean;
  storage?: StorageAdapter;
  // Truncate string attribute values longer than this. Default: 1024.
  maxAttributeStringLength?: number;
  // Dot-notation paths to redact from network captures.
  // Sections: header, body, param, response
  // Examples: ['header.authorization', 'body.password', 'response.token']
  sensitiveKeys?: string[];
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

    this.resource_ = buildResource({
      serviceName: config.serviceName,
      serviceVersion: config.serviceVersion ?? '0.0.0',
      osName: config.osName ?? '',
      osVersion: config.osVersion ?? '',
      deviceBrand: config.deviceBrand ?? '',
      deviceModel: config.deviceModel ?? '',
      deviceType: config.deviceType ?? '',
      appBuild: config.appBuild ?? '',
      environment: config.environment ?? 'production',
    });

    // If any exporter supports resource injection (e.g. OtlpHttp*Exporter),
    // hand it the resource so it can include it in OTLP payloads.
    const injectResource = (exp: unknown) => {
      if (exp && typeof exp === 'object' && 'setResource' in exp) {
        (exp as { setResource(r: Readonly<Resource>): void }).setResource(
          this.resource_ as Readonly<Resource>
        );
      }
    };
    injectResource(config.exporter);
    injectResource(config.metricExporter);
    injectResource(config.logExporter);

    this.tracer_ = new Tracer({
      exporter: config.exporter,
      sampleRate: config.sampleRate,
      getUserAttributes: () => ({ ...this.userAttributes_ }),
    });

    this.meter_ = new Meter(config.metricExporter);
    this.logger_ = new OtelLogger(config.logExporter);

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

  async shutdown(): Promise<void> {
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
