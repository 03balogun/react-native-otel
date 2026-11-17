import { installErrorInstrumentation } from '../instrumentation/errors';
import type { StorageAdapter } from '../instrumentation/errors';
import { Tracer } from '../core/tracer';
import { Span } from '../core/span';
import type { ReadonlySpan } from '../core/span';
import { spanContext } from '../context/span-context';

const CRASH_KEY = '@react-native-otel/pending-crash';

type Handler = (error: Error, isFatal?: boolean) => void;

function makeStorage(): StorageAdapter & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    setSync: (k, v) => {
      data.set(k, v);
    },
    getSync: (k) => data.get(k) ?? null,
    deleteSync: (k) => {
      data.delete(k);
    },
  };
}

function makeTracer() {
  return new Tracer({ getUserAttributes: () => ({}) });
}

const globals = globalThis as Record<string, unknown>;
const setGlobalHandler = (globals.ErrorUtils as { setGlobalHandler: jest.Mock })
  .setGlobalHandler;
const previousRejectionHandler = globals.onunhandledrejection;

/** Installs the instrumentation and returns the global error handler it set. */
function install(storage: StorageAdapter, tracer = makeTracer()): Handler {
  setGlobalHandler.mockClear();
  installErrorInstrumentation({ tracer, storage });
  return setGlobalHandler.mock.calls[0]![0] as Handler;
}

function stored(storage: ReturnType<typeof makeStorage>) {
  return JSON.parse(storage.data.get(CRASH_KEY)!) as Record<string, unknown>;
}

beforeEach(() => {
  spanContext.setCurrent(undefined);
});

afterEach(() => {
  globals.onunhandledrejection = previousRejectionHandler;
});

describe('error instrumentation — pending crash record', () => {
  it('persists the full span shape for a fatal error', () => {
    const storage = makeStorage();
    const handler = install(storage);

    handler(new TypeError('boom'), true);

    const record = stored(storage);
    expect(record).toMatchObject({
      name: 'crash.TypeError',
      kind: 'INTERNAL',
      links: [],
      droppedEventsCount: 0,
      status: 'ERROR',
      statusMessage: 'boom',
    });
    expect(record.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(record.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof record.startTimeMs).toBe('number');
    expect(typeof record.endTimeMs).toBe('number');
  });

  it('omits parentSpanId for a root crash span', () => {
    const storage = makeStorage();
    const handler = install(storage);

    handler(new Error('boom'), true);

    expect(stored(storage)).not.toHaveProperty('parentSpanId');
  });

  it('persists parentSpanId and traceId when a span is active at crash time', () => {
    const storage = makeStorage();
    const tracer = makeTracer();
    const handler = install(storage, tracer);
    const parent = tracer.startSpan('screen.checkout') as Span;
    spanContext.setCurrent(parent);

    handler(new Error('boom'), true);

    const record = stored(storage);
    expect(record.parentSpanId).toBe(parent.spanId);
    expect(record.traceId).toBe(parent.traceId);
  });

  it('does not persist non-fatal errors', () => {
    const storage = makeStorage();
    const handler = install(storage);

    handler(new Error('boom'), false);

    expect(storage.data.has(CRASH_KEY)).toBe(false);
  });

  it('replays the persisted span to the exporter on the next launch and clears it', () => {
    const storage = makeStorage();
    const parent = makeTracer().startSpan('screen.checkout') as Span;
    spanContext.setCurrent(parent);
    install(storage)(new RangeError('boom'), true);
    const record = stored(storage);

    const exported: ReadonlySpan[] = [];
    installErrorInstrumentation({
      tracer: makeTracer(),
      storage,
      exporter: { export: (spans) => exported.push(...spans) },
    });

    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({
      traceId: record.traceId,
      spanId: record.spanId,
      parentSpanId: parent.spanId,
      kind: 'INTERNAL',
      links: [],
      droppedEventsCount: 0,
    });
    expect(storage.data.has(CRASH_KEY)).toBe(false);
  });
});
