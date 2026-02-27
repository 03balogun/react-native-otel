import type {
  LogExporter,
  LogRecord,
  MetricExporter,
  MetricRecord,
} from './types';
import type { Attributes } from '../core/attributes';
import type { Resource } from '../core/resource';
import type { ReadonlySpan, SpanExporter } from '../core/span';

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
  }

  // Called by OtelSDK.init() after buildResource() — not part of SpanExporter.
  setResource(resource: Readonly<Resource>): void {
    this.resource_ = resource;
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
    this.send(batch);
  }

  // Clear the flush timer and send any remaining buffered spans.
  destroy(): void {
    if (this.timer_ !== undefined) {
      clearInterval(this.timer_);
      this.timer_ = undefined;
    }
    this.flush();
  }

  private send(spans: ReadonlySpan[]): void {
    const resourceAttrs = this.resource_
      ? toOtlpAttributes(this.resource_ as unknown as Record<string, unknown>)
      : [];

    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: resourceAttrs },
          scopeSpans: [
            {
              scope: { name: 'react-native-otel', version: '0.1.0' },
              spans: spans.map((s) => this.toOtlpSpan(s)),
            },
          ],
        },
      ],
    });

    fetch(this.tracesEndpoint, {
      method: 'POST',
      headers: this.headers,
      body,
    }).catch(() => {});
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

// OTLP aggregation temporality: 2 = CUMULATIVE
const AGGREGATION_TEMPORALITY_CUMULATIVE = 2;

export interface OtlpHttpMetricExporterOptions {
  endpoint: string;
  headers?: Record<string, string>;
}

export class OtlpHttpMetricExporter implements MetricExporter {
  private readonly metricsEndpoint: string;
  private readonly headers: Record<string, string>;
  private resource_: Readonly<Resource> | undefined;

  constructor(options: OtlpHttpMetricExporterOptions) {
    this.metricsEndpoint = options.endpoint.replace(/\/$/, '') + '/v1/metrics';
    this.headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };
  }

  setResource(resource: Readonly<Resource>): void {
    this.resource_ = resource;
  }

  export(metrics: MetricRecord[]): void {
    if (metrics.length === 0) return;
    this.send(metrics);
  }

  private send(metrics: MetricRecord[]): void {
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

      // Counters → sum; histograms + gauges → gauge (no bucket data available).
      if (type === 'counter') {
        return {
          name,
          sum: {
            dataPoints: records.map((r) => ({
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

      return {
        name,
        gauge: {
          dataPoints: records.map((r) => ({
            asDouble: r.value,
            timeUnixNano: msToNano(r.timestampMs),
            attributes: toOtlpAttributes(r.attributes),
          })),
        },
      };
    });

    const body = JSON.stringify({
      resourceMetrics: [
        {
          resource: { attributes: resourceAttrs },
          scopeMetrics: [
            {
              scope: { name: 'react-native-otel', version: '0.1.0' },
              metrics: otlpMetrics,
            },
          ],
        },
      ],
    });

    fetch(this.metricsEndpoint, {
      method: 'POST',
      headers: this.headers,
      body,
    }).catch(() => {});
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
  }

  setResource(resource: Readonly<Resource>): void {
    this.resource_ = resource;
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
    this.send(batch);
  }

  destroy(): void {
    if (this.timer_ !== undefined) {
      clearInterval(this.timer_);
      this.timer_ = undefined;
    }
    this.flush();
  }

  private send(logs: LogRecord[]): void {
    const resourceAttrs = this.resource_
      ? toOtlpAttributes(this.resource_ as unknown as Record<string, unknown>)
      : [];

    const body = JSON.stringify({
      resourceLogs: [
        {
          resource: { attributes: resourceAttrs },
          scopeLogs: [
            {
              scope: { name: 'react-native-otel', version: '0.1.0' },
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

    fetch(this.logsEndpoint, {
      method: 'POST',
      headers: this.headers,
      body,
    }).catch(() => {});
  }
}
