import { createAxiosInstrumentation } from '../instrumentation/network';
import { Tracer } from '../core/tracer';
import { Span } from '../core/span';
import { spanContext } from '../context/span-context';
import type {
  AxiosRequestConfig,
  AxiosResponse,
} from '../instrumentation/network';

function makeTracer(sampleRate = 1.0): Tracer {
  return new Tracer({ getUserAttributes: () => ({}), sampleRate });
}

beforeEach(() => {
  spanContext.setCurrent(undefined);
});

// ─── traceparent injection ────────────────────────────────────────────────────

describe('Axios instrumentation — W3C traceparent', () => {
  it('injects a traceparent header into the request config', () => {
    const tracer = makeTracer();
    const { onRequest } = createAxiosInstrumentation(tracer);
    const config: AxiosRequestConfig = {
      method: 'GET',
      url: '/api/data',
      headers: {},
    };

    const result = onRequest(config);

    expect(result.headers?.traceparent).toBeDefined();
    expect(typeof result.headers?.traceparent).toBe('string');
  });

  it('traceparent matches the W3C format: 00-{32hex}-{16hex}-01', () => {
    const tracer = makeTracer();
    const { onRequest } = createAxiosInstrumentation(tracer);
    const result = onRequest({ method: 'GET', url: '/api', headers: {} });

    const traceparent = result.headers?.traceparent as string;
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('traceparent traceId matches the span traceId', () => {
    const exported: Span[] = [];
    const tracerWithExport = new Tracer({
      getUserAttributes: () => ({}),
      exporter: { export: (spans) => exported.push(...(spans as Span[])) },
    });
    const { onRequest, onResponse } =
      createAxiosInstrumentation(tracerWithExport);

    const config = onRequest({ method: 'GET', url: '/x', headers: {} });
    const traceparent = config.headers?.traceparent as string;
    const [, traceId, spanId] = traceparent.split('-');

    // End the span to get it exported
    const mockResponse: AxiosResponse = {
      status: 200,
      config,
      data: undefined,
    };
    onResponse(mockResponse);

    const span = exported[0]!;
    expect(span.traceId).toBe(traceId);
    expect(span.spanId).toBe(spanId);
  });

  it('does NOT inject traceparent when the span is sampled out (NoopSpan)', () => {
    const tracer = makeTracer(0.0); // sampleRate=0 always returns NoopSpan
    const { onRequest } = createAxiosInstrumentation(tracer);
    const result = onRequest({ method: 'GET', url: '/api', headers: {} });

    expect(result.headers?.traceparent).toBeUndefined();
  });

  it('injects traceparent even when request had no headers object', () => {
    const tracer = makeTracer();
    const { onRequest } = createAxiosInstrumentation(tracer);
    // No headers field at all
    const result = onRequest({ method: 'GET', url: '/api' });

    expect(result.headers?.traceparent).toBeDefined();
  });

  it('preserves existing headers alongside traceparent', () => {
    const tracer = makeTracer();
    const { onRequest } = createAxiosInstrumentation(tracer);
    const result = onRequest({
      method: 'GET',
      url: '/api',
      headers: { authorization: 'Bearer token' },
    });

    expect(result.headers?.authorization).toBe('Bearer token');
    expect(result.headers?.traceparent).toBeDefined();
  });
});

// ─── Parent context propagation ───────────────────────────────────────────────

describe('Axios instrumentation — parent context', () => {
  it('network span parents to the current active screen span', () => {
    const exported: Span[] = [];
    const tracer = new Tracer({
      getUserAttributes: () => ({}),
      exporter: { export: (spans) => exported.push(...(spans as Span[])) },
    });
    const { onRequest, onResponse } = createAxiosInstrumentation(tracer);

    const screenSpan = tracer.startSpan('screen') as Span;
    spanContext.setCurrent(screenSpan);

    const config = onRequest({ method: 'GET', url: '/api', headers: {} });
    onResponse({ status: 200, config, data: undefined });

    const networkSpan = exported[0]!;
    expect(networkSpan.parentSpanId).toBe(screenSpan.spanId);
    expect(networkSpan.traceId).toBe(screenSpan.traceId);
  });

  it('concurrent requests each capture their own parent snapshot', () => {
    const exported: Span[] = [];
    const tracer = new Tracer({
      getUserAttributes: () => ({}),
      exporter: { export: (spans) => exported.push(...(spans as Span[])) },
    });
    const { onRequest, onResponse } = createAxiosInstrumentation(tracer);

    const screenSpan = tracer.startSpan('screen') as Span;
    spanContext.setCurrent(screenSpan);

    // Both requests start while screen span is active
    const config1 = onRequest({ method: 'GET', url: '/a', headers: {} });
    const config2 = onRequest({ method: 'GET', url: '/b', headers: {} });

    // Clear the active span (simulates navigation between the two requests)
    spanContext.setCurrent(undefined);

    // Responses arrive after clear — each span should still have the original parent
    onResponse({ status: 200, config: config1, data: undefined });
    onResponse({ status: 200, config: config2, data: undefined });

    expect(exported).toHaveLength(2);
    for (const span of exported) {
      expect(span.parentSpanId).toBe(screenSpan.spanId);
      expect(span.traceId).toBe(screenSpan.traceId);
    }
  });
});
