import type { Attributes } from './attributes';
import type { SpanContext } from './span';

/**
 * A Sampler decides whether a span should be recorded or dropped.
 * Return `true` to record the span, `false` to drop it (NoopSpan is used).
 */
export interface Sampler {
  shouldSample(
    name: string,
    parent?: SpanContext,
    attributes?: Attributes
  ): boolean;
}

/** Records every span (default). */
export class AlwaysOnSampler implements Sampler {
  shouldSample(): boolean {
    return true;
  }
}

/** Drops every span. */
export class AlwaysOffSampler implements Sampler {
  shouldSample(): boolean {
    return false;
  }
}

/**
 * Samples a deterministic fraction of traces based on the trace ID.
 * Uses the first 8 bytes of the traceId to produce a 0–1 value and
 * compares it against the configured ratio, matching the W3C spec intent.
 *
 * When there is no parent (new root trace), a random value is used instead
 * so that the ratio still holds for root spans.
 */
export class TraceIdRatioSampler implements Sampler {
  constructor(private readonly ratio: number) {
    if (ratio < 0 || ratio > 1) {
      throw new RangeError(
        `TraceIdRatioSampler: ratio must be in [0, 1], got ${ratio}`
      );
    }
  }

  shouldSample(_name: string, parent?: SpanContext): boolean {
    if (this.ratio <= 0) return false;
    if (this.ratio >= 1) return true;

    const traceId = parent?.traceId;
    if (traceId && traceId.length >= 16) {
      // Parse the lower 32 bits of the first 8 bytes (hex chars 8–15) as an
      // unsigned integer in [0, 2^32) and normalize to [0, 1).
      // parseInt with radix 16 always returns a non-negative number for 8 hex
      // digits, so no bitwise operation is needed.
      const lo = parseInt(traceId.slice(8, 16), 16); // [0, 0xFFFFFFFF]
      const normalized = lo / 0x100000000; // [0, 1)
      return normalized < this.ratio;
    }

    // No parent trace ID — fall back to random.
    return Math.random() < this.ratio;
  }
}
