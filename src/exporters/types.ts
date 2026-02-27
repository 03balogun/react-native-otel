import { Attributes } from '../core/attributes'
import { ReadonlySpan, SpanExporter } from '../core/span'

export type { ReadonlySpan, SpanExporter }

export interface MetricRecord {
  type: 'counter' | 'histogram' | 'gauge'
  name: string
  value: number
  timestampMs: number
  attributes: Attributes
}

export interface LogRecord {
  timestampMs: number
  severity: string
  body: string
  traceId: string | undefined
  spanId: string | undefined
  attributes: Attributes
}

export interface MetricExporter {
  export(metrics: MetricRecord[]): void
}

export interface LogExporter {
  export(logs: LogRecord[]): void
}
