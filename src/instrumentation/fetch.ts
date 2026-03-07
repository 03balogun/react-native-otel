import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
} from '@opentelemetry/semantic-conventions';

import { spanContext } from '../context/span-context';
import { generateSpanId } from '../core/ids';
import { Span, NoopSpan } from '../core/span';
import { Tracer } from '../core/tracer';

export interface FetchInstrumentationOptions {
  // URL substrings to skip (e.g. your own OTLP endpoint to avoid recursion).
  ignoreUrls?: string[];
  // Attribute keys to redact from request/response (same dot-notation as Axios).
  // Sections: body.{key}, response.{key}
  // Example: ['body.password', 'response.token']
  sensitiveKeys?: string[];
  // Capture the request body as http.request.body span attribute. Default: false.
  captureRequestBody?: boolean;
  // Capture the response body as http.response.body span attribute. Default: false.
  captureResponseBody?: boolean;
}

// ─── Body capture helpers ─────────────────────────────────────────────────────

function leafKeysForSection(section: string, paths: string[]): Set<string> {
  const prefix = `${section}.`;
  const result = new Set<string>();
  for (const path of paths) {
    if (path.toLowerCase().startsWith(prefix)) {
      result.add(path.slice(prefix.length).toLowerCase());
    }
  }
  return result;
}

function redactObject(
  obj: Record<string, unknown>,
  sensitive: Set<string>
): Record<string, unknown> {
  if (sensitive.size === 0) return obj;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    result[key] = sensitive.has(key.toLowerCase()) ? '[REDACTED]' : obj[key];
  }
  return result;
}

function normalizeBody(data: unknown): Record<string, unknown> | undefined {
  if (data === null || data === undefined) return undefined;
  if (typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  if (typeof data === 'string') {
    try {
      const parsed: unknown = JSON.parse(data);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // not JSON — skip
    }
  }
  return undefined;
}

function toJsonAttr(obj: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(obj);
  } catch {
    return undefined;
  }
}

// Map from internal ID → active span, mirroring the Axios instrumentation pattern.
const activeFetchSpans = new Map<string, Span | NoopSpan>();

let originalFetch: typeof fetch | undefined;
let installed = false;

/**
 * Patches globalThis.fetch to create OTel spans for every HTTP request.
 * Call `uninstallFetchInstrumentation()` to restore the original fetch.
 *
 * Options:
 *   ignoreUrls – URL substrings that should not be instrumented (e.g. your
 *                OTLP endpoint to prevent infinite recursion).
 */
export function createFetchInstrumentation(
  tracer: Tracer,
  options?: FetchInstrumentationOptions
): { uninstall: () => void } {
  if (installed) {
    return { uninstall: () => uninstallFetchInstrumentation() };
  }

  const ignoreUrls = options?.ignoreUrls ?? [];
  const paths = (options?.sensitiveKeys ?? []).map((k) => k.toLowerCase());
  const sensitiveBody = leafKeysForSection('body', paths);
  const sensitiveResponse = leafKeysForSection('response', paths);
  const captureRequestBody = options?.captureRequestBody ?? false;
  const captureResponseBody = options?.captureResponseBody ?? false;

  originalFetch = globalThis.fetch;
  installed = true;

  globalThis.fetch = async function instrumentedFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.toString()
        : (input as Request).url;

    // Skip ignored URLs.
    if (ignoreUrls.some((pattern) => url.includes(pattern))) {
      return originalFetch!(input, init);
    }

    const method = (
      init?.method ??
      (typeof input !== 'string' && !(input instanceof URL)
        ? (input as Request).method
        : 'GET')
    ).toUpperCase();

    // Capture parent context NOW by value — concurrent-safe.
    const currentSpan = spanContext.current();
    const parent =
      currentSpan?.traceId && currentSpan?.spanId
        ? { traceId: currentSpan.traceId, spanId: currentSpan.spanId }
        : null;

    const span = tracer.startSpan(`http.${method} ${url}`, {
      kind: 'CLIENT',
      parent,
      attributes: {
        [ATTR_HTTP_REQUEST_METHOD]: method,
        'http.url': url,
      },
    });

    // Capture request body (string / JSON only — Blob/FormData are skipped).
    if (captureRequestBody && init?.body !== undefined && init.body !== null) {
      const normalized = normalizeBody(init.body);
      if (normalized) {
        const redacted = redactObject(normalized, sensitiveBody);
        const serialized = toJsonAttr(redacted);
        if (serialized) span.setAttribute('http.request.body', serialized);
      }
    }

    // Inject W3C traceparent header for sampled spans.
    let patchedInit = init;
    if (span instanceof Span) {
      const existingHeaders =
        init?.headers instanceof Headers
          ? Object.fromEntries((init.headers as Headers).entries())
          : (init?.headers as Record<string, string> | undefined) ?? {};

      patchedInit = {
        ...init,
        headers: {
          ...existingHeaders,
          traceparent: `00-${span.traceId}-${span.spanId}-01`,
        },
      };
    }

    const otelId = generateSpanId();
    activeFetchSpans.set(otelId, span);

    try {
      const response = await originalFetch!(input, patchedInit);
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);

      // Capture response body — clone so the caller's stream is unaffected.
      if (captureResponseBody) {
        try {
          const text = await response.clone().text();
          const normalized = normalizeBody(text);
          if (normalized) {
            const redacted = redactObject(normalized, sensitiveResponse);
            const serialized = toJsonAttr(redacted);
            if (serialized) span.setAttribute('http.response.body', serialized);
          }
        } catch {
          // ignore body read errors
        }
      }

      if (response.ok) {
        span.setStatus('OK');
      } else {
        span.setStatus('ERROR', `HTTP ${response.status}`);
      }
      span.end();
      activeFetchSpans.delete(otelId);
      return response;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus('ERROR', (err as Error).message);
      span.end();
      activeFetchSpans.delete(otelId);
      throw err;
    }
  };

  return { uninstall: () => uninstallFetchInstrumentation() };
}

export function uninstallFetchInstrumentation(): void {
  if (!installed) return;
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
  installed = false;
  activeFetchSpans.clear();
}
