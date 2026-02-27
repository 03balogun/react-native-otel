import type {
  SpanExporter,
  MetricExporter,
  LogExporter,
  ReadonlySpan,
  MetricRecord,
  HistogramRecord,
  LogRecord,
} from './types';

function shouldLog(debug: boolean): boolean {
  return debug || process.env.NODE_ENV === 'development';
}

export class ConsoleSpanExporter implements SpanExporter {
  constructor(private debug = false) {}

  export(spans: ReadonlySpan[]): void {
    if (!shouldLog(this.debug)) return;

    for (const span of spans) {
      const duration =
        span.endTimeMs !== undefined
          ? `${span.endTimeMs - span.startTimeMs}ms`
          : 'ongoing';
      const lines: string[] = [
        `[OTEL SPAN] ${span.name} (traceId=${span.traceId} spanId=${
          span.spanId
        })${span.parentSpanId ? ` parentSpanId=${span.parentSpanId}` : ''}`,
        `  duration: ${duration}  status: ${span.status}${
          span.statusMessage ? ` (${span.statusMessage})` : ''
        }`,
        `  attributes: ${JSON.stringify(span.attributes)}`,
      ];

      if (span.events.length > 0) {
        lines.push('  events:');
        for (const event of span.events) {
          const offset = event.timestampMs - span.startTimeMs;
          const attrsStr =
            Object.keys(event.attributes).length > 0
              ? `  ${JSON.stringify(event.attributes)}`
              : '{}';
          lines.push(`    [+${offset}ms]  ${event.name}  ${attrsStr}`);
        }
      }

      if (span.droppedEventsCount > 0) {
        lines.push(`  dropped_events: ${span.droppedEventsCount}`);
      }

      console.log(lines.join('\n'));
    }
  }
}

export class ConsoleMetricExporter implements MetricExporter {
  constructor(private debug = false) {}

  export(metrics: MetricRecord[]): void {
    if (!shouldLog(this.debug)) return;

    for (const metric of metrics) {
      if (metric.type === 'histogram') {
        const h = metric as HistogramRecord;
        const avg = h.count > 0 ? (h.sum / h.count).toFixed(2) : '0';
        const bucketStr = h.bucketBoundaries
          .map((b, i) => `≤${b}:${h.bucketCounts[i]}`)
          .concat([`+Inf:${h.bucketCounts[h.bucketBoundaries.length]}`])
          .join(' ');
        console.log(
          `[OTEL METRIC] ${h.name} histogram count=${h.count} sum=${h.sum} avg=${avg} [${bucketStr}]`,
          Object.keys(h.attributes).length > 0 ? h.attributes : ''
        );
      } else {
        console.log(
          `[OTEL METRIC] ${metric.name} ${metric.type} value=${metric.value}`,
          Object.keys(metric.attributes).length > 0 ? metric.attributes : ''
        );
      }
    }
  }
}

export class ConsoleLogExporter implements LogExporter {
  constructor(private debug = false) {}

  export(logs: LogRecord[]): void {
    if (!shouldLog(this.debug)) return;

    for (const log of logs) {
      const traceInfo = log.traceId
        ? `{ trace: ${log.traceId}, span: ${log.spanId} }`
        : '';

      console.log(
        `[OTEL LOG] ${log.severity.padEnd(5)}  ${log.body}`,
        traceInfo,
        Object.keys(log.attributes).length > 0 ? log.attributes : ''
      );
    }
  }
}
