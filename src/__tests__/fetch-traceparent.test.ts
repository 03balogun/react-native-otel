import {
  createFetchInstrumentation,
  uninstallFetchInstrumentation,
} from '../instrumentation/fetch';
import { Tracer } from '../core/tracer';
import { Span } from '../core/span';
import { spanContext } from '../context/span-context';

function makeTracer(
  sampleRate = 1.0,
  exported: Span[] = []
): { tracer: Tracer; exported: Span[] } {
  const tracer = new Tracer({
    getUserAttributes: () => ({}),
    sampleRate,
    exporter: { export: (spans) => exported.push(...(spans as Span[])) },
  });
  return { tracer, exported };
}

let baseFetch: jest.Mock;
const realFetch = globalThis.fetch;

beforeEach(() => {
  spanContext.setCurrent(undefined);
  baseFetch = jest.fn(async () => ({ ok: true, status: 200 } as Response));
  globalThis.fetch = baseFetch as unknown as typeof fetch;
});

afterEach(() => {
  uninstallFetchInstrumentation();
  globalThis.fetch = realFetch;
});

function sentHeaders(): Record<string, string> {
  const init = baseFetch.mock.calls[0]![1] as RequestInit;
  return init.headers as Record<string, string>;
}

describe('fetch instrumentation — W3C traceparent', () => {
  it('sends a sampled traceparent matching the exported span', async () => {
    const { tracer, exported } = makeTracer(1.0);
    createFetchInstrumentation(tracer);

    await globalThis.fetch('https://api.example.com/a');

    const traceparent = sentHeaders().traceparent!;
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const [, traceId, spanId] = traceparent.split('-');
    expect(exported[0]!.traceId).toBe(traceId);
    expect(exported[0]!.spanId).toBe(spanId);
  });

  it('still sends a valid traceparent with flags 00 when the span is sampled out', async () => {
    const { tracer, exported } = makeTracer(0.0);
    createFetchInstrumentation(tracer);

    await globalThis.fetch('https://api.example.com/a');

    expect(sentHeaders().traceparent).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/
    );
    expect(exported).toHaveLength(0);
  });

  it('reuses the active trace id for a sampled-out request', async () => {
    const { tracer } = makeTracer(0.0);
    createFetchInstrumentation(tracer);
    const traceId = 'a'.repeat(32);
    spanContext.setCurrent({ traceId, spanId: 'b'.repeat(16) } as Span);

    await globalThis.fetch('https://api.example.com/a');

    const [, sentTraceId, sentSpanId, flags] =
      sentHeaders().traceparent!.split('-');
    expect(sentTraceId).toBe(traceId);
    expect(sentSpanId).not.toBe('b'.repeat(16));
    expect(flags).toBe('00');
  });

  it('generates a fresh, non-zero trace id when there is no active span', async () => {
    const { tracer } = makeTracer(0.0);
    createFetchInstrumentation(tracer);

    await globalThis.fetch('https://api.example.com/a');
    await globalThis.fetch('https://api.example.com/b');

    const first = (baseFetch.mock.calls[0]![1] as RequestInit)
      .headers as Record<string, string>;
    const second = (baseFetch.mock.calls[1]![1] as RequestInit)
      .headers as Record<string, string>;
    const idOf = (h: Record<string, string>) => h.traceparent!.split('-')[1];
    expect(idOf(first)).not.toBe('0'.repeat(32));
    expect(idOf(first)).not.toBe(idOf(second));
  });

  it('preserves caller headers', async () => {
    const { tracer } = makeTracer(0.0);
    createFetchInstrumentation(tracer);

    await globalThis.fetch('https://api.example.com/a', {
      headers: { 'x-custom': '1' },
    });

    expect(sentHeaders()['x-custom']).toBe('1');
    expect(sentHeaders().traceparent).toBeDefined();
  });
});
