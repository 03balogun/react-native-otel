import {
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_EXCEPTION_TYPE
} from '@opentelemetry/semantic-conventions'

import { Attributes, sanitizeAttributes, sanitizeValue } from './attributes'
import { now } from './clock'
import { generateSpanId, generateTraceId } from './ids'

// Defined here to avoid circular dep with exporters/types.ts
export interface SpanExporter {
  export(spans: ReadonlySpan[]): void
}

export type SpanKind =
  | 'INTERNAL'
  | 'CLIENT'
  | 'SERVER'
  | 'PRODUCER'
  | 'CONSUMER'
export type SpanStatus = 'UNSET' | 'OK' | 'ERROR'

export interface SpanEvent {
  name: string
  timestampMs: number
  attributes: Attributes
}

export interface ReadonlySpan {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | undefined
  readonly name: string
  readonly kind: SpanKind
  readonly startTimeMs: number
  readonly endTimeMs: number | undefined
  readonly attributes: Readonly<Attributes>
  readonly events: readonly SpanEvent[]
  readonly droppedEventsCount: number
  readonly status: SpanStatus
  readonly statusMessage: string | undefined
}

// Carries both IDs needed to link a child span into an existing trace.
export interface SpanContext {
  traceId: string
  spanId: string
}

export class Span implements ReadonlySpan {
  private static readonly MAX_EVENTS = 128

  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | undefined
  readonly name: string
  readonly kind: SpanKind
  readonly startTimeMs: number

  endTimeMs: number | undefined = undefined
  // Mutable plain object — setAttribute writes directly, no full clone.
  attributes: Attributes
  events: SpanEvent[] = []
  droppedEventsCount = 0
  status: SpanStatus = 'UNSET'
  statusMessage: string | undefined = undefined

  private exporter: SpanExporter | undefined

  constructor(params: {
    name: string
    kind?: SpanKind
    attributes?: Attributes
    // Pass the full parent context so the child inherits the same traceId.
    parent?: SpanContext
    exporter?: SpanExporter
  }) {
    this.traceId = params.parent?.traceId ?? generateTraceId()
    this.spanId = generateSpanId()
    this.parentSpanId = params.parent?.spanId
    this.name = params.name
    this.kind = params.kind ?? 'INTERNAL'
    this.startTimeMs = now()
    this.attributes = params.attributes
      ? sanitizeAttributes(params.attributes)
      : {}
    this.exporter = params.exporter
  }

  setAttribute(key: string, value: Attributes[string]): void {
    if (this.endTimeMs !== undefined) return
    // sanitizeValue handles one value — no object clone needed.
    const sanitized = sanitizeValue(value)
    if (sanitized !== undefined) {
      this.attributes[key] = sanitized
    }
  }

  addEvent(name: string, attrs?: Attributes): void {
    if (this.endTimeMs !== undefined) return
    if (this.events.length >= Span.MAX_EVENTS) {
      this.droppedEventsCount++
      return
    }
    this.events.push({
      name,
      timestampMs: now(),
      attributes: attrs ? sanitizeAttributes(attrs) : {}
    })
  }

  setStatus(status: SpanStatus, message?: string): void {
    if (this.endTimeMs !== undefined) return
    this.status = status
    this.statusMessage = message
  }

  recordException(error: Error, attrs?: Attributes): void {
    this.addEvent('exception', {
      [ATTR_EXCEPTION_TYPE]: error.name,
      [ATTR_EXCEPTION_MESSAGE]: error.message,
      [ATTR_EXCEPTION_STACKTRACE]: error.stack ?? '',
      ...attrs
    })
    this.setStatus('ERROR', error.message)
  }

  end(): void {
    if (this.endTimeMs !== undefined) return
    this.endTimeMs = now()
    if (this.status === 'UNSET') {
      this.status = 'OK'
    }
    this.exporter?.export([this])
  }
}

// No-op span used when sampling drops a span.
// Implements the same interface so callers never null-check.
export class NoopSpan implements ReadonlySpan {
  readonly traceId = ''
  readonly spanId = ''
  readonly parentSpanId = undefined
  readonly name = ''
  readonly kind: SpanKind = 'INTERNAL'
  readonly startTimeMs = 0
  readonly endTimeMs = undefined
  readonly attributes = {}
  readonly events: SpanEvent[] = []
  readonly droppedEventsCount = 0
  readonly status: SpanStatus = 'UNSET'
  readonly statusMessage = undefined

  setAttribute(_key: string, _value: Attributes[string]): void {}
  addEvent(_name: string, _attrs?: Attributes): void {}
  setStatus(_status: SpanStatus, _message?: string): void {}
  recordException(_error: Error, _attrs?: Attributes): void {}
  end(): void {}
}
