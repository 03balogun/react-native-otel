import {
  createFetchInstrumentation,
  uninstallFetchInstrumentation,
} from '../instrumentation/fetch';
import type { FetchInstrumentationOptions } from '../instrumentation/fetch';
import { Tracer } from '../core/tracer';
import { Span } from '../core/span';
import { spanContext } from '../context/span-context';

function setup(options?: FetchInstrumentationOptions) {
  const exported: Span[] = [];
  const tracer = new Tracer({
    getUserAttributes: () => ({}),
    exporter: { export: (spans) => exported.push(...(spans as Span[])) },
  });
  createFetchInstrumentation(tracer, options);
  return { exported };
}

/** A fetch that never answers, and rejects like a real one when aborted. */
function hangingFetch(): jest.Mock {
  return jest.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const fail = () =>
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        if (init?.signal?.aborted) return fail();
        init?.signal?.addEventListener('abort', fail);
      })
  );
}

let baseFetch: jest.Mock;
const realFetch = globalThis.fetch;

beforeEach(() => {
  spanContext.setCurrent(undefined);
  baseFetch = jest.fn(async () => ({ ok: true, status: 200 } as Response));
  globalThis.fetch = baseFetch as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
  uninstallFetchInstrumentation();
  globalThis.fetch = realFetch;
});

describe('fetch instrumentation — requestTimeoutMs', () => {
  it('does not touch the signal when requestTimeoutMs is not set', async () => {
    setup();

    await globalThis.fetch('https://api.example.com/a');

    expect((baseFetch.mock.calls[0]![1] as RequestInit).signal).toBeUndefined();
  });

  it.each([0, -1, NaN])('ignores requestTimeoutMs = %p', async (value) => {
    setup({ requestTimeoutMs: value });

    await globalThis.fetch('https://api.example.com/a');

    expect((baseFetch.mock.calls[0]![1] as RequestInit).signal).toBeUndefined();
  });

  it('aborts a hung request and still ends and exports its span with an error', async () => {
    baseFetch = hangingFetch();
    globalThis.fetch = baseFetch as unknown as typeof fetch;
    const { exported } = setup({ requestTimeoutMs: 20 });

    await expect(
      globalThis.fetch('https://api.example.com/hang')
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(exported).toHaveLength(1);
    expect(exported[0]!.status).toBe('ERROR');
    expect(exported[0]!.endTimeMs).toBeDefined();
  });

  it('lets a fast response through and clears the timer', async () => {
    jest.useFakeTimers();
    const { exported } = setup({ requestTimeoutMs: 30000 });

    const response = await globalThis.fetch('https://api.example.com/a');

    expect(response.status).toBe(200);
    expect(exported[0]!.status).toBe('OK');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the timer when the request fails', async () => {
    jest.useFakeTimers();
    baseFetch.mockRejectedValueOnce(new Error('network down'));
    setup({ requestTimeoutMs: 30000 });

    await expect(globalThis.fetch('https://api.example.com/a')).rejects.toThrow(
      'network down'
    );

    expect(jest.getTimerCount()).toBe(0);
  });

  it('still honours a caller signal that aborts first', async () => {
    baseFetch = hangingFetch();
    globalThis.fetch = baseFetch as unknown as typeof fetch;
    const { exported } = setup({ requestTimeoutMs: 60000 });
    const controller = new AbortController();

    const pending = globalThis.fetch('https://api.example.com/hang', {
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(exported[0]!.status).toBe('ERROR');
  });

  it('aborts immediately when the caller signal is already aborted', async () => {
    baseFetch = hangingFetch();
    globalThis.fetch = baseFetch as unknown as typeof fetch;
    setup({ requestTimeoutMs: 60000 });
    const controller = new AbortController();
    controller.abort();

    await expect(
      globalThis.fetch('https://api.example.com/hang', {
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps the traceparent header and caller headers', async () => {
    setup({ requestTimeoutMs: 30000 });

    await globalThis.fetch('https://api.example.com/a', {
      headers: { 'x-custom': '1' },
    });

    const headers = (baseFetch.mock.calls[0]![1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers['x-custom']).toBe('1');
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
});
