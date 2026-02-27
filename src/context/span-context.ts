import type { Span, NoopSpan } from '../core/span';

// Public interface — what external consumers see when they import spanContext.
// Hides push/pop to prevent misuse; use tracer.startActiveSpan() or
// tracer.withSpan() for safe nested context management.
export interface SpanContextManagerPublic {
  setCurrent(span: Span | NoopSpan | undefined): void;
  current(): Span | NoopSpan | undefined;
}

// Each manual push is tracked by a unique token so that pop() can find the
// exact entry to remove regardless of concurrent async interleaving.
interface StackEntry {
  span: Span | NoopSpan;
  token: symbol;
}

class SpanContextManager implements SpanContextManagerPublic {
  // Screen-level span set by navigation instrumentation.
  private screenSpan_: Span | NoopSpan | undefined;
  // Manual spans pushed by startActiveSpan / withSpan.
  // Separate from screenSpan_ because they have different lifecycles.
  private manualStack_: StackEntry[] = [];

  // ─── Public API (backward-compatible) ──────────────────────────────────────

  // Set the screen-level span. Called by navigation on route change.
  // Clears the manual stack so stale sub-operation context from the previous
  // screen does not leak into the new one.
  setCurrent(span: Span | NoopSpan | undefined): void {
    this.screenSpan_ = span;
    this.manualStack_ = [];
  }

  // Return the most specific active span. Manual stack takes precedence.
  current(): Span | NoopSpan | undefined {
    const top = this.manualStack_[this.manualStack_.length - 1];
    return top?.span ?? this.screenSpan_;
  }

  // ─── Internal API (used by Tracer only, not re-exported from index.ts) ─────

  // Push span as the active context. Returns a token required by pop().
  /** @internal */
  push(span: Span | NoopSpan): symbol {
    const token = Symbol();
    this.manualStack_.push({ span, token });
    return token;
  }

  // Remove the entry matching token, regardless of position in the stack.
  // Identity-based (not positional) so concurrent async operations cannot
  // accidentally pop each other's entries.
  /** @internal */
  pop(token: symbol): void {
    const idx = this.manualStack_.findIndex((e) => e.token === token);
    if (idx !== -1) {
      this.manualStack_.splice(idx, 1);
    }
  }
}

const manager = new SpanContextManager();

// External consumers get the narrowed type — push/pop are hidden.
export const spanContext: SpanContextManagerPublic = manager;

// Internal alias with the concrete type so tracer.ts can call push/pop.
// Not re-exported from index.ts.
export const spanContextInternal: SpanContextManager = manager;
