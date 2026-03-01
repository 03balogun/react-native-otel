import type { ReadonlySpan, SpanExporter } from '../core/span';
import type {
  LogExporter,
  LogRecord,
  MetricExporter,
  MetricRecord,
} from './types';

/**
 * Fans out span export calls to multiple exporters.
 * All exporters receive the same batch; errors in one do not affect others.
 */
export class MultiSpanExporter implements SpanExporter {
  constructor(private readonly exporters: SpanExporter[]) {}

  export(spans: ReadonlySpan[]): void {
    for (const exp of this.exporters) {
      try {
        exp.export(spans);
      } catch {
        // Isolate failures — one bad exporter must not drop data from others.
      }
    }
  }
}

/**
 * Fans out metric export calls to multiple exporters.
 */
export class MultiMetricExporter implements MetricExporter {
  constructor(private readonly exporters: MetricExporter[]) {}

  export(metrics: MetricRecord[]): void {
    for (const exp of this.exporters) {
      try {
        exp.export(metrics);
      } catch {
        // Isolate failures.
      }
    }
  }
}

/**
 * Fans out log export calls to multiple exporters.
 */
export class MultiLogExporter implements LogExporter {
  constructor(private readonly exporters: LogExporter[]) {}

  export(logs: LogRecord[]): void {
    for (const exp of this.exporters) {
      try {
        exp.export(logs);
      } catch {
        // Isolate failures.
      }
    }
  }
}
