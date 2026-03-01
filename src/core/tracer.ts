import {
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_EXCEPTION_TYPE,
} from '@opentelemetry/semantic-conventions';

import type { Attributes } from './attributes';
import type {
  SpanContext,
  SpanExporter,
  SpanKind,
  SpanLink,
  SpanProcessor,
} from './span';
import { Span, NoopSpan } from './span';
import type { Sampler } from './sampler';
import { spanContext, spanContextInternal } from '../context/span-context';

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Attributes;
  links?: SpanLink[];
  // Inherit traceId from this parent. Omit to use the current active span.
  // Pass null to force a new root trace.
  parent?: SpanContext | null;
}

export class Tracer {
  private exporter: SpanExporter | undefined;
  private sampleRate: number;
  private sampler: Sampler | undefined;
  private processors: SpanProcessor[];
  private getUserAttributes: () => Attributes;

  constructor(params: {
    exporter?: SpanExporter;
    sampleRate?: number;
    sampler?: Sampler;
    processors?: SpanProcessor[];
    getUserAttributes: () => Attributes;
  }) {
    this.exporter = params.exporter;
    this.sampleRate = params.sampleRate ?? 1.0;
    this.sampler = params.sampler;
    this.processors = params.processors ?? [];
    this.getUserAttributes = params.getUserAttributes;
  }

  // Create a span without making it the active context.
  // Use startActiveSpan() when you want sub-operations to auto-parent.
  startSpan(name: string, options?: SpanOptions): Span | NoopSpan {
    // Resolve parent: explicit > current active span > none (new root trace)
    const parent: SpanContext | undefined =
      options?.parent !== undefined
        ? options.parent ?? undefined
        : spanContext.current() ?? undefined;

    // Sampler takes precedence over legacy sampleRate when provided.
    if (this.sampler) {
      if (!this.sampler.shouldSample(name, parent, options?.attributes)) {
        return new NoopSpan();
      }
    } else if (this.sampleRate < 1.0 && Math.random() > this.sampleRate) {
      return new NoopSpan();
    }

    // Build a composite processor if multiple processors are registered,
    // otherwise use a single processor or fall back to direct exporter.
    const processor: SpanProcessor | undefined =
      this.processors.length > 1
        ? {
            onStart: (s) => {
              for (const p of this.processors) p.onStart?.(s);
            },
            onEnd: (s) => {
              for (const p of this.processors) p.onEnd(s);
            },
          }
        : this.processors[0];

    const userAttrs = this.getUserAttributes();
    return new Span({
      name,
      kind: options?.kind,
      attributes: { ...userAttrs, ...options?.attributes },
      links: options?.links,
      parent,
      exporter: processor ? undefined : this.exporter,
      processor,
    });
  }

  // Create a span, make it the active context for the duration of fn, then
  // automatically end it. Sub-operations started inside fn via startSpan() will
  // automatically parent to this span.
  //
  // For concurrent async work (multiple in-flight awaits), pass parent
  // explicitly to startSpan() instead — the shared context stack is not safe
  // for interleaved async operations.
  startActiveSpan<T>(name: string, fn: (span: Span | NoopSpan) => T): T;
  startActiveSpan<T>(
    name: string,
    options: SpanOptions,
    fn: (span: Span | NoopSpan) => T
  ): T;
  startActiveSpan<T>(
    name: string,
    optionsOrFn: SpanOptions | ((span: Span | NoopSpan) => T),
    fn?: (span: Span | NoopSpan) => T
  ): T {
    const options = typeof optionsOrFn === 'function' ? undefined : optionsOrFn;
    const callback = typeof optionsOrFn === 'function' ? optionsOrFn : fn!;

    const span = this.startSpan(name, options);
    const token = spanContextInternal.push(span);

    const cleanup = (isError: boolean, err?: unknown) => {
      if (isError && err instanceof Error) {
        span.setStatus('ERROR', err.message);
      }
      span.end();
      spanContextInternal.pop(token);
    };

    try {
      const result = callback(span);
      if (result instanceof Promise) {
        // Token-based pop fires after the promise settles, preserving identity
        // even if other startActiveSpan calls interleave on the event loop.
        return result.then(
          (v) => {
            cleanup(false);
            return v;
          },
          (e: unknown) => {
            cleanup(true, e);
            throw e;
          }
        ) as T;
      }
      cleanup(false);
      return result;
    } catch (e) {
      cleanup(true, e);
      throw e;
    }
  }

  // Make an existing span the active context for the duration of fn.
  // Does NOT end the span — the caller owns its lifetime.
  // Safe for synchronous work. For concurrent async work, see startActiveSpan.
  withSpan<T>(span: Span | NoopSpan, fn: (span: Span | NoopSpan) => T): T {
    const token = spanContextInternal.push(span);

    const cleanup = () => spanContextInternal.pop(token);

    try {
      const result = fn(span);
      if (result instanceof Promise) {
        return result.then(
          (v) => {
            cleanup();
            return v;
          },
          (e: unknown) => {
            cleanup();
            throw e;
          }
        ) as T;
      }
      cleanup();
      return result;
    } catch (e) {
      cleanup();
      throw e;
    }
  }

  recordEvent(name: string, attributes?: Attributes): void {
    spanContext.current()?.addEvent(name, attributes);
  }

  recordException(error: Error, attributes?: Attributes): void {
    const span = this.startSpan(`exception.${error.name}`, {
      kind: 'INTERNAL',
      attributes: {
        [ATTR_EXCEPTION_TYPE]: error.name,
        [ATTR_EXCEPTION_MESSAGE]: error.message,
        [ATTR_EXCEPTION_STACKTRACE]: error.stack ?? '',
        ...attributes,
      },
    });
    span.setStatus('ERROR', error.message);
    span.end();
  }
}
