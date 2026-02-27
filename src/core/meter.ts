import type { Attributes } from './attributes';
import type { MetricExporter, MetricRecord } from '../exporters/types';
import { sanitizeAttributes } from './attributes';
import { now } from './clock';

export class Counter {
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
      attributes: attrs ? sanitizeAttributes(attrs) : {},
    });
  }
}

export class Histogram {
  constructor(
    private name: string,
    private pushToBuffer: (record: MetricRecord) => void
  ) {}

  record(value: number, attrs?: Attributes): void {
    this.pushToBuffer({
      type: 'histogram',
      name: this.name,
      value,
      timestampMs: now(),
      attributes: attrs ? sanitizeAttributes(attrs) : {},
    });
  }
}

export class Gauge {
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
      attributes: attrs ? sanitizeAttributes(attrs) : {},
    });
  }
}

export class Meter {
  private buffer: MetricRecord[] = [];
  private exporter: MetricExporter | undefined;

  constructor(exporter?: MetricExporter) {
    this.exporter = exporter;
  }

  createCounter(name: string): Counter {
    return new Counter(name, (r) => this.buffer.push(r));
  }

  createHistogram(name: string): Histogram {
    return new Histogram(name, (r) => this.buffer.push(r));
  }

  createGauge(name: string): Gauge {
    return new Gauge(name, (r) => this.buffer.push(r));
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const toExport = this.buffer.splice(0, this.buffer.length);
    this.exporter?.export(toExport);
  }
}
