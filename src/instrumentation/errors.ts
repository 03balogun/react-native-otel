import {
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_EXCEPTION_TYPE,
} from '@opentelemetry/semantic-conventions';

import { Span } from '../core/span';
import { Tracer } from '../core/tracer';
import type { ReadonlySpan } from '../exporters/types';

const CRASH_KEY = '@react-native-otel/pending-crash';

// Parsed stack frame shape from React Native's internal Devtools
interface StackFrame {
  file: string | null;
  methodName: string;
  lineNumber: number | null;
  column: number | null;
}

interface SymbolicatedResult {
  stack: string;
  codeFrame?: string;
}

// Attempt to symbolicate a raw Hermes/V8 stack trace via Metro's /symbolicate endpoint.
// Only active in __DEV__; falls back to the raw stack on any failure or in production.
async function trySymbolicate(rawStack: string): Promise<SymbolicatedResult> {
  if (!__DEV__) return { stack: rawStack };
  try {
    // Dynamic requires keep these dev-only modules out of production bundles.

    const parseErrorStack = (
      require('react-native/Libraries/Core/Devtools/parseErrorStack') as {
        default: (s: string) => StackFrame[];
      }
    ).default;

    const symbolicateStackTrace = (
      require('react-native/Libraries/Core/Devtools/symbolicateStackTrace') as {
        default: (frames: StackFrame[]) => Promise<{
          stack: StackFrame[];
          codeFrame?: {
            content: string;
            location?: { row: number; column: number };
            fileName: string;
          };
        }>;
      }
    ).default;

    const frames = parseErrorStack(rawStack);
    if (frames.length === 0) return { stack: rawStack };

    const result = await symbolicateStackTrace(frames);
    const stack = result.stack
      .map(
        (f) =>
          `  at ${f.methodName ?? '<anonymous>'} (${f.file ?? 'unknown'}:${
            f.lineNumber ?? 0
          }:${f.column ?? 0})`
      )
      .join('\n');

    let codeFrame: string | undefined;
    if (result.codeFrame) {
      const { content, location, fileName } = result.codeFrame;
      const loc = location ? `:${location.row}:${location.column}` : '';
      codeFrame = `${fileName}${loc}\n${content}`;
    }

    return { stack, codeFrame };
  } catch {
    return { stack: rawStack };
  }
}

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
    const rawStack = error.stack ?? '';

    const recordCrashSpan = (stack: string, codeFrame?: string) => {
      const span = tracer.startSpan(`crash.${error.name}`, {
        kind: 'INTERNAL',
        attributes: {
          [ATTR_EXCEPTION_TYPE]: error.name,
          [ATTR_EXCEPTION_MESSAGE]: error.message,
          [ATTR_EXCEPTION_STACKTRACE]: stack,
          'crash.is_fatal': isFatal ?? false,
          ...(codeFrame ? { 'exception.code_frame': codeFrame } : {}),
        },
      });
      span.setStatus('ERROR', error.message);
      span.end();

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
    };

    if (isFatal) {
      // Fatal: record immediately with raw stack — originalHandler must run ASAP.
      // In dev, also try to update the stored crash record with the symbolicated stack.
      recordCrashSpan(rawStack);
      if (__DEV__ && storage) {
        trySymbolicate(rawStack)
          .then(({ stack, codeFrame }) => {
            if (stack === rawStack) return;
            const pending = storage.getSync(CRASH_KEY);
            if (!pending) return;
            try {
              const rec = JSON.parse(pending) as CrashSpanRecord;
              rec.attributes[ATTR_EXCEPTION_STACKTRACE] = stack;
              if (codeFrame) rec.attributes['exception.code_frame'] = codeFrame;
              storage.setSync(CRASH_KEY, JSON.stringify(rec));
            } catch {
              // ignore
            }
          })
          .catch(() => {
            // ignore
          });
      }
    } else if (__DEV__) {
      // Non-fatal in dev: symbolicate first for exact source locations, then record.
      trySymbolicate(rawStack)
        .then(({ stack, codeFrame }) => recordCrashSpan(stack, codeFrame))
        .catch(() => recordCrashSpan(rawStack));
    } else {
      recordCrashSpan(rawStack);
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
    const rawStack = error.stack ?? '';

    const recordRejectionSpan = (stack: string, codeFrame?: string) => {
      const span = tracer.startSpan(`unhandled_rejection.${error.name}`, {
        kind: 'INTERNAL',
        attributes: {
          [ATTR_EXCEPTION_TYPE]: error.name,
          [ATTR_EXCEPTION_MESSAGE]: error.message,
          [ATTR_EXCEPTION_STACKTRACE]: stack,
          'exception.unhandled_rejection': true,
          ...(codeFrame ? { 'exception.code_frame': codeFrame } : {}),
        },
      });
      span.setStatus('ERROR', error.message);
      span.end();
    };

    if (__DEV__) {
      trySymbolicate(rawStack)
        .then(({ stack, codeFrame }) => recordRejectionSpan(stack, codeFrame))
        .catch(() => recordRejectionSpan(rawStack));
    } else {
      recordRejectionSpan(rawStack);
    }

    prevRejectionHandler?.call(globalThis, event);
  };
}
