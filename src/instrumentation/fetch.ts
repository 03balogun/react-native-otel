import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
} from '@opentelemetry/semantic-conventions';

import { spanContext } from '../context/span-context';
import { generateSpanId } from '../core/ids';
import { Span, NoopSpan } from '../core/span';
import { Tracer } from '../core/tracer';

export interface FetchInstrumentationOptions {
  ignoreUrls?: string[];
  // Dot-notation paths to redact. Sections: body.{key}, response.{key}
  sensitiveKeys?: string[];
  captureRequestBody?: boolean;
  captureResponseBody?: boolean;
}

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
      // not JSON
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

const activeFetchSpans = new Map<string, Span | NoopSpan>();

let originalFetch: typeof fetch | undefined;
let installed = false;

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

    if (ignoreUrls.some((pattern) => url.includes(pattern))) {
      return originalFetch!(input, init);
    }

    // When the caller passes a Request object without a separate init, decompose
    // it into (url, effectiveInit) so the traceparent header can be merged safely.
    // Per the Fetch spec, fetch(request, init) causes init to override all request
    // properties — so passing even a partial init drops headers, body, credentials.
    // Binary/multipart bodies are passed through unchanged to avoid data corruption.
    let effectiveInit: RequestInit | undefined = init;
    let passThroughRequest = false;

    if (!init && typeof input !== 'string' && !(input instanceof URL)) {
      const req = input as Request;
      const reqHeaders = Object.fromEntries(req.headers.entries());
      const contentType = (reqHeaders['content-type'] ?? '').toLowerCase();
      const isTextBody =
        contentType === '' ||
        contentType.includes('application/json') ||
        contentType.includes('text/');

      if (isTextBody) {
        let reqBody: string | undefined;
        try {
          const text = await req.clone().text();
          if (text) reqBody = text;
        } catch {
          // body not readable
        }
        effectiveInit = {
          method: req.method,
          headers: reqHeaders,
          body: reqBody,
          signal: req.signal,
          redirect: req.redirect,
          referrer: req.referrer,
          credentials: req.credentials,
          cache: req.cache,
          mode: req.mode,
          integrity: req.integrity,
          keepalive: req.keepalive,
        };
      } else {
        passThroughRequest = true;
      }
    }

    const method = (effectiveInit?.method ?? 'GET').toUpperCase();

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

    if (
      captureRequestBody &&
      effectiveInit?.body !== undefined &&
      effectiveInit.body !== null
    ) {
      const normalized = normalizeBody(effectiveInit.body);
      if (normalized) {
        const redacted = redactObject(normalized, sensitiveBody);
        const serialized = toJsonAttr(redacted);
        if (serialized) span.setAttribute('http.request.body', serialized);
      }
    }

    let patchedInit = effectiveInit;
    if (!passThroughRequest && span instanceof Span) {
      const existingHeaders =
        effectiveInit?.headers instanceof Headers
          ? Object.fromEntries((effectiveInit.headers as Headers).entries())
          : (effectiveInit?.headers as Record<string, string> | undefined) ??
            {};

      patchedInit = {
        ...effectiveInit,
        headers: {
          ...existingHeaders,
          traceparent: `00-${span.traceId}-${span.spanId}-01`,
        },
      };
    }

    const otelId = generateSpanId();
    activeFetchSpans.set(otelId, span);

    try {
      const response = await (passThroughRequest
        ? originalFetch!(input)
        : originalFetch!(url, patchedInit));
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);

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
          // ignore
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
