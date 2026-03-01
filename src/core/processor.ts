import type { ReadonlySpan, SpanExporter } from './span';
import type { Span } from './span';

/**
 * A SpanProcessor intercepts span lifecycle events.
 * Implement this interface to add custom logic (e.g. enrichment, filtering)
 * before spans are exported.
 */
export interface SpanProcessor {
  /** Called synchronously when a span is started. Optional. */
  onStart?(span: Span): void;
  /** Called synchronously when a span ends. Must be non-blocking. */
  onEnd(span: ReadonlySpan): void;
}

/**
 * Wraps a SpanExporter: calls exporter.export() immediately when a span ends.
 * This is the default processor used inside Tracer when no custom processor
 * is provided.
 */
export class SimpleSpanProcessor implements SpanProcessor {
  constructor(private readonly exporter: SpanExporter) {}

  onEnd(span: ReadonlySpan): void {
    this.exporter.export([span]);
  }
}

/** No-op processor — useful as a placeholder or in tests. */
export class NoopSpanProcessor implements SpanProcessor {
  onStart(_span: Span): void {}
  onEnd(_span: ReadonlySpan): void {}
}
