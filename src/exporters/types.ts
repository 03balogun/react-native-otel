import type { Attributes } from '../core/attributes';
import type { ReadonlySpan, SpanExporter } from '../core/span';

export type { ReadonlySpan, SpanExporter };

interface BaseMetricRecord {
  name: string;
  timestampMs: number;
  attributes: Attributes;
}

export interface CounterRecord extends BaseMetricRecord {
  type: 'counter';
  value: number;
}

export interface GaugeRecord extends BaseMetricRecord {
  type: 'gauge';
  value: number;
}

export interface HistogramRecord extends BaseMetricRecord {
  type: 'histogram';
  // Aggregated data for the flush window
  count: number;
  sum: number;
  // Explicit bucket upper bounds (last bucket is +Inf, implicit)
  bucketBoundaries: number[];
  // Length is bucketBoundaries.length + 1 (last entry = +Inf bucket)
  bucketCounts: number[];
}

export type MetricRecord = CounterRecord | GaugeRecord | HistogramRecord;

export interface LogRecord {
  timestampMs: number;
  severity: string;
  body: string;
  traceId: string | undefined;
  spanId: string | undefined;
  attributes: Attributes;
}

export interface MetricExporter {
  export(metrics: MetricRecord[]): void;
}

export interface LogExporter {
  export(logs: LogRecord[]): void;
}
