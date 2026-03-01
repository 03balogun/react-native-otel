# react-native-otel

Lightweight [OpenTelemetry](https://opentelemetry.io/) SDK for React Native. Zero native dependencies — works in Expo managed workflow, bare React Native, and any Hermes-powered app.

[![npm version](https://img.shields.io/npm/v/react-native-otel)](https://www.npmjs.com/package/react-native-otel)
[![license](https://img.shields.io/npm/l/react-native-otel)](LICENSE)

---

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [SDK Configuration](#sdk-configuration)
- [Instrumentation](#instrumentation)
  - [Navigation (React Navigation)](#navigation-react-navigation)
  - [Network (Axios)](#network-axios)
  - [Network (fetch)](#network-fetch)
  - [App Startup](#app-startup)
  - [Deep Links & Push Notifications](#deep-links--push-notifications)
  - [Expo Router](#expo-router)
  - [Error & Crash Reporting](#error--crash-reporting)
- [Tracing](#tracing)
  - [startSpan](#startspan)
  - [startActiveSpan](#startactivespan)
  - [withSpan](#withspan)
  - [Span Links](#span-links)
  - [recordEvent](#recordevent)
  - [recordException](#recordexception)
- [Sampling](#sampling)
- [Span Processors](#span-processors)
- [Metrics](#metrics)
  - [Counter](#counter)
  - [Histogram](#histogram)
  - [Gauge](#gauge)
- [Logging](#logging)
- [Exporters](#exporters)
  - [OtlpHttpExporter (Spans)](#otlphttpexporter-spans)
  - [OtlpHttpMetricExporter (Metrics)](#otlphttpmetricexporter-metrics)
  - [OtlpHttpLogExporter (Logs)](#otlphttplogexporter-logs)
  - [Multi-Exporter (Fan-out)](#multi-exporter-fan-out)
  - [Console Exporters (Development)](#console-exporters-development)
  - [Custom Exporters](#custom-exporters)
- [React Integration](#react-integration)
  - [OtelProvider](#otelprovider)
  - [useOtel](#useotel)
- [Persistence & Crash Recovery](#persistence--crash-recovery)
- [Connectivity-Aware Flushing](#connectivity-aware-flushing)
- [User Identification](#user-identification)
- [Flush & Shutdown](#flush--shutdown)
- [TypeScript](#typescript)
- [Limitations](#limitations)
- [Contributing](#contributing)

---

## Features

- **Distributed tracing** — W3C `traceparent`, `tracestate`, and `baggage` header injection; parent/child span linking across screens and network requests
- **Span links** — link a span to spans in other traces (batch jobs, fan-in workflows)
- **Sampling** — pluggable `Sampler` interface with `AlwaysOn`, `AlwaysOff`, and `TraceIdRatio` built-ins
- **Span processors** — `SpanProcessor` pipeline for custom enrichment or filtering before export
- **Metrics** — Counter, Histogram (explicit bucket boundaries), and Gauge, exported as real OTLP data
- **Structured logging** — TRACE / DEBUG / INFO / WARN / ERROR / FATAL with automatic trace/span correlation
- **Navigation instrumentation** — automatic screen-level span lifecycle for React Navigation
- **Network instrumentation** — Axios interceptors and global `fetch` patching with W3C context propagation and sensitive field redaction
- **App startup span** — cold-start duration from module-load time to first render
- **Deep link & push notification spans** — `Linking` adapter + manual push-notification recording
- **Expo Router support** — optional hook adapter for file-based navigation (peer dep)
- **App lifecycle metrics** — automatic `app.foreground_count` and `app.background_count` counters
- **Error & crash instrumentation** — JS fatal errors, non-fatal exceptions, and unhandled Promise rejections
- **Multi-exporter fan-out** — send the same telemetry to multiple backends simultaneously
- **Persistence & retry** — Write-Ahead Log (WAL) for spans, metrics, and logs; jitter + exponential backoff; circuit breaker after 5 consecutive failures
- **Connectivity-aware flushing** — plug in any `NetInfo`-compatible adapter to pause delivery while offline
- **Auto platform detection** — `Platform.OS` / `Platform.Version` used as default `osName` / `osVersion`
- **Custom resource attributes** — merge arbitrary key/value pairs into the OTLP resource
- **Cryptographic IDs** — 128-bit trace IDs and 64-bit span IDs via `crypto.getRandomValues()`
- **React integration** — `OtelProvider`, `useOtel` hook, optional error boundary
- **Zero native code** — pure TypeScript, no linking required

---

## Installation

```sh
# npm
npm install react-native-otel

# yarn
yarn add react-native-otel
```

**Peer dependencies** (already in your project):

```sh
react
react-native
```

---

## Quick Start

```ts
// app/_layout.tsx (or App.tsx)
import { otel, OtlpHttpExporter, OtlpHttpMetricExporter } from 'react-native-otel';

otel.init({
  serviceName: 'my-app',
  serviceVersion: '1.0.0',
  environment: 'production',
  exporter: new OtlpHttpExporter({
    endpoint: 'https://your-otel-collector',
    headers: { authorization: 'Bearer YOUR_API_KEY' },
  }),
  metricExporter: new OtlpHttpMetricExporter({
    endpoint: 'https://your-otel-collector',
    headers: { authorization: 'Bearer YOUR_API_KEY' },
  }),
});
```

`osName` and `osVersion` are auto-detected from `Platform.OS` / `Platform.Version` when omitted. Navigation, network, and error instrumentation are wired up separately (see below) for full control over what gets traced.

---

## SDK Configuration

Pass an `OtelConfig` object to `otel.init()`. Call it once, as early as possible in your app entry point. Subsequent calls are no-ops.

```ts
otel.init({
  // ─── Required ───────────────────────────────────────────────
  serviceName: 'my-app',

  // ─── Service metadata ────────────────────────────────────────
  serviceVersion: '1.2.3',        // Default: '0.0.0'
  environment: 'production',      // Default: 'production'
  appBuild: '42',

  // ─── Device metadata ─────────────────────────────────────────
  // osName and osVersion are auto-detected from Platform when omitted.
  osName: 'ios',                  // Default: Platform.OS
  osVersion: '17.4',              // Default: String(Platform.Version)
  deviceBrand: 'Apple',
  deviceModel: 'iPhone 15 Pro',
  deviceType: 'handset',

  // ─── Extra resource attributes ───────────────────────────────
  // Merged into the OTLP resource alongside the standard fields above.
  resourceAttributes: {
    'team': 'mobile',
    'region': 'us-east-1',
  },

  // ─── Exporters ───────────────────────────────────────────────
  exporter: new OtlpHttpExporter({ endpoint: '...' }),
  metricExporter: new OtlpHttpMetricExporter({ endpoint: '...' }),
  logExporter: new OtlpHttpLogExporter({ endpoint: '...' }),

  // ─── Sampling ────────────────────────────────────────────────
  // Legacy: 1.0 = 100%, 0.1 = 10%. Ignored when sampler is set.
  sampleRate: 1.0,
  // Pluggable sampler (takes precedence over sampleRate when set).
  sampler: new TraceIdRatioSampler(0.25), // sample 25% of traces

  // ─── Span processors ─────────────────────────────────────────
  // Custom processors run on every span before it is exported.
  processors: [new SimpleSpanProcessor(myExporter)],

  // ─── Connectivity ─────────────────────────────────────────────
  // Pause flushing when offline (no native dep required).
  networkAdapter: {
    addListener(cb) {
      const unsub = NetInfo.addEventListener(s => cb(!!s.isConnected));
      return unsub;
    },
  },

  // ─── Attributes ──────────────────────────────────────────────
  maxAttributeStringLength: 1024,

  // ─── Network redaction ───────────────────────────────────────
  sensitiveKeys: [
    'header.authorization',
    'header.cookie',
    'body.password',
    'response.token',
  ],

  // ─── Persistence ─────────────────────────────────────────────
  storage: {
    setSync: (key, value) => MMKVStorage.set(key, value),
    getSync: (key) => MMKVStorage.getString(key) ?? null,
    deleteSync: (key) => MMKVStorage.delete(key),
  },
});
```

### OtelConfig reference

| Property | Type | Default | Description |
|---|---|---|---|
| `serviceName` | `string` | — | **Required.** Identifies your service in all telemetry. |
| `serviceVersion` | `string` | `'0.0.0'` | Service version string. |
| `environment` | `string` | `'production'` | Deployment environment. |
| `appBuild` | `string` | `''` | Build number or commit SHA. |
| `osName` | `string` | `Platform.OS` | Operating system name. Auto-detected when omitted. |
| `osVersion` | `string` | `Platform.Version` | OS version string. Auto-detected when omitted. |
| `deviceBrand` | `string` | `''` | Device manufacturer. |
| `deviceModel` | `string` | `''` | Device model name. |
| `deviceType` | `string \| number` | `''` | Device form factor. |
| `resourceAttributes` | `Attributes` | `undefined` | Extra key/value pairs merged into the OTLP resource. |
| `exporter` | `SpanExporter` | `undefined` | Span destination. Omit to discard spans. |
| `metricExporter` | `MetricExporter` | `undefined` | Metric destination. |
| `logExporter` | `LogExporter` | `undefined` | Log destination. |
| `sampleRate` | `number` | `1.0` | Fraction of traces to capture (0–1). Ignored when `sampler` is set. |
| `sampler` | `Sampler` | `undefined` | Pluggable sampler. Takes precedence over `sampleRate`. |
| `processors` | `SpanProcessor[]` | `[]` | Span processor pipeline. |
| `networkAdapter` | `NetworkAdapter` | `undefined` | Connectivity adapter for pause-on-offline flushing. |
| `maxAttributeStringLength` | `number` | `1024` | Truncate attribute strings longer than this. |
| `sensitiveKeys` | `string[]` | `[]` | Dot-notation paths to redact from network captures. |
| `storage` | `StorageAdapter` | `undefined` | Synchronous key/value store for WAL and crash persistence. |

---

## Instrumentation

### Navigation (React Navigation)

Wire up screen-level spans by connecting the instrumentation to your navigation state change handler. Each screen navigation starts a new root span and ends the previous one.

```tsx
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { otel, createNavigationInstrumentation } from 'react-native-otel';

const navigationRef = createNavigationContainerRef();
const navInstrumentation = createNavigationInstrumentation(otel.getTracer());

export default function App() {
  return (
    <NavigationContainer
      ref={navigationRef}
      onReady={() => {
        const route = navigationRef.getCurrentRoute();
        if (route) {
          navInstrumentation.onRouteChange(
            route.name, undefined, route.key, undefined, route.params as Record<string, unknown>
          );
        }
      }}
      onStateChange={() => {
        const current = navigationRef.getCurrentRoute();
        const previous = navigationRef.getPreviousRoute?.();
        if (current) {
          navInstrumentation.onRouteChange(
            current.name, previous?.name,
            current.key, previous?.key,
            current.params as Record<string, unknown>
          );
        }
      }}
    >
      {/* ... */}
    </NavigationContainer>
  );
}
```

#### NavigationInstrumentation API

| Method | Signature | Description |
|---|---|---|
| `onRouteChange` | `(currentName, previousName, currentKey, previousKey, params?) => void` | Call on every navigation state change. Ends the previous screen span and starts a new one. |
| `endCurrentScreen` | `() => void` | Manually end the active screen span. |

---

### Network (Axios)

Creates Axios interceptors that wrap each HTTP request in a CLIENT span and inject W3C `traceparent`, `tracestate`, and `baggage` headers.

```ts
import axios from 'axios';
import { otel, createAxiosInstrumentation } from 'react-native-otel';

const axiosInstrumentation = createAxiosInstrumentation(otel.getTracer(), {
  sensitiveKeys: otel.getSensitiveKeys(),
});

const api = axios.create({ baseURL: 'https://api.example.com' });
api.interceptors.request.use(axiosInstrumentation.onRequest);
api.interceptors.response.use(
  axiosInstrumentation.onResponse,
  axiosInstrumentation.onError
);
```

The following W3C headers are injected automatically on every sampled request:

| Header | Purpose |
|---|---|
| `traceparent` | Continues the trace in your backend (`00-{traceId}-{spanId}-01`) |
| `tracestate` | Forwarded from the active span's `tracestate` attribute when present |
| `baggage` | Built from any span attributes prefixed with `baggage.` |

---

### Network (fetch)

`otel.init()` automatically patches `globalThis.fetch` to create a CLIENT span for every HTTP request. No extra setup is required.

The OTLP exporter's own delivery calls are immune — the SDK snapshots the original `fetch` before installing the instrumentation, so there is no infinite recursion.

If you need to opt out:

```ts
import { uninstallFetchInstrumentation } from 'react-native-otel';

uninstallFetchInstrumentation(); // restores the original fetch
```

---

### App Startup

Records a single `app.startup` span whose duration covers the period from module-load time to the point when this function is called. Call it once, immediately after `otel.init()`, before rendering the first screen.

```ts
import { otel, installStartupInstrumentation } from 'react-native-otel';

otel.init({ serviceName: 'my-app', ... });
installStartupInstrumentation(otel.getTracer());
```

The span carries:

| Attribute | Description |
|---|---|
| `app.startup.module_load_ms` | Timestamp when the JS module was loaded |
| `app.startup.sdk_init_ms` | Timestamp when `otel.init()` completed |

Import `react-native-otel` as early as possible in your entry file to maximise the accuracy of `module_load_ms`.

---

### Deep Links & Push Notifications

```ts
import { otel, createLinkingInstrumentation, recordPushNotification } from 'react-native-otel';

// Creates an app.deep_link span for every incoming URL.
// Also checks getInitialURL() for links that launched the app.
const linking = createLinkingInstrumentation(otel.getTracer());

// Remove the listener when shutting down.
linking.uninstall();

// Record a push notification payload as a standalone span.
recordPushNotification(otel.getTracer(), {
  title: 'New message',
  'notification.id': 'n_123',
});
```

---

### Expo Router

An optional hook adapter for apps using [Expo Router](https://expo.github.io/router/). It requires `expo-router` as a peer dependency and is published under a dedicated sub-path export to keep it out of the main bundle for apps that don't use Expo Router.

```tsx
// app/_layout.tsx
import { useExpoRouterInstrumentation } from 'react-native-otel/expo-router';
import { otel } from 'react-native-otel';

export default function RootLayout() {
  useExpoRouterInstrumentation(otel.getTracer());
  return <Slot />;
}
```

On every route change the hook ends the previous screen span and starts a new `screen.{pathname}` span with `screen.name` and `screen.segments` attributes.

---

### Error & Crash Reporting

Automatically installed by `otel.init()`. No additional setup required.

| Signal | Span name | Key attributes |
|---|---|---|
| Fatal JS error | `crash.{Error.name}` | `exception.type`, `exception.message`, `exception.stacktrace`, `crash.is_fatal: true` |
| Non-fatal JS error | `crash.{Error.name}` | same, `crash.is_fatal: false` |
| Unhandled Promise rejection | `unhandled_rejection.{Error.name}` | `exception.type`, `exception.message`, `exception.stacktrace`, `exception.unhandled_rejection: true` |

**Crash persistence:** Fatal error spans are written synchronously to the `StorageAdapter` before the process terminates and exported on the next app launch.

---

## Tracing

Access the tracer via `otel.getTracer()` or the `useOtel()` hook.

### startSpan

Creates a span without making it the active context.

```ts
const tracer = otel.getTracer();

const span = tracer.startSpan('checkout.process', {
  kind: 'INTERNAL',
  attributes: { 'order.id': orderId, 'order.total': total },
  // parent: pass a SpanContext, or null to force a new root trace.
  // Omit to inherit the current active span automatically.
});

try {
  await processOrder(orderId);
  span.setStatus('OK');
} catch (err) {
  span.recordException(err as Error);
  span.setStatus('ERROR', (err as Error).message);
} finally {
  span.end();
}
```

#### Span API

| Method | Signature | Description |
|---|---|---|
| `setAttribute` | `(key: string, value: AttributeValue) => void` | Set a single attribute. No-op after `end()`. |
| `addEvent` | `(name: string, attrs?: Attributes) => void` | Add a timed event. Capped at 128; excess are dropped and counted. |
| `recordException` | `(error: Error, attrs?: Attributes) => void` | Attach exception details as a span event and set status ERROR. |
| `setStatus` | `(status: SpanStatus, message?: string) => void` | Set the span outcome. |
| `end` | `() => void` | Finalize and export the span. Idempotent. |

---

### startActiveSpan

Creates a span and makes it the active context for the duration of the callback.

```ts
// Synchronous
tracer.startActiveSpan('render.catalog', (span) => {
  span.setAttribute('item.count', items.length);
  renderItems(items);
});

// Async
await tracer.startActiveSpan('fetch.user', async (span) => {
  const user = await api.get('/me'); // network span parents automatically
  span.setAttribute('user.id', user.id);
});

// With options
await tracer.startActiveSpan(
  'payment.authorize',
  { kind: 'CLIENT', attributes: { 'payment.provider': 'stripe' } },
  async (span) => { await stripe.confirmPayment(intent); }
);
```

> **Concurrency note:** `startActiveSpan` uses a shared context stack. For concurrent `Promise.all`-style work, use `startSpan` with explicit parents instead.

---

### withSpan

Makes an existing span the active context without ending it.

```ts
const screenSpan = tracer.startSpan('screen.Dashboard');

tracer.withSpan(screenSpan, () => {
  tracer.startActiveSpan('load.widgets', async (span) => {
    await loadWidgets();
  });
});

screenSpan.end();
```

---

### Span Links

Link a span to one or more spans in other (or the same) traces. Useful for batch processing, fan-in workflows, and message queues.

```ts
import type { SpanLink } from 'react-native-otel';

const links: SpanLink[] = [
  {
    traceId: upstreamSpan.traceId,
    spanId: upstreamSpan.spanId,
    attributes: { 'link.reason': 'triggered_by' },
  },
];

const span = tracer.startSpan('batch.process', { links });
// Links are serialized in OTLP as the `links` array on the span.
span.end();
```

---

### recordEvent

Records a named event on the currently active span.

```ts
otel.recordEvent('button.tapped', { button: 'checkout', screen: 'Cart' });
tracer.recordEvent('video.paused', { position_ms: 32500 });
```

---

### recordException

Records an error as a child span of the current active span.

```ts
try {
  await riskyOperation();
} catch (err) {
  tracer.recordException(err as Error, { component: 'PaymentForm' });
}
```

---

## Sampling

The SDK ships three built-in samplers and accepts any custom implementation of the `Sampler` interface.

```ts
import {
  AlwaysOnSampler,
  AlwaysOffSampler,
  TraceIdRatioSampler,
} from 'react-native-otel';

otel.init({
  serviceName: 'my-app',
  // Sample 10% of traces deterministically by trace ID:
  sampler: new TraceIdRatioSampler(0.1),
});
```

| Sampler | Behaviour |
|---|---|
| `AlwaysOnSampler` | Records every span (default when no sampler is set). |
| `AlwaysOffSampler` | Drops every span. Useful to disable tracing in specific environments. |
| `TraceIdRatioSampler(ratio)` | Samples a deterministic fraction of traces (0–1) using the trace ID. |

`TraceIdRatioSampler` makes sampling decisions based on the first 8 bytes of the trace ID, matching the W3C spec intent. Root spans (no parent) fall back to a random decision at the same ratio.

**Custom sampler:**

```ts
import type { Sampler } from 'react-native-otel';
import type { SpanContext, Attributes } from 'react-native-otel';

class MySampler implements Sampler {
  shouldSample(name: string, parent?: SpanContext, attributes?: Attributes): boolean {
    // Drop health-check spans.
    return name !== 'health.check';
  }
}
```

---

## Span Processors

Span processors run synchronously at span start and end. Use them to enrich spans with extra attributes, filter spans, or forward to a custom exporter without going through the SDK exporter chain.

```ts
import {
  SimpleSpanProcessor,
  NoopSpanProcessor,
} from 'react-native-otel';
import type { SpanProcessor, ReadonlySpan } from 'react-native-otel';
import type { Span } from 'react-native-otel';

// SimpleSpanProcessor: wraps an exporter — calls export() immediately on end().
otel.init({
  serviceName: 'my-app',
  processors: [new SimpleSpanProcessor(myCustomExporter)],
});

// Custom processor: enrich every span with a 'session.id' attribute.
class SessionProcessor implements SpanProcessor {
  onStart(span: Span): void {
    span.setAttribute('session.id', currentSessionId());
  }
  onEnd(_span: ReadonlySpan): void {}
}

otel.init({
  serviceName: 'my-app',
  exporter: new OtlpHttpExporter({ endpoint: '...' }),
  processors: [new SessionProcessor()],
});
```

When `processors` is set, each span's `end()` calls the processors in order instead of calling the exporter directly. To both enrich and export, use a `SimpleSpanProcessor` wrapping your exporter as the last processor in the array.

---

## Metrics

Access the meter via `otel.getMeter()` or the `useOtel()` hook.

### Counter

A monotonically increasing value. Exported as an OTLP cumulative sum.

```ts
const meter = otel.getMeter();
const apiCallCounter = meter.createCounter('api.calls');

apiCallCounter.add(1);
apiCallCounter.add(1, { endpoint: '/checkout', status: '200' });
```

---

### Histogram

Records a distribution of values. Aggregates per unique attribute set and exports as real OTLP explicit bucket histogram data. Default boundaries cover typical mobile latencies in milliseconds.

```ts
const requestDuration = meter.createHistogram('http.client.duration', {
  // Default: [0, 5, 10, 25, 50, 75, 100, 250, 500, 1000]
  boundaries: [0, 10, 50, 100, 500, 1000, 5000],
});

const start = Date.now();
await api.get('/products');
requestDuration.record(Date.now() - start, { endpoint: '/products' });
```

Histograms flush via `meter.flush()` which is called automatically on app background, `otel.flush()`, and `otel.shutdown()`. Each flush window uses DELTA temporality — buckets are cleared after each flush.

---

### Gauge

Records an instantaneous value (last-write-wins).

```ts
const memoryGauge = meter.createGauge('app.memory.used_mb');

setInterval(() => {
  memoryGauge.set(getCurrentMemoryUsageMB(), { unit: 'mb' });
}, 10_000);
```

---

### Built-in lifecycle metrics

`otel.init()` automatically installs two counters that track app lifecycle transitions:

| Metric | Description |
|---|---|
| `app.foreground_count` | Incremented each time the app moves to the foreground (`active` state). |
| `app.background_count` | Incremented each time the app moves to the background. Also triggers a metric flush. |

---

## Logging

Access the logger via `otel.getLogger()` or the `useOtel()` hook.

```ts
const logger = otel.getLogger();

logger.trace('Entering render cycle', { component: 'ProductList' });
logger.debug('Cache hit', { key: 'products:page:1' });
logger.info('User signed in', { 'user.id': userId });
logger.warn('API rate limit approaching', { remaining: 10 });
logger.error('Payment failed', { code: 'CARD_DECLINED' });
logger.fatal('Out of memory — terminating');
```

All log records include `severity`, `body`, `traceId`, `spanId`, `attributes`, and `timestampMs`.

---

## Exporters

### OtlpHttpExporter (Spans)

Sends spans to any OTLP/HTTP-compatible backend. `/v1/traces` is appended to the endpoint automatically.

```ts
import { OtlpHttpExporter } from 'react-native-otel';

new OtlpHttpExporter({
  endpoint: 'https://in-otel.hyperdx.io',
  headers: { authorization: 'Bearer YOUR_API_KEY' },
  batchSize: 50,           // Flush when buffer hits this size. Default: 50.
  flushIntervalMs: 30_000, // Auto-flush interval in ms. Default: 30 s.
})
```

---

### OtlpHttpMetricExporter (Metrics)

Sends metrics to any OTLP/HTTP-compatible backend. `/v1/metrics` is appended automatically. Metrics are buffered and flushed on the interval or when `flush()` / `destroy()` is called.

```ts
import { OtlpHttpMetricExporter } from 'react-native-otel';

new OtlpHttpMetricExporter({
  endpoint: 'https://your-collector',
  headers: { authorization: 'Bearer YOUR_API_KEY' },
  flushIntervalMs: 30_000, // Default: 30 s.
})
```

Exported metric types:
- **Counter** → OTLP `sum` (cumulative, monotonic)
- **Histogram** → OTLP `histogram` (explicit buckets, delta temporality)
- **Gauge** → OTLP `gauge`

---

### OtlpHttpLogExporter (Logs)

Sends logs to any OTLP/HTTP-compatible backend. `/v1/logs` is appended automatically. Supports WAL persistence (pass `storage` in `otel.init()`).

```ts
import { OtlpHttpLogExporter } from 'react-native-otel';

new OtlpHttpLogExporter({
  endpoint: 'https://your-collector',
  headers: { authorization: 'Bearer YOUR_API_KEY' },
  batchSize: 50,           // Default: 50
  flushIntervalMs: 30_000, // Default: 30 s
})
```

---

### Multi-Exporter (Fan-out)

Send the same signal to multiple backends simultaneously. Each exporter is called independently — a failure in one does not affect the others.

```ts
import {
  MultiSpanExporter,
  MultiMetricExporter,
  MultiLogExporter,
  OtlpHttpExporter,
  ConsoleSpanExporter,
} from 'react-native-otel';

otel.init({
  serviceName: 'my-app',
  exporter: new MultiSpanExporter([
    new OtlpHttpExporter({ endpoint: 'https://grafana-cloud...' }),
    new OtlpHttpExporter({ endpoint: 'https://hyperdx...' }),
    new ConsoleSpanExporter(), // also log to console in dev
  ]),
});
```

---

### Console Exporters (Development)

Pretty-print telemetry to the React Native console.

```ts
import {
  ConsoleSpanExporter,
  ConsoleMetricExporter,
  ConsoleLogExporter,
} from 'react-native-otel';

otel.init({
  serviceName: 'my-app',
  exporter: new ConsoleSpanExporter(),
  metricExporter: new ConsoleMetricExporter(),
  logExporter: new ConsoleLogExporter(),
});
```

---

### Custom Exporters

```ts
import type {
  SpanExporter, MetricExporter, LogExporter,
  ReadonlySpan, MetricRecord, LogRecord,
} from 'react-native-otel';

class MySpanExporter implements SpanExporter {
  export(spans: ReadonlySpan[]): void {
    for (const span of spans) {
      sendToMyBackend(span);
    }
  }
}
```

---

## React Integration

### OtelProvider

```tsx
import { OtelProvider } from 'react-native-otel';

export default function App() {
  return (
    <OtelProvider withErrorBoundary>
      <RootNavigator />
    </OtelProvider>
  );
}
```

`withErrorBoundary` wraps children in a React error boundary that calls `tracer.recordException()` on render errors.

---

### useOtel

```tsx
import { useOtel } from 'react-native-otel';

function CheckoutButton() {
  const { tracer, meter, logger, recordEvent, setUser } = useOtel();
  const checkoutCounter = meter.createCounter('checkout.attempts');

  const handlePress = async () => {
    recordEvent('checkout.button.tapped');
    checkoutCounter.add(1, { source: 'cart_screen' });

    await tracer.startActiveSpan('checkout.submit', async (span) => {
      try {
        const order = await api.post('/orders', cartItems);
        span.setAttribute('order.id', order.id);
        logger.info('Order placed', { 'order.id': order.id });
      } catch (err) {
        logger.error('Checkout failed', { reason: (err as Error).message });
        throw err;
      }
    });
  };

  return <Button onPress={handlePress} title="Check Out" />;
}
```

---

## Persistence & Crash Recovery

When you provide a `StorageAdapter`, the SDK enables WAL persistence for spans, metrics, and logs.

### Write-Ahead Log (WAL)

Before each network export attempt, batches are serialized to storage. If the app crashes or loses connectivity, the data survives. On the next `otel.init()`, undelivered batches are replayed automatically.

WAL limits:
- **Max 3 batches** per signal type. Oldest are evicted to prevent unbounded growth.
- **Max 500 items** per batch.
- **Exponential backoff** with jitter — up to 3 retries per batch (base delay: 500 ms). 4xx responses are not retried.
- **Circuit breaker** — after 5 consecutive delivery failures for an endpoint, attempts are paused for 60 seconds to avoid hammering an unavailable backend.

### Crash span persistence

Fatal JS errors are written synchronously to storage and exported on the next app launch.

### StorageAdapter interface

```ts
interface StorageAdapter {
  setSync(key: string, value: string): void;
  getSync(key: string): string | null;
  deleteSync(key: string): void;
}
```

**MMKV example** (recommended):

```ts
import { MMKV } from 'react-native-mmkv';
const storage = new MMKV();

otel.init({
  serviceName: 'my-app',
  storage: {
    setSync: (key, value) => storage.set(key, value),
    getSync: (key) => storage.getString(key) ?? null,
    deleteSync: (key) => storage.delete(key),
  },
});
```

> `AsyncStorage` is not compatible — the adapter must be synchronous.

---

## Connectivity-Aware Flushing

Provide a `NetworkAdapter` to automatically pause telemetry delivery while the device is offline and resume immediately when connectivity is restored.

```ts
import NetInfo from '@react-native-community/netinfo';
import type { NetworkAdapter } from 'react-native-otel';

const networkAdapter: NetworkAdapter = {
  addListener(cb) {
    const unsub = NetInfo.addEventListener((state) => cb(!!state.isConnected));
    return unsub; // called on otel.shutdown()
  },
};

otel.init({
  serviceName: 'my-app',
  networkAdapter,
  ...
});
```

`NetworkAdapter` is a plain interface — any connectivity library works. `@react-native-community/netinfo` is **not** a dependency of `react-native-otel`.

---

## User Identification

```ts
// After login
otel.setUser({ id: '42', email: 'user@example.com' });

// Via context hook
const { setUser } = useOtel();
setUser({ id: currentUser.id });

// Clear on logout
otel.setUser({});
```

User attributes are attached as `user.id` and `user.email` to all spans created after the call.

---

## Flush & Shutdown

### otel.flush()

Sends all buffered spans and metrics. When a `NetworkAdapter` is configured and the device is offline, `flush()` is a no-op — data stays buffered until connectivity is restored.

```ts
await api.logout();
otel.flush();
navigation.reset({ routes: [{ name: 'Login' }] });
```

### otel.shutdown()

Ends the active screen span, flushes all buffers, clears flush timers, and removes the network listener.

```ts
AppState.addEventListener('change', (state) => {
  if (state === 'background') otel.shutdown();
});
```

---

## TypeScript

All public types are exported from the package root:

```ts
import type {
  // Config & adapters
  OtelConfig,
  NetworkAdapter,

  // Core
  SpanKind,
  SpanStatus,
  SpanEvent,
  SpanLink,
  SpanOptions,
  ReadonlySpan,
  SpanProcessor,
  Attributes,
  AttributeValue,
  Resource,

  // Sampling
  Sampler,

  // Metrics
  HistogramOptions,

  // Logging
  LogSeverity,

  // Context
  SpanContextManagerPublic,

  // Exporters
  SpanExporter,
  MetricExporter,
  LogExporter,
  MetricRecord,
  LogRecord,

  // Instrumentation
  NavigationInstrumentation,
  AxiosInstrumentation,
  AxiosInstrumentationOptions,
  OtelAxiosRequestConfig,
  OtelAxiosResponse,
  FetchInstrumentationOptions,
  LinkingInstrumentation,
  StorageAdapter,

  // React
  OtelContextValue,
  OtelProviderProps,
} from 'react-native-otel';
```

The current SDK version is also exported:

```ts
import { SDK_VERSION } from 'react-native-otel';
// e.g. '0.1.4'
```

---

## Limitations

### No concurrent async context propagation

React Native runs on a single JS thread without `AsyncLocalStorage`. The context stack is shared across the event loop — interleaved `await` calls can corrupt active span tracking:

```ts
// BAD — concurrent spans racing on the shared context stack
await Promise.all([
  tracer.startActiveSpan('fetch.a', async () => { await fetchA(); }),
  tracer.startActiveSpan('fetch.b', async () => { await fetchB(); }),
]);

// GOOD — pass parents explicitly for concurrent work
const parent = spanContext.current();
await Promise.all([
  (async () => {
    const span = tracer.startSpan('fetch.a', { parent });
    try { await fetchA(); span.setStatus('OK'); }
    finally { span.end(); }
  })(),
  (async () => {
    const span = tracer.startSpan('fetch.b', { parent });
    try { await fetchB(); span.setStatus('OK'); }
    finally { span.end(); }
  })(),
]);
```

### OTLP/HTTP JSON only

The built-in exporters speak OTLP over HTTP using JSON encoding. OTLP/gRPC and OTLP/HTTP protobuf are not currently supported. Most SaaS observability platforms accept OTLP/HTTP JSON natively.

### Head-based sampling only

The `sampleRate` and `Sampler` options make decisions at span creation time. Tail-based sampling (deciding after the full trace completes) is not supported.

### StorageAdapter must be synchronous

The `StorageAdapter` interface requires synchronous `get`/`set`/`delete`. `AsyncStorage` and other async stores are incompatible. Use [react-native-mmkv](https://github.com/mrousavy/react-native-mmkv) or a similar synchronous store.

### WAL storage limits

The WAL caps at **3 batches per signal type** with a maximum of **500 items per batch**. Data beyond these limits is evicted (oldest first). Very high-volume apps could lose telemetry during extended offline periods.

### Expo Router instrumentation is opt-in

`useExpoRouterInstrumentation` is available via the `react-native-otel/expo-router` sub-path export. Ensure `expo-router` is installed before using it.

---

## Contributing

Contributions are welcome. This project is a Yarn workspace monorepo containing the library (root) and an example app (`example/`).

### Prerequisites

- Node.js — see [`.nvmrc`](./.nvmrc) for the required version
- Yarn 4 — `corepack enable && corepack prepare yarn@4.11.0 --activate`

### Setup

```sh
git clone https://github.com/03balogun/react-native-otel.git
cd react-native-otel
yarn
```

### Common commands

| Command | Description |
|---|---|
| `yarn test` | Run the Jest test suite |
| `yarn test --watch` | Run tests in watch mode |
| `yarn typecheck` | Type-check with TypeScript |
| `yarn lint` | Lint with ESLint + Prettier |
| `yarn lint --fix` | Auto-fix lint and formatting errors |
| `yarn prepare` | Build the library (outputs to `lib/`) |
| `yarn example start` | Start the Metro bundler for the example app |
| `yarn example ios` | Run the example app on iOS |
| `yarn example android` | Run the example app on Android |

### Running tests

```sh
yarn test          # all tests
yarn test --watch  # watch mode
yarn test --ci     # CI mode
```

Tests live in `src/__tests__/`. New features should include corresponding tests. Aim to test behaviour, not implementation details.

### Sending a pull request

1. **Open an issue first** for any change that affects the public API or architecture.
2. **Fork** the repo and create a branch from `main`.
3. **Write tests** and ensure the full suite passes (`yarn test`).
4. **Pass all checks** — `yarn typecheck`, `yarn lint`.
5. **Keep PRs small and focused** on a single concern.
6. Submit against `main`. CI runs tests and a build check automatically.

### Releasing

Releases are fully automated. Every push to `main` that is not a bot commit triggers the [Release workflow](.github/workflows/release.yml), which bumps the patch version, publishes to npm, and creates a GitHub release.

---

## License

MIT © [Wahab Balogun](https://github.com/03balogun)
