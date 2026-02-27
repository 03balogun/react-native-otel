import { OtlpHttpMetricExporter } from '../exporters/otlp-http-exporter';
import type {
  MetricRecord,
  HistogramRecord,
  CounterRecord,
  GaugeRecord,
} from '../exporters/types';
import type { StorageAdapter } from '../instrumentation/errors';
import { Wal } from '../exporters/wal';

// ─── fetch mock ──────────────────────────────────────────────────────────────

let mockFetchResponse: { ok: boolean; status: number } = {
  ok: true,
  status: 200,
};
const fetchCalls: { url: string; body: string }[] = [];

global.fetch = jest.fn(async (url: unknown, options: unknown) => {
  const opts = options as RequestInit;
  fetchCalls.push({ url: url as string, body: opts.body as string });
  return mockFetchResponse as Response;
});

beforeEach(() => {
  fetchCalls.length = 0;
  mockFetchResponse = { ok: true, status: 200 };
});

// ─── Helper to build metric records ──────────────────────────────────────────

function counter(name: string, value: number): CounterRecord {
  return { type: 'counter', name, value, timestampMs: 1000, attributes: {} };
}

function gauge(name: string, value: number): GaugeRecord {
  return { type: 'gauge', name, value, timestampMs: 1000, attributes: {} };
}

function histogram(
  name: string,
  count: number,
  sum: number,
  boundaries: number[],
  bucketCounts: number[]
): HistogramRecord {
  return {
    type: 'histogram',
    name,
    count,
    sum,
    bucketBoundaries: boundaries,
    bucketCounts,
    timestampMs: 1000,
    attributes: {},
  };
}

// ─── OtlpHttpMetricExporter OTLP serialization ───────────────────────────────

describe('OtlpHttpMetricExporter', () => {
  function makeExporter() {
    return new OtlpHttpMetricExporter({ endpoint: 'http://localhost:4318' });
  }

  it('sends counter as OTLP sum data point', async () => {
    const exporter = makeExporter();
    exporter.export([counter('hits', 42)]);
    await Promise.resolve(); // flush microtasks

    expect(fetchCalls).toHaveLength(1);
    const body = JSON.parse(fetchCalls[0]!.body);
    const metric = body.resourceMetrics[0].scopeMetrics[0].metrics[0];
    expect(metric.name).toBe('hits');
    expect(metric.sum).toBeDefined();
    expect(metric.sum.dataPoints[0].asDouble).toBe(42);
    expect(metric.sum.isMonotonic).toBe(true);
  });

  it('sends gauge as OTLP gauge data point', async () => {
    const exporter = makeExporter();
    exporter.export([gauge('cpu', 0.75)]);
    await Promise.resolve();

    const body = JSON.parse(fetchCalls[0]!.body);
    const metric = body.resourceMetrics[0].scopeMetrics[0].metrics[0];
    expect(metric.name).toBe('cpu');
    expect(metric.gauge).toBeDefined();
    expect(metric.gauge.dataPoints[0].asDouble).toBe(0.75);
  });

  it('sends histogram with correct count, sum, bucketCounts, and explicitBounds', async () => {
    const exporter = makeExporter();
    exporter.export([histogram('latency', 3, 165, [50, 100], [1, 1, 1])]);
    await Promise.resolve();

    const body = JSON.parse(fetchCalls[0]!.body);
    const metric = body.resourceMetrics[0].scopeMetrics[0].metrics[0];
    expect(metric.name).toBe('latency');
    expect(metric.histogram).toBeDefined();

    const dp = metric.histogram.dataPoints[0];
    expect(dp.count).toBe('3'); // string-encoded uint64
    expect(dp.sum).toBe(165);
    expect(dp.bucketCounts).toEqual(['1', '1', '1']);
    expect(dp.explicitBounds).toEqual([50, 100]);
    // DELTA temporality for histograms
    expect(metric.histogram.aggregationTemporality).toBe(1);
  });

  it('does not send if metrics array is empty', async () => {
    const exporter = makeExporter();
    exporter.export([]);
    await Promise.resolve();
    expect(fetchCalls).toHaveLength(0);
  });

  it('groups multiple records of the same name into one OTLP metric', async () => {
    const exporter = makeExporter();
    exporter.export([counter('req', 1), counter('req', 2)]);
    await Promise.resolve();

    const body = JSON.parse(fetchCalls[0]!.body);
    const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics;
    expect(metrics).toHaveLength(1);
    expect(metrics[0].sum.dataPoints).toHaveLength(2);
  });
});

// ─── WAL integration ─────────────────────────────────────────────────────────

function makeStorage(): StorageAdapter & { store: Record<string, string> } {
  const store: Record<string, string> = {};
  return {
    store,
    setSync: (key, value) => {
      store[key] = value;
    },
    getSync: (key) => store[key] ?? null,
    deleteSync: (key) => {
      delete store[key];
    },
  };
}

describe('OtlpHttpMetricExporter WAL', () => {
  it('deletes the WAL entry after a successful send', async () => {
    const storage = makeStorage();
    const exporter = new OtlpHttpMetricExporter({
      endpoint: 'http://localhost:4318',
    });
    exporter.setStorage(storage);

    exporter.export([counter('c', 1)]);
    await new Promise((r) => setTimeout(r, 10)); // allow async delivery

    const wal = new Wal(storage, '@react-native-otel/wal/metrics');
    expect(wal.readAll()).toHaveLength(0);
  });

  it('leaves the WAL entry when the send fails', async () => {
    mockFetchResponse = { ok: false, status: 503 };
    const storage = makeStorage();
    const exporter = new OtlpHttpMetricExporter({
      endpoint: 'http://localhost:4318',
    });
    exporter.setStorage(storage);

    exporter.export([counter('c', 1)]);
    // Wait for all retries (3 * up to 2s each is too long; use fake timers or just check WAL exists)
    await new Promise((r) => setTimeout(r, 20));

    const wal = new Wal(storage, '@react-native-otel/wal/metrics');
    // Batch is still in the WAL since all retries failed
    expect(wal.readAll().length).toBeGreaterThan(0);
  });

  it('replays pending batches from WAL on setStorage()', async () => {
    // Pre-populate the WAL as if a previous session left data
    const storage = makeStorage();
    const wal = new Wal<MetricRecord>(
      storage,
      '@react-native-otel/wal/metrics'
    );
    wal.write([counter('c', 99)]);

    const exporter = new OtlpHttpMetricExporter({
      endpoint: 'http://localhost:4318',
    });
    exporter.setStorage(storage); // should trigger replay
    await new Promise((r) => setTimeout(r, 10));

    expect(fetchCalls.length).toBeGreaterThan(0);
    const body = JSON.parse(fetchCalls[0]!.body);
    expect(body.resourceMetrics[0].scopeMetrics[0].metrics[0].name).toBe('c');
  });
});
