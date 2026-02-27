import { Meter } from '../core/meter';
import type {
  MetricRecord,
  HistogramRecord,
  CounterRecord,
} from '../exporters/types';

function makeExporter() {
  const exported: MetricRecord[][] = [];
  return {
    export: (records: MetricRecord[]) => exported.push(records),
    records: exported,
  };
}

describe('Counter', () => {
  it('emits a counter record on add()', () => {
    const exporter = makeExporter();
    const meter = new Meter(exporter);
    const counter = meter.createCounter('requests');
    counter.add(5);
    meter.flush();

    expect(exporter.records).toHaveLength(1);
    const record = exporter.records[0]![0] as CounterRecord;
    expect(record.type).toBe('counter');
    expect(record.name).toBe('requests');
    expect(record.value).toBe(5);
  });

  it('emits one record per add() call', () => {
    const exporter = makeExporter();
    const meter = new Meter(exporter);
    const counter = meter.createCounter('c');
    counter.add(1);
    counter.add(2);
    meter.flush();

    expect(exporter.records[0]).toHaveLength(2);
  });
});

describe('Histogram', () => {
  it('aggregates multiple record() calls into a single HistogramRecord on flush()', () => {
    const exporter = makeExporter();
    const meter = new Meter(exporter);
    const hist = meter.createHistogram('latency');

    hist.record(10);
    hist.record(50);
    hist.record(200);
    meter.flush();

    expect(exporter.records).toHaveLength(1);
    const record = exporter.records[0]![0] as HistogramRecord;
    expect(record.type).toBe('histogram');
    expect(record.count).toBe(3);
    expect(record.sum).toBe(260);
  });

  it('places values into correct buckets', () => {
    const exporter = makeExporter();
    const meter = new Meter(exporter);
    // Use custom tight boundaries to make bucket placement predictable
    const hist = meter.createHistogram('h', { boundaries: [10, 50, 100] });

    hist.record(5); // ≤10
    hist.record(10); // ≤10
    hist.record(30); // ≤50
    hist.record(200); // +Inf
    meter.flush();

    const record = exporter.records[0]![0] as HistogramRecord;
    // Buckets: [≤10, ≤50, ≤100, +Inf]
    expect(record.bucketCounts).toEqual([2, 1, 0, 1]);
    expect(record.bucketBoundaries).toEqual([10, 50, 100]);
  });

  it('tracks separate buckets per unique attribute set', () => {
    const exporter = makeExporter();
    const meter = new Meter(exporter);
    const hist = meter.createHistogram('req', { boundaries: [100] });

    hist.record(50, { endpoint: '/a' });
    hist.record(150, { endpoint: '/b' });
    meter.flush();

    expect(exporter.records[0]).toHaveLength(2);
    const records = exporter.records[0] as HistogramRecord[];
    const recordA = records.find(
      (r) => (r.attributes as Record<string, unknown>).endpoint === '/a'
    )!;
    const recordB = records.find(
      (r) => (r.attributes as Record<string, unknown>).endpoint === '/b'
    )!;
    expect(recordA.count).toBe(1);
    expect(recordB.count).toBe(1);
  });

  it('clears buckets after flush so the next window starts fresh', () => {
    const exporter = makeExporter();
    const meter = new Meter(exporter);
    const hist = meter.createHistogram('h');

    hist.record(10);
    meter.flush();
    hist.record(20);
    meter.flush();

    // Two separate flush windows, each with count=1
    expect(exporter.records).toHaveLength(2);
    expect((exporter.records[0]![0] as HistogramRecord).count).toBe(1);
    expect((exporter.records[1]![0] as HistogramRecord).count).toBe(1);
  });

  it('does not emit a record if no values were recorded before flush()', () => {
    const exporter = makeExporter();
    const meter = new Meter(exporter);
    meter.createHistogram('empty');
    meter.flush();

    expect(exporter.records).toHaveLength(0);
  });

  it('uses custom boundaries when provided', () => {
    const exporter = makeExporter();
    const meter = new Meter(exporter);
    const hist = meter.createHistogram('h', { boundaries: [1, 2, 3] });
    hist.record(0.5);
    meter.flush();

    const record = exporter.records[0]![0] as HistogramRecord;
    expect(record.bucketBoundaries).toEqual([1, 2, 3]);
    expect(record.bucketCounts).toHaveLength(4); // 3 bounds + 1 +Inf
  });
});
