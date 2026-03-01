import type { Attributes } from './attributes';
import type {
  MetricExporter,
  MetricRecord,
  HistogramRecord,
} from '../exporters/types';
import { sanitizeAttributes } from './attributes';
import { now } from './clock';

// Default bucket boundaries in milliseconds — covers typical mobile latencies.
const DEFAULT_HISTOGRAM_BOUNDARIES = [
  0, 5, 10, 25, 50, 75, 100, 250, 500, 1000,
];

// Cap for the sanitized-attributes memoization cache to prevent memory leaks
// when attributes have high cardinality.
const ATTR_CACHE_MAX = 100;

/**
 * Memoized attribute sanitization: avoids calling sanitizeAttributes() on
 * every Counter.add() / Gauge.set() call for the same attribute set.
 */
function cachedSanitize(
  cache: Map<string, Attributes>,
  attrs: Attributes | undefined
): Attributes {
  if (!attrs) return {};
  const key = JSON.stringify(attrs);
  let sanitized = cache.get(key);
  if (sanitized === undefined) {
    sanitized = sanitizeAttributes(attrs);
    if (cache.size >= ATTR_CACHE_MAX) {
      // Evict the oldest entry to cap memory usage.
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(key, sanitized);
  }
  return sanitized;
}

export class Counter {
  private attrCache = new Map<string, Attributes>();

  constructor(
    private name: string,
    private pushToBuffer: (record: MetricRecord) => void
  ) {}

  add(value: number, attrs?: Attributes): void {
    this.pushToBuffer({
      type: 'counter',
      name: this.name,
      value,
      timestampMs: now(),
      attributes: cachedSanitize(this.attrCache, attrs),
    });
  }
}

interface HistogramBucket {
  count: number;
  sum: number;
  bucketCounts: number[];
  startTimeMs: number;
  lastTimeMs: number;
  attributes: Attributes;
}

export interface HistogramOptions {
  // Explicit upper bounds for buckets, in ascending order. A +Inf bucket is
  // always appended implicitly. Defaults to DEFAULT_HISTOGRAM_BOUNDARIES.
  boundaries?: number[];
}

export class Histogram {
  private readonly boundaries: number[];
  // Keyed by serialized attributes so concurrent recordings with different
  // attribute sets are tracked independently.
  private buckets = new Map<string, HistogramBucket>();

  constructor(
    private name: string,
    private pushToBuffer: (record: MetricRecord) => void,
    options?: HistogramOptions
  ) {
    this.boundaries = options?.boundaries ?? DEFAULT_HISTOGRAM_BOUNDARIES;
  }

  record(value: number, attrs?: Attributes): void {
    const sanitized = attrs ? sanitizeAttributes(attrs) : {};
    const key = JSON.stringify(sanitized);

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        count: 0,
        sum: 0,
        bucketCounts: new Array<number>(this.boundaries.length + 1).fill(0),
        startTimeMs: now(),
        lastTimeMs: now(),
        attributes: sanitized,
      };
      this.buckets.set(key, bucket);
    }

    bucket.count += 1;
    bucket.sum += value;
    bucket.lastTimeMs = now();

    // Place value into its bucket (first boundary that the value is <= to).
    let placed = false;
    for (let i = 0; i < this.boundaries.length; i++) {
      if (value <= this.boundaries[i]!) {
        bucket.bucketCounts[i]! += 1;
        placed = true;
        break;
      }
    }
    // +Inf bucket
    if (!placed) {
      bucket.bucketCounts[this.boundaries.length]! += 1;
    }
  }

  // Called by Meter.flush() — drains accumulated buckets into the export buffer.
  flush(): void {
    for (const bucket of this.buckets.values()) {
      const record: HistogramRecord = {
        type: 'histogram',
        name: this.name,
        count: bucket.count,
        sum: bucket.sum,
        bucketBoundaries: this.boundaries,
        bucketCounts: bucket.bucketCounts,
        timestampMs: bucket.lastTimeMs,
        attributes: bucket.attributes,
      };
      this.pushToBuffer(record);
    }
    this.buckets.clear();
  }

  // Returns whether there is any accumulated data.
  hasData(): boolean {
    return this.buckets.size > 0;
  }
}

export class Gauge {
  private attrCache = new Map<string, Attributes>();

  constructor(
    private name: string,
    private pushToBuffer: (record: MetricRecord) => void
  ) {}

  set(value: number, attrs?: Attributes): void {
    this.pushToBuffer({
      type: 'gauge',
      name: this.name,
      value,
      timestampMs: now(),
      attributes: cachedSanitize(this.attrCache, attrs),
    });
  }
}

export class Meter {
  private buffer: MetricRecord[] = [];
  private exporter: MetricExporter | undefined;
  private histograms: Histogram[] = [];

  constructor(exporter?: MetricExporter) {
    this.exporter = exporter;
  }

  createCounter(name: string): Counter {
    return new Counter(name, (r) => this.buffer.push(r));
  }

  createHistogram(name: string, options?: HistogramOptions): Histogram {
    const histogram = new Histogram(name, (r) => this.buffer.push(r), options);
    this.histograms.push(histogram);
    return histogram;
  }

  createGauge(name: string): Gauge {
    return new Gauge(name, (r) => this.buffer.push(r));
  }

  flush(): void {
    // Drain all histogram buckets into the buffer first.
    for (const histogram of this.histograms) {
      if (histogram.hasData()) {
        histogram.flush();
      }
    }

    if (this.buffer.length === 0) return;
    const toExport = this.buffer.splice(0, this.buffer.length);
    this.exporter?.export(toExport);
  }
}
