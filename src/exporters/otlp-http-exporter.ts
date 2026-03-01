import type {
  LogExporter,
  LogRecord,
  MetricExporter,
  MetricRecord,
  CounterRecord,
  HistogramRecord,
  GaugeRecord,
} from './types';
import type { Attributes } from '../core/attributes';
import type { Resource } from '../core/resource';
import type { ReadonlySpan, SpanExporter } from '../core/span';
import type { StorageAdapter } from '../instrumentation/errors';
import { Wal, fetchWithRetry } from './wal';
import { SDK_VERSION } from '../version';

// ─── OTLP attribute value serialization ──────────────────────────────────────

type OtlpAnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: OtlpAnyValue[] } };

function toOtlpValue(value: unknown): OtlpAnyValue {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toOtlpValue) } };
  }
  return { stringValue: String(value) };
}

function toOtlpAttributes(attrs: Attributes | Record<string, unknown>) {
  return Object.entries(attrs).map(([key, value]) => ({
    key,
    value: toOtlpValue(value),
  }));
}

// Milliseconds → nanoseconds as string (exceeds JS safe integer range).
function msToNano(ms: number): string {
  return String(ms * 1_000_000);
}

// ─── SpanKind + SpanStatus mappings ──────────────────────────────────────────

const SPAN_KIND: Record<string, number> = {
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
};

const SPAN_STATUS_CODE: Record<string, number> = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
};

// ─── Exporter ─────────────────────────────────────────────────────────────────

export interface OtlpHttpExporterOptions {
  // Full OTLP traces endpoint, e.g. 'https://in-otel.hyperdx.io/v1/traces'
  endpoint: string;
  // Additional headers, e.g. { authorization: '<api-key>' }
  headers?: Record<string, string>;
  // Max spans to buffer before flushing immediately. Default: 50.
  batchSize?: number;
  // How often to auto-flush buffered spans in ms. Default: 30_000.
  flushIntervalMs?: number;
}

export class OtlpHttpExporter implements SpanExporter {
  private readonly tracesEndpoint: string;
  private readonly headers: Record<string, string>;
  private readonly batchSize: number;
  private buffer: ReadonlySpan[] = [];
  private resource_: Readonly<Resource> | undefined;
  private timer_: ReturnType<typeof setInterval> | undefined;
  private wal_: Wal<ReadonlySpan> | undefined;

  constructor(options: OtlpHttpExporterOptions) {
    this.tracesEndpoint = options.endpoint.replace(/\/$/, '') + '/v1/traces';
    this.headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };
    this.batchSize = options.batchSize ?? 50;

    const interval = options.flushIntervalMs ?? 30_000;
    this.timer_ = setInterval(() => {
      this.flush();
    }, interval);
    // Allow Node.js to exit cleanly in test environments without calling destroy().
    if (typeof this.timer_.unref === 'function') this.timer_.unref();
  }

  // Called by OtelSDK.init() after buildResource() — not part of SpanExporter.
  setResource(resource: Readonly<Resource>): void {
    this.resource_ = resource;
  }

  // Called by OtelSDK.init() when a StorageAdapter is configured.
  // Initialises the WAL and replays any undelivered batches from the previous session.
  setStorage(storage: StorageAdapter): void {
    this.wal_ = new Wal<ReadonlySpan>(storage, '@react-native-otel/wal/spans');
    this.replayWal();
  }

  private replayWal(): void {
    if (!this.wal_) return;
    for (const batch of this.wal_.readAll()) {
      this.deliverBatch(batch.data as ReadonlySpan[], batch.id);
    }
  }

  export(spans: ReadonlySpan[]): void {
    this.buffer.push(...spans);
    if (this.buffer.length >= this.batchSize) {
      this.flush();
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    if (this.wal_) {
      const id = this.wal_.write(batch);
      this.deliverBatch(batch, id);
    } else {
      this.deliverBatch(batch, undefined);
    }
  }

  // Clear the flush timer and send any remaining buffered spans.
  destroy(): void {
    if (this.timer_ !== undefined) {
      clearInterval(this.timer_);
      this.timer_ = undefined;
    }
    this.flush();
  }

  private deliverBatch(spans: ReadonlySpan[], walId: string | undefined): void {
    const body = this.buildBody(spans);
    fetchWithRetry(this.tracesEndpoint, {
      method: 'POST',
      headers: this.headers,
      body,
    })
      .then((success) => {
        if (success && walId !== undefined) {
          this.wal_?.delete(walId);
        }
      })
      .catch(() => {
        // Leave in WAL for next session
      });
  }

  private buildBody(spans: ReadonlySpan[]): string {
    const resourceAttrs = this.resource_
      ? toOtlpAttributes(this.resource_ as unknown as Record<string, unknown>)
      : [];

    return JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: resourceAttrs },
          scopeSpans: [
            {
              scope: { name: 'react-native-otel', version: SDK_VERSION },
              spans: spans.map((s) => this.toOtlpSpan(s)),
            },
          ],
        },
      ],
    });
  }

  private toOtlpSpan(span: ReadonlySpan) {
    return {
      traceId: span.traceId,
      spanId: span.spanId,
      // Root spans must omit parentSpanId — empty string breaks trace tree assembly.
      ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
      name: span.name,
      kind: SPAN_KIND[span.kind] ?? 1,
      startTimeUnixNano: msToNano(span.startTimeMs),
      endTimeUnixNano: msToNano(span.endTimeMs ?? span.startTimeMs),
      attributes: toOtlpAttributes(span.attributes as Attributes),
      events: span.events.map((event) => ({
        name: event.name,
        timeUnixNano: msToNano(event.timestampMs),
        attributes: toOtlpAttributes(event.attributes),
      })),
      links: span.links.map((link) => ({
        traceId: link.traceId,
        spanId: link.spanId,
        attributes: link.attributes ? toOtlpAttributes(link.attributes) : [],
      })),
      droppedEventsCount: span.droppedEventsCount,
      status: {
        code: SPAN_STATUS_CODE[span.status] ?? 0,
        // Omit message when empty — some parsers reject the empty string.
        ...(span.statusMessage ? { message: span.statusMessage } : {}),
      },
    };
  }
}

// ─── Metric exporter ──────────────────────────────────────────────────────────

// OTLP aggregation temporality constants
const AGGREGATION_TEMPORALITY_DELTA = 1;
const AGGREGATION_TEMPORALITY_CUMULATIVE = 2;

export interface OtlpHttpMetricExporterOptions {
  endpoint: string;
  headers?: Record<string, string>;
  // How often to auto-flush buffered metrics in ms. Default: 30_000.
  flushIntervalMs?: number;
}

export class OtlpHttpMetricExporter implements MetricExporter {
  private readonly metricsEndpoint: string;
  private readonly headers: Record<string, string>;
  private resource_: Readonly<Resource> | undefined;
  private wal_: Wal<MetricRecord> | undefined;
  private timer_: ReturnType<typeof setInterval> | undefined;
  private buffer_: MetricRecord[] = [];

  constructor(options: OtlpHttpMetricExporterOptions) {
    this.metricsEndpoint = options.endpoint.replace(/\/$/, '') + '/v1/metrics';
    this.headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const interval = options.flushIntervalMs ?? 30_000;
    this.timer_ = setInterval(() => {
      this.flush();
    }, interval);
    // Allow Node.js to exit cleanly in test environments without calling destroy().
    if (typeof this.timer_.unref === 'function') this.timer_.unref();
  }

  setResource(resource: Readonly<Resource>): void {
    this.resource_ = resource;
  }

  setStorage(storage: StorageAdapter): void {
    this.wal_ = new Wal<MetricRecord>(
      storage,
      '@react-native-otel/wal/metrics'
    );
    this.replayWal();
  }

  private replayWal(): void {
    if (!this.wal_) return;
    for (const batch of this.wal_.readAll()) {
      this.deliverBatch(batch.data as MetricRecord[], batch.id);
    }
  }

  export(metrics: MetricRecord[]): void {
    if (metrics.length === 0) return;
    this.buffer_.push(...metrics);
  }

  // Drain buffered metrics and deliver them immediately.
  // Called by the internal timer and also useful for testing / explicit flush.
  flush(): void {
    if (this.buffer_.length === 0) return;
    const batch = this.buffer_.splice(0);
    if (this.wal_) {
      const id = this.wal_.write(batch);
      this.deliverBatch(batch, id);
    } else {
      this.deliverBatch(batch, undefined);
    }
  }

  // Clear the flush timer and send any remaining buffered metrics.
  destroy(): void {
    if (this.timer_ !== undefined) {
      clearInterval(this.timer_);
      this.timer_ = undefined;
    }
    this.flush();
  }

  private deliverBatch(
    metrics: MetricRecord[],
    walId: string | undefined
  ): void {
    const body = this.buildBody(metrics);
    fetchWithRetry(this.metricsEndpoint, {
      method: 'POST',
      headers: this.headers,
      body,
    })
      .then((success) => {
        if (success && walId !== undefined) {
          this.wal_?.delete(walId);
        }
      })
      .catch(() => {
        // Leave in WAL for next session
      });
  }

  private buildBody(metrics: MetricRecord[]): string {
    const resourceAttrs = this.resource_
      ? toOtlpAttributes(this.resource_ as unknown as Record<string, unknown>)
      : [];

    // Group records by name so each unique metric name becomes one OTLP metric.
    const byName = new Map<string, MetricRecord[]>();
    for (const record of metrics) {
      const group = byName.get(record.name);
      if (group) {
        group.push(record);
      } else {
        byName.set(record.name, [record]);
      }
    }

    const otlpMetrics = Array.from(byName.entries()).map(([name, records]) => {
      const type = records[0]?.type;

      if (type === 'counter') {
        return {
          name,
          sum: {
            dataPoints: (records as CounterRecord[]).map((r) => ({
              asDouble: r.value,
              startTimeUnixNano: msToNano(r.timestampMs),
              timeUnixNano: msToNano(r.timestampMs),
              attributes: toOtlpAttributes(r.attributes),
            })),
            aggregationTemporality: AGGREGATION_TEMPORALITY_CUMULATIVE,
            isMonotonic: true,
          },
        };
      }

      if (type === 'histogram') {
        return {
          name,
          histogram: {
            dataPoints: (records as HistogramRecord[]).map((r) => ({
              count: String(r.count),
              sum: r.sum,
              // bucketCounts in OTLP are string-encoded uint64
              bucketCounts: r.bucketCounts.map(String),
              // explicitBounds does not include the implicit +Inf upper bound
              explicitBounds: r.bucketBoundaries,
              startTimeUnixNano: msToNano(r.timestampMs),
              timeUnixNano: msToNano(r.timestampMs),
              attributes: toOtlpAttributes(r.attributes),
            })),
            // Each flush window is independent — use DELTA semantics.
            aggregationTemporality: AGGREGATION_TEMPORALITY_DELTA,
          },
        };
      }

      // gauge
      return {
        name,
        gauge: {
          dataPoints: (records as GaugeRecord[]).map((r) => ({
            asDouble: r.value,
            timeUnixNano: msToNano(r.timestampMs),
            attributes: toOtlpAttributes(r.attributes),
          })),
        },
      };
    });

    return JSON.stringify({
      resourceMetrics: [
        {
          resource: { attributes: resourceAttrs },
          scopeMetrics: [
            {
              scope: { name: 'react-native-otel', version: SDK_VERSION },
              metrics: otlpMetrics,
            },
          ],
        },
      ],
    });
  }
}

// ─── Log exporter ─────────────────────────────────────────────────────────────

// OTLP severity number mapping (spec: https://opentelemetry.io/docs/specs/otel/logs/data-model/)
const LOG_SEVERITY_NUMBER: Record<string, number> = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

export interface OtlpHttpLogExporterOptions {
  endpoint: string;
  headers?: Record<string, string>;
  batchSize?: number;
  flushIntervalMs?: number;
}

export class OtlpHttpLogExporter implements LogExporter {
  private readonly logsEndpoint: string;
  private readonly headers: Record<string, string>;
  private readonly batchSize: number;
  private buffer: LogRecord[] = [];
  private resource_: Readonly<Resource> | undefined;
  private timer_: ReturnType<typeof setInterval> | undefined;
  private wal_: Wal<LogRecord> | undefined;

  constructor(options: OtlpHttpLogExporterOptions) {
    this.logsEndpoint = options.endpoint.replace(/\/$/, '') + '/v1/logs';
    this.headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };
    this.batchSize = options.batchSize ?? 50;

    const interval = options.flushIntervalMs ?? 30_000;
    this.timer_ = setInterval(() => {
      this.flush();
    }, interval);
    // Allow Node.js to exit cleanly in test environments without calling destroy().
    if (typeof this.timer_.unref === 'function') this.timer_.unref();
  }

  setResource(resource: Readonly<Resource>): void {
    this.resource_ = resource;
  }

  // Called by OtelSDK.init() when a StorageAdapter is configured.
  setStorage(storage: StorageAdapter): void {
    this.wal_ = new Wal<LogRecord>(storage, '@react-native-otel/wal/logs');
    this.replayWal();
  }

  private replayWal(): void {
    if (!this.wal_) return;
    for (const batch of this.wal_.readAll()) {
      this.deliverBatch(batch.data as LogRecord[], batch.id);
    }
  }

  export(logs: LogRecord[]): void {
    this.buffer.push(...logs);
    if (this.buffer.length >= this.batchSize) {
      this.flush();
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    if (this.wal_) {
      const id = this.wal_.write(batch);
      this.deliverBatch(batch, id);
    } else {
      this.deliverBatch(batch, undefined);
    }
  }

  destroy(): void {
    if (this.timer_ !== undefined) {
      clearInterval(this.timer_);
      this.timer_ = undefined;
    }
    this.flush();
  }

  private deliverBatch(logs: LogRecord[], walId: string | undefined): void {
    this.send(logs)
      .then((success) => {
        if (success && walId !== undefined) {
          this.wal_?.delete(walId);
        }
      })
      .catch(() => {
        // Leave in WAL for next session
      });
  }

  private send(logs: LogRecord[]): Promise<boolean> {
    const resourceAttrs = this.resource_
      ? toOtlpAttributes(this.resource_ as unknown as Record<string, unknown>)
      : [];

    const body = JSON.stringify({
      resourceLogs: [
        {
          resource: { attributes: resourceAttrs },
          scopeLogs: [
            {
              scope: { name: 'react-native-otel', version: SDK_VERSION },
              logRecords: logs.map((log) => ({
                timeUnixNano: msToNano(log.timestampMs),
                severityNumber: LOG_SEVERITY_NUMBER[log.severity] ?? 9,
                severityText: log.severity,
                body: { stringValue: log.body },
                ...(log.traceId ? { traceId: log.traceId } : {}),
                ...(log.spanId ? { spanId: log.spanId } : {}),
                attributes: toOtlpAttributes(log.attributes),
              })),
            },
          ],
        },
      ],
    });

    return fetchWithRetry(this.logsEndpoint, {
      method: 'POST',
      headers: this.headers,
      body,
    });
  }
}
