import { Span, NoopSpan } from '../core/span';

// Module-level singleton. Tracks only the current active screen span.
// Network spans do NOT touch this context (handled via activeNetworkSpans map).
class SpanContextManager {
  private current_: Span | NoopSpan | undefined;

  setCurrent(span: Span | NoopSpan | undefined): void {
    this.current_ = span;
  }

  current(): Span | NoopSpan | undefined {
    return this.current_;
  }
}

export const spanContext = new SpanContextManager();
