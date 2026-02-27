import {
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_EXCEPTION_TYPE,
} from '@opentelemetry/semantic-conventions';

import type { Attributes } from './attributes';
import type { SpanContext, SpanExporter, SpanKind } from './span';
import { Span, NoopSpan } from './span';
import { spanContext } from '../context/span-context';

export class Tracer {
  private exporter: SpanExporter | undefined;
  private sampleRate: number;
  private getUserAttributes: () => Attributes;

  constructor(params: {
    exporter?: SpanExporter;
    sampleRate?: number;
    getUserAttributes: () => Attributes;
  }) {
    this.exporter = params.exporter;
    this.sampleRate = params.sampleRate ?? 1.0;
    this.getUserAttributes = params.getUserAttributes;
  }

  startSpan(
    name: string,
    options?: {
      kind?: SpanKind;
      attributes?: Attributes;
      // Pass the full parent context to inherit traceId.
      // If omitted, the current screen span is used automatically.
      // Pass null explicitly to force a new root trace.
      parent?: SpanContext | null;
    }
  ): Span | NoopSpan {
    if (this.sampleRate < 1.0 && Math.random() > this.sampleRate) {
      return new NoopSpan();
    }

    // Resolve parent: explicit > current screen span > none (new trace)
    const parent: SpanContext | undefined =
      options?.parent !== undefined
        ? options.parent ?? undefined
        : spanContext.current() ?? undefined;

    const userAttrs = this.getUserAttributes();
    return new Span({
      name,
      kind: options?.kind,
      attributes: { ...userAttrs, ...options?.attributes },
      parent,
      exporter: this.exporter,
    });
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
