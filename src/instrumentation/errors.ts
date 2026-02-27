import {
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_EXCEPTION_TYPE,
} from '@opentelemetry/semantic-conventions';

import { Span } from '../core/span';
import { Tracer } from '../core/tracer';
import type { ReadonlySpan } from '../exporters/types';

const CRASH_KEY = '@react-native-otel/pending-crash';

export interface StorageAdapter {
  setSync(key: string, value: string): void;
  getSync(key: string): string | null;
  deleteSync(key: string): void;
}

type GlobalErrorHandler = (error: Error, isFatal?: boolean) => void;

// Serialized crash span shape for storage
interface CrashSpanRecord {
  traceId: string;
  spanId: string;
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  attributes: Record<string, unknown>;
  events: {
    name: string;
    timestampMs: number;
    attributes: Record<string, unknown>;
  }[];
  status: string;
  statusMessage: string | undefined;
}

export function installErrorInstrumentation(params: {
  tracer: Tracer;
  storage?: StorageAdapter;
  exporter?: { export(spans: ReadonlySpan[]): void };
}): void {
  const { tracer, storage, exporter } = params;

  // Flush any pending crash span from previous session
  if (storage && exporter) {
    const pending = storage.getSync(CRASH_KEY);
    if (pending) {
      try {
        const crashRecord = JSON.parse(pending) as CrashSpanRecord;
        exporter.export([crashRecord as unknown as ReadonlySpan]);
      } catch {
        // Ignore parse errors
      }
      storage.deleteSync(CRASH_KEY);
    }
  }

  // Wrap the global JS error handler
  const originalHandler = (
    ErrorUtils as { getGlobalHandler?(): GlobalErrorHandler }
  ).getGlobalHandler?.();

  ErrorUtils.setGlobalHandler((error: Error, isFatal?: boolean) => {
    const span = tracer.startSpan(`crash.${error.name}`, {
      kind: 'INTERNAL',
      attributes: {
        [ATTR_EXCEPTION_TYPE]: error.name,
        [ATTR_EXCEPTION_MESSAGE]: error.message,
        [ATTR_EXCEPTION_STACKTRACE]: error.stack ?? '',
        'crash.is_fatal': isFatal ?? false, // custom — no OTel equivalent
      },
    });
    span.setStatus('ERROR', error.message);
    span.end();

    // Persist crash span synchronously for next session retrieval
    if (isFatal && storage && span instanceof Span) {
      const record: CrashSpanRecord = {
        traceId: span.traceId,
        spanId: span.spanId,
        name: span.name,
        startTimeMs: span.startTimeMs,
        endTimeMs: span.endTimeMs ?? Date.now(),
        attributes: span.attributes as Record<string, unknown>,
        events: span.events,
        status: span.status,
        statusMessage: span.statusMessage,
      };
      storage.setSync(CRASH_KEY, JSON.stringify(record));
    }

    originalHandler?.(error, isFatal);
  });

  // Wire up unhandled Promise rejection tracking.
  // globalThis.onunhandledrejection is available in Hermes (default RN engine since 0.70).
  // Without this, async errors that are never .catch()-ed are silently swallowed.
  const prevRejectionHandler = (globalThis as Record<string, unknown>)
    .onunhandledrejection as ((event: { reason: unknown }) => void) | undefined;

  (globalThis as Record<string, unknown>).onunhandledrejection = (event: {
    reason: unknown;
  }) => {
    const reason = event.reason;
    const error = reason instanceof Error ? reason : new Error(String(reason));

    const span = tracer.startSpan(`unhandled_rejection.${error.name}`, {
      kind: 'INTERNAL',
      attributes: {
        [ATTR_EXCEPTION_TYPE]: error.name,
        [ATTR_EXCEPTION_MESSAGE]: error.message,
        [ATTR_EXCEPTION_STACKTRACE]: error.stack ?? '',
        'exception.unhandled_rejection': true,
      },
    });
    span.setStatus('ERROR', error.message);
    span.end();

    prevRejectionHandler?.call(globalThis, event);
  };
}
