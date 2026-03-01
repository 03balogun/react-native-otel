/**
 * Integration test: sets up a real Node.js HTTP server that acts as a mock
 * OTLP receiver, then sends spans/metrics/logs through the exporters and
 * verifies the payloads are correctly structured.
 *
 * This test runs in Node (Jest default) so `http` is available.
 */

import * as http from 'http';
import {
  OtlpHttpExporter,
  OtlpHttpMetricExporter,
  OtlpHttpLogExporter,
} from '../exporters/otlp-http-exporter';

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface ReceivedRequest {
  path: string;
  body: unknown;
}

function startMockServer(): Promise<{
  server: http.Server;
  port: number;
  requests: ReceivedRequest[];
}> {
  return new Promise((resolve) => {
    const requests: ReceivedRequest[] = [];

    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        try {
          requests.push({ path: req.url ?? '', body: JSON.parse(raw) });
        } catch {
          requests.push({ path: req.url ?? '', body: raw });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port, requests });
    });
  });
}

function waitForRequests(
  requests: ReceivedRequest[],
  count: number,
  timeoutMs = 2000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (requests.length >= count) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(
          new Error(
            `Timed out waiting for ${count} requests; got ${requests.length}`
          )
        );
      }
    }, 10);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OTLP HTTP integration tests', () => {
  let server: http.Server;
  let port: number;
  let requests: ReceivedRequest[];

  beforeEach(async () => {
    ({ server, port, requests } = await startMockServer());
  });

  afterEach((done) => {
    server.close(done);
  });

  it('OtlpHttpExporter sends a span batch to /v1/traces', async () => {
    const exporter = new OtlpHttpExporter({
      endpoint: `http://127.0.0.1:${port}`,
      flushIntervalMs: 60_000, // disable auto-flush
    });

    exporter.export([
      {
        traceId: 'aaaabbbbccccddddaaaabbbbccccdddd',
        spanId: '1111222233334444',
        parentSpanId: undefined,
        name: 'screen.Home',
        kind: 'INTERNAL',
        startTimeMs: 1000,
        endTimeMs: 2000,
        attributes: { 'screen.name': 'Home' },
        events: [],
        links: [],
        droppedEventsCount: 0,
        status: 'OK',
        statusMessage: undefined,
      },
    ]);
    exporter.flush();

    await waitForRequests(requests, 1);

    expect(requests[0]!.path).toBe('/v1/traces');

    const body = requests[0]!.body as { resourceSpans: unknown[] };
    expect(body.resourceSpans).toHaveLength(1);

    const rs = body.resourceSpans[0] as {
      scopeSpans: { spans: { name: string }[] }[];
    };
    const span = rs.scopeSpans[0]!.spans[0]!;
    expect(span.name).toBe('screen.Home');

    exporter.destroy();
  });

  it('OtlpHttpMetricExporter sends a counter batch to /v1/metrics', async () => {
    const exporter = new OtlpHttpMetricExporter({
      endpoint: `http://127.0.0.1:${port}`,
      flushIntervalMs: 60_000,
    });

    exporter.export([
      {
        type: 'counter',
        name: 'api.requests',
        value: 7,
        timestampMs: 1000,
        attributes: { method: 'GET' },
      },
    ]);
    exporter.flush();

    await waitForRequests(requests, 1);

    expect(requests[0]!.path).toBe('/v1/metrics');

    const body = requests[0]!.body as { resourceMetrics: unknown[] };
    expect(body.resourceMetrics).toHaveLength(1);

    const rm = body.resourceMetrics[0] as {
      scopeMetrics: {
        metrics: {
          name: string;
          sum: { dataPoints: { asDouble: number }[] };
        }[];
      }[];
    };
    const metric = rm.scopeMetrics[0]!.metrics[0]!;
    expect(metric.name).toBe('api.requests');
    expect(metric.sum.dataPoints[0]!.asDouble).toBe(7);

    exporter.destroy();
  });

  it('OtlpHttpLogExporter sends a log batch to /v1/logs', async () => {
    const exporter = new OtlpHttpLogExporter({
      endpoint: `http://127.0.0.1:${port}`,
      flushIntervalMs: 60_000,
    });

    exporter.export([
      {
        timestampMs: 1000,
        severity: 'WARN',
        body: 'Something might be wrong',
        traceId: 'aaaabbbbccccddddaaaabbbbccccdddd',
        spanId: '1111222233334444',
        attributes: { component: 'auth' },
      },
    ]);
    exporter.flush();

    await waitForRequests(requests, 1);

    expect(requests[0]!.path).toBe('/v1/logs');

    const body = requests[0]!.body as { resourceLogs: unknown[] };
    expect(body.resourceLogs).toHaveLength(1);

    const rl = body.resourceLogs[0] as {
      scopeLogs: {
        logRecords: { body: { stringValue: string }; severityText: string }[];
      }[];
    };
    const log = rl.scopeLogs[0]!.logRecords[0]!;
    expect(log.body.stringValue).toBe('Something might be wrong');
    expect(log.severityText).toBe('WARN');

    exporter.destroy();
  });

  it('payload structure: resourceSpans contains resource attributes', async () => {
    const exporter = new OtlpHttpExporter({
      endpoint: `http://127.0.0.1:${port}`,
      flushIntervalMs: 60_000,
    });
    exporter.setResource({
      'service.name': 'my-app',
      'service.version': '1.2.3',
      'os.name': 'ios',
      'os.version': '17.0',
      'device.manufacturer': 'Apple',
      'device.model.name': 'iPhone 15',
      'device.type': 'phone',
      'app.build_id': '42',
      'deployment.environment.name': 'production',
    });

    exporter.export([
      {
        traceId: 'aaaabbbbccccddddaaaabbbbccccdddd',
        spanId: '1111222233334444',
        parentSpanId: undefined,
        name: 'test.span',
        kind: 'INTERNAL',
        startTimeMs: 1000,
        endTimeMs: 2000,
        attributes: {},
        events: [],
        links: [],
        droppedEventsCount: 0,
        status: 'OK',
        statusMessage: undefined,
      },
    ]);
    exporter.flush();

    await waitForRequests(requests, 1);

    const body = requests[0]!.body as {
      resourceSpans: {
        resource: { attributes: { key: string; value: unknown }[] };
      }[];
    };
    const resourceAttrs = body.resourceSpans[0]!.resource.attributes;
    const serviceNameAttr = resourceAttrs.find((a) => a.key === 'service.name');
    expect(serviceNameAttr).toBeDefined();
    expect(
      (serviceNameAttr!.value as { stringValue: string }).stringValue
    ).toBe('my-app');

    exporter.destroy();
  });
});
