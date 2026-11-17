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

function sentInit(call = 0): RequestInit | undefined {
  return baseFetch.mock.calls[call]![1] as RequestInit | undefined;
}

describe('fetch instrumentation — instrumentUrls allow-list', () => {
  it('instruments every request when instrumentUrls is not set', async () => {
    const { exported } = setup();

    await globalThis.fetch('https://third-party.example.org/x');

    expect(exported).toHaveLength(1);
    expect(
      (sentInit()?.headers as Record<string, string>).traceparent
    ).toBeDefined();
  });

  it('instruments a URL that matches an entry', async () => {
    const { exported } = setup({ instrumentUrls: ['api.example.com'] });

    await globalThis.fetch('https://api.example.com/v1/items');

    expect(exported).toHaveLength(1);
    expect(
      (sentInit()?.headers as Record<string, string>).traceparent
    ).toBeDefined();
  });

  it('passes a non-matching URL through untouched: no span, no header', async () => {
    const { exported } = setup({ instrumentUrls: ['api.example.com'] });
    const init = { headers: { 'x-custom': '1' } };

    await globalThis.fetch('https://third-party.example.org/x', init);

    expect(exported).toHaveLength(0);
    expect(baseFetch).toHaveBeenCalledWith(
      'https://third-party.example.org/x',
      init
    );
    expect(sentInit()).toBe(init);
  });

  it('matches any entry of the list', async () => {
    const { exported } = setup({
      instrumentUrls: ['api.example.com', 'auth.example.com'],
    });

    await globalThis.fetch('https://auth.example.com/token');

    expect(exported).toHaveLength(1);
  });

  it('works with URL inputs', async () => {
    const { exported } = setup({ instrumentUrls: ['api.example.com'] });

    await globalThis.fetch(new URL('https://third-party.example.org/x'));
    expect(exported).toHaveLength(0);

    await globalThis.fetch(new URL('https://api.example.com/x'));
    expect(exported).toHaveLength(1);
  });

  it('lets ignoreUrls win over instrumentUrls', async () => {
    const { exported } = setup({
      instrumentUrls: ['api.example.com'],
      ignoreUrls: ['api.example.com/health'],
    });

    await globalThis.fetch('https://api.example.com/health');

    expect(exported).toHaveLength(0);
  });
});
