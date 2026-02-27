import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
} from '@opentelemetry/semantic-conventions';

import { spanContext } from '../context/span-context';
import { generateSpanId } from '../core/ids';
import { Span, NoopSpan } from '../core/span';
import { Tracer } from '../core/tracer';

// Concurrent-safe: parent context is captured by value at request start
const activeNetworkSpans = new Map<string, Span | NoopSpan>();

// ─── Axios shape (subset we care about) ─────────────────────────────────────

export interface AxiosRequestConfig {
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  params?: Record<string, unknown>;
  data?: unknown;
  __otelId?: string;
  [key: string]: unknown;
}

export interface AxiosResponse {
  status: number;
  headers?: Record<string, unknown>;
  data?: unknown;
  config: AxiosRequestConfig;
  [key: string]: unknown;
}

export interface AxiosError {
  message: string;
  response?: AxiosResponse;
  config?: AxiosRequestConfig;
  [key: string]: unknown;
}

// ─── Redaction helpers ───────────────────────────────────────────────────────

// Builds the set of leaf keys to redact for a given section prefix.
// e.g. section='header', paths=['header.authorization','body.password']
//   → Set { 'authorization' }
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

// Shallow-redacts an object, replacing blacklisted keys with '[REDACTED]'.
// Case-insensitive on keys. Returns the original object reference when
// there are no sensitive keys to save an allocation.
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

// Tries to produce a plain object from a request/response body.
// Handles object and JSON-string forms; skips Blobs, FormData, etc.
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

// Serializes an object to a JSON string for use as a span attribute.
// Returns undefined when serialization fails (circular refs, etc.).
function toJsonAttr(obj: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(obj);
  } catch {
    return undefined;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export interface AxiosInstrumentationOptions {
  // Dot-notation paths to redact. Section prefixes:
  //   header.{key}   — request and response headers
  //   body.{key}     — request body
  //   param.{key}    — URL query params
  //   response.{key} — response body
  sensitiveKeys?: string[];
}

export function createAxiosInstrumentation(
  tracer: Tracer,
  options?: AxiosInstrumentationOptions
) {
  const paths = (options?.sensitiveKeys ?? []).map((k) => k.toLowerCase());

  // Pre-compute sensitive leaf-key sets once at setup time, not per-request.
  const sensitiveHeaders = leafKeysForSection('header', paths);
  const sensitiveBody = leafKeysForSection('body', paths);
  const sensitiveParams = leafKeysForSection('param', paths);
  const sensitiveResponse = leafKeysForSection('response', paths);

  return {
    onRequest(config: AxiosRequestConfig): AxiosRequestConfig {
      const otelId = generateSpanId();
      const method = (config.method ?? 'GET').toUpperCase();
      const url = config.url ?? '';

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
          [ATTR_HTTP_REQUEST_METHOD]: method, // 'http.request.method'
          'http.url': url, // stable experimental, no change
        },
      });

      // Request headers
      if (config.headers) {
        const redacted = redactObject(
          config.headers as Record<string, unknown>,
          sensitiveHeaders
        );
        const serialized = toJsonAttr(redacted);
        if (serialized) span.setAttribute('http.request.headers', serialized);
      }

      // Query params
      if (config.params) {
        const redacted = redactObject(config.params, sensitiveParams);
        const serialized = toJsonAttr(redacted);
        if (serialized) span.setAttribute('http.request.params', serialized);
      }

      // Request body
      const reqBody = normalizeBody(config.data);
      if (reqBody) {
        const redacted = redactObject(reqBody, sensitiveBody);
        const serialized = toJsonAttr(redacted);
        if (serialized) span.setAttribute('http.request.body', serialized);
      }

      // W3C Trace Context: inject traceparent header so the backend can continue
      // the trace. Only injected for sampled (real) spans — NoopSpan has empty IDs.
      if (span instanceof Span) {
        // flags: 01 = sampled
        config.headers = {
          ...(config.headers ?? {}),
          traceparent: `00-${span.traceId}-${span.spanId}-01`,
        };
      }

      activeNetworkSpans.set(otelId, span);
      config.__otelId = otelId;
      return config;
    },

    onResponse(response: AxiosResponse): AxiosResponse {
      const otelId = response.config.__otelId;
      if (otelId) {
        const span = activeNetworkSpans.get(otelId);
        if (span) {
          span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);

          // Response headers
          if (response.headers) {
            const redacted = redactObject(response.headers, sensitiveHeaders);
            const serialized = toJsonAttr(redacted);
            if (serialized)
              span.setAttribute('http.response.headers', serialized);
          }

          // Response body
          const resBody = normalizeBody(response.data);
          if (resBody) {
            const redacted = redactObject(resBody, sensitiveResponse);
            const serialized = toJsonAttr(redacted);
            if (serialized) span.setAttribute('http.response.body', serialized);
          }

          span.setStatus('OK');
          span.end();
          activeNetworkSpans.delete(otelId);
        }
      }
      return response;
    },

    onError(error: AxiosError): Promise<never> {
      const otelId = error.config?.__otelId;
      if (otelId) {
        const span = activeNetworkSpans.get(otelId);
        if (span) {
          span.setAttribute(
            ATTR_HTTP_RESPONSE_STATUS_CODE,
            error.response?.status ?? 0
          );

          // Error response headers + body when available
          if (error.response?.headers) {
            const redacted = redactObject(
              error.response.headers,
              sensitiveHeaders
            );
            const serialized = toJsonAttr(redacted);
            if (serialized)
              span.setAttribute('http.response.headers', serialized);
          }

          const errBody = normalizeBody(error.response?.data);
          if (errBody) {
            const redacted = redactObject(errBody, sensitiveResponse);
            const serialized = toJsonAttr(redacted);
            if (serialized) span.setAttribute('http.response.body', serialized);
          }

          span.recordException(error as unknown as Error);
          span.setStatus('ERROR', error.message);
          span.end();
          activeNetworkSpans.delete(otelId);
        }
      }
      return Promise.reject(error);
    },
  };
}

export type AxiosInstrumentation = ReturnType<
  typeof createAxiosInstrumentation
>;
