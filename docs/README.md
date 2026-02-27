# react-native-otel

A lightweight, zero-native-dependency OpenTelemetry-compatible SDK for React Native. Replaces Amplitude + Sentry (JS-side) + Firebase Performance with a single unified observability layer that emits standards-compliant OTLP signals.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Package Structure](#package-structure)
3. [SDK Initialization](#sdk-initialization)
4. [OtelConfig Reference](#otelconfig-reference)
5. [Core Modules](#core-modules)
   - [Span & Tracer](#span--tracer)
   - [Meter (Metrics)](#meter-metrics)
   - [OtelLogger (Logs)](#otellogger-logs)
   - [Attributes](#attributes)
   - [Resource](#resource)
   - [SpanContext](#spancontext)
6. [Exporters](#exporters)
   - [OtlpHttpExporter (Traces)](#otlphttpexporter-traces)
   - [OtlpHttpMetricExporter](#otlphttpmetricexporter)
   - [OtlpHttpLogExporter](#otlphttplogexporter)
   - [ConsoleSpanExporter / ConsoleMetricExporter / ConsoleLogExporter](#console-exporters)
   - [Custom Exporters](#custom-exporters)
7. [Instrumentation](#instrumentation)
   - [Navigation](#navigation-instrumentation)
   - [Network / Axios](#network--axios-instrumentation)
   - [Error Handling](#error-handling)
   - [App Lifecycle](#app-lifecycle)
8. [React Integration](#react-integration)
9. [OTel Attribute Names](#otel-attribute-names)
10. [App Wiring Guide](#app-wiring-guide)
11. [Design Decisions & Rationale](#design-decisions--rationale)
12. [Known Limitations](#known-limitations)
13. [Bugs Fixed / Gotchas](#bugs-fixed--gotchas)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                          App code                            │
│  trackEvent()  →  otel.recordEvent()                        │
│  apiClient interceptors  →  createAxiosInstrumentation()    │
│  NavigationContainer  →  createNavigationInstrumentation()  │
└─────────────────────────────┬───────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────┐
│                         OtelSDK                              │
│  init()  setUser()  getTracer()  getMeter()  getLogger()    │
│  recordEvent()  shutdown()                                   │
└──────────┬─────────────────┬──────────────────┬────────────┘
           │                 │                  │
      ┌────▼────┐      ┌─────▼─────┐     ┌─────▼─────┐
      │ Tracer  │      │   Meter   │     │OtelLogger │
      │ Span    │      │ Counter   │     │ emit()    │
      │ NoopSpan│      │ Histogram │     └─────┬─────┘
      └────┬────┘      │ Gauge     │           │
           │           └─────┬─────┘           │
           │                 │                 │
┌──────────▼─────────────────▼─────────────────▼────────────┐
│                       Exporters                             │
│  OtlpHttpExporter  OtlpHttpMetricExporter  OtlpHttpLog..   │
│  ConsoleSpanExporter  ConsoleMetricExporter  ConsoleLog..   │
└──────────────────────────┬──────────────────────────────────┘
                           │  OTLP/HTTP JSON
                    ┌──────▼──────┐
                    │  Collector  │
                    │  HyperDX    │
                    │  Grafana    │
                    │  Honeycomb  │
                    │  (any OTLP) │
                    └─────────────┘
```

**Signal flow:**
- **Traces**: Screen → span started on `onRouteChange`, events added via `recordEvent()`, network calls create child spans, span ends on next `onRouteChange`
- **Metrics**: Counters/histograms/gauges written to an in-memory buffer, flushed to exporter on `AppState → background` or explicit `meter.flush()`
- **Logs**: Emitted immediately; auto-attached `traceId`/`spanId` from the current screen span

---

## Package Structure

```
packages/react-native-otel/
├── package.json                    # name: "react-native-otel"
├── tsconfig.json                   # extends root tsconfig
├── docs/
│   └── README.md                  # this file
└── src/
    ├── index.ts                    # public API barrel export
    ├── sdk.ts                      # OtelSDK singleton (otel)
    ├── context/
    │   └── span-context.ts         # current screen span singleton
    ├── core/
    │   ├── attributes.ts           # AttributeValue, sanitizeValue, sanitizeAttributes
    │   ├── clock.ts                # now() → Date.now()
    │   ├── ids.ts                  # generateTraceId(), generateSpanId()
    │   ├── log-record.ts           # OtelLogger
    │   ├── meter.ts                # Meter, Counter, Histogram, Gauge
    │   ├── resource.ts             # Resource interface + buildResource()
    │   ├── span.ts                 # Span, NoopSpan, SpanExporter, ReadonlySpan
    │   └── tracer.ts               # Tracer
    ├── exporters/
    │   ├── types.ts                # MetricExporter, LogExporter, MetricRecord, LogRecord
    │   ├── console-exporter.ts     # ConsoleSpan/Metric/LogExporter
    │   └── otlp-http-exporter.ts  # OtlpHttp{Span,Metric,Log}Exporter
    ├── instrumentation/
    │   ├── errors.ts               # installErrorInstrumentation, StorageAdapter
    │   ├── lifecycle.ts            # installLifecycleInstrumentation
    │   ├── navigation.ts           # createNavigationInstrumentation
    │   └── network.ts              # createAxiosInstrumentation
    └── react/
        ├── OtelProvider.tsx        # OtelProvider, OtelContext, OtelErrorBoundary
        └── useOtel.ts              # useOtel() hook
```

**Path alias** (wired in `tsconfig.json` and `babel.config.js`):
```
@react-native-otel  →  ./packages/react-native-otel/src
```

---

## SDK Initialization

Call `otel.init()` at **module scope** in `App.tsx`, before any React rendering:

```typescript
import { OtlpHttpExporter, OtlpHttpMetricExporter, OtlpHttpLogExporter, otel } from '@react-native-otel'
import * as Application from 'expo-application'
import * as Device from 'expo-device'

otel.init({
  serviceName: 'expenseai-mobile',
  serviceVersion: Application.nativeApplicationVersion ?? '0.0.0',
  osName: Device.osName ?? '',
  osVersion: Device.osVersion ?? '',
  deviceBrand: Device.brand ?? '',
  deviceModel: Device.modelName ?? '',
  deviceType: Device.deviceType ?? '',
  appBuild: Application.nativeBuildVersion ?? '',
  environment: process.env.EXPO_PUBLIC_ENV ?? 'production',

  exporter: new OtlpHttpExporter({
    endpoint: 'https://in-otel.hyperdx.io',
    headers: { authorization: process.env.EXPO_PUBLIC_HYPERDX_API_KEY ?? '' }
  }),
  metricExporter: new OtlpHttpMetricExporter({
    endpoint: 'https://in-otel.hyperdx.io',
    headers: { authorization: process.env.EXPO_PUBLIC_HYPERDX_API_KEY ?? '' }
  }),
  logExporter: new OtlpHttpLogExporter({
    endpoint: 'https://in-otel.hyperdx.io',
    headers: { authorization: process.env.EXPO_PUBLIC_HYPERDX_API_KEY ?? '' }
  }),

  sampleRate: 1.0,
  debug: __DEV__,
  sensitiveKeys: ['header.authorization', 'body.password', 'response.token']
})

export default function App() { ... }
```

> **Why module scope?** Ensures the SDK is fully initialized before `NavigationContainer` renders and calls `otel.getTracer()`. Any call to `otel.getTracer()` / `getMeter()` / `getLogger()` before `init()` throws.

---

## OtelConfig Reference

| Field | Type | Default | Description |
|---|---|---|---|
| `serviceName` | `string` | required | Maps to `service.name` resource attribute |
| `serviceVersion` | `string` | `'0.0.0'` | Maps to `service.version` |
| `osName` | `string` | `''` | Maps to `os.name` |
| `osVersion` | `string` | `''` | Maps to `os.version` |
| `deviceBrand` | `string` | `''` | Maps to `device.manufacturer` |
| `deviceModel` | `string` | `''` | Maps to `device.model.name` |
| `deviceType` | `string \| number` | `''` | Maps to custom `device.type` |
| `appBuild` | `string` | `''` | Maps to `app.build_id` |
| `environment` | `string` | `'production'` | Maps to `deployment.environment.name` |
| `exporter` | `SpanExporter` | `undefined` | Span exporter (traces) |
| `metricExporter` | `MetricExporter` | `undefined` | Metric exporter |
| `logExporter` | `LogExporter` | `undefined` | Log exporter |
| `sampleRate` | `number` | `1.0` | Fraction of spans to keep (0.0–1.0) |
| `debug` | `boolean` | `false` | Enables console exporter verbose output |
| `storage` | `StorageAdapter` | `undefined` | Synchronous KV store for crash span persistence |
| `maxAttributeStringLength` | `number` | `1024` | Truncates string attribute values longer than this |
| `sensitiveKeys` | `string[]` | `[]` | Dot-notation keys to redact in network captures |

### `sensitiveKeys` format

Section-prefixed dot-notation paths:

| Prefix | Redacts from |
|---|---|
| `header.{key}` | Both request and response headers |
| `body.{key}` | Request body |
| `param.{key}` | URL query params |
| `response.{key}` | Response body |

Example: `['header.authorization', 'body.password', 'response.token', 'param.api_key']`

Matching is case-insensitive. Redacted values are replaced with `'[REDACTED]'`.

---

## Core Modules

### Span & Tracer

#### `Span`

The main unit of work. Created via `tracer.startSpan()`, never directly.

```typescript
interface ReadonlySpan {
  readonly traceId: string           // 32-char hex
  readonly spanId: string            // 16-char hex
  readonly parentSpanId: string | undefined
  readonly name: string
  readonly kind: SpanKind            // 'INTERNAL' | 'CLIENT' | 'SERVER' | 'PRODUCER' | 'CONSUMER'
  readonly startTimeMs: number
  readonly endTimeMs: number | undefined
  readonly attributes: Readonly<Attributes>
  readonly events: readonly SpanEvent[]
  readonly droppedEventsCount: number
  readonly status: SpanStatus        // 'UNSET' | 'OK' | 'ERROR'
  readonly statusMessage: string | undefined
}
```

**Mutable methods** (all no-op after `end()` is called):

```typescript
span.setAttribute(key: string, value: AttributeValue): void
span.addEvent(name: string, attrs?: Attributes): void
span.setStatus(status: SpanStatus, message?: string): void
span.recordException(error: Error, attrs?: Attributes): void
span.end(): void  // sets endTimeMs, flushes to exporter, auto-sets status=OK if UNSET
```

**Event limit:** `MAX_EVENTS = 128`. Events beyond the limit increment `droppedEventsCount` and are silently dropped.

#### `NoopSpan`

Returned by `Tracer.startSpan()` when the span is sampled out. Implements the full `Span` interface with empty methods. Callers never need to null-check.

#### `SpanContext`

```typescript
interface SpanContext {
  traceId: string
  spanId: string
}
```

Used to link child spans to a parent's trace. Passed as `parent` option to `tracer.startSpan()`.

#### `Tracer`

```typescript
class Tracer {
  startSpan(
    name: string,
    options?: {
      kind?: SpanKind
      attributes?: Attributes
      // Explicit parent → inherit traceId from it.
      // Omitted → auto-uses spanContext.current() (current screen span).
      // null → force a new root trace.
      parent?: SpanContext | null
    }
  ): Span | NoopSpan

  // Adds an event to the current screen span (spanContext.current()).
  // No-op if no current span.
  recordEvent(name: string, attributes?: Attributes): void

  // Creates a short-lived ERROR span and ends it immediately.
  // Useful for standalone error reporting outside a screen context.
  recordException(error: Error, attributes?: Attributes): void
}
```

**Parent resolution order** (in `startSpan`):
1. `options.parent` if explicitly provided (even `null` → new root trace)
2. `spanContext.current()` (auto-inherited from current screen span)
3. No parent → brand-new `traceId`

**Sampling:** If `sampleRate < 1.0` and `Math.random() > sampleRate`, returns a `NoopSpan` immediately, before any parent resolution.

**User attributes:** Every span created by `Tracer.startSpan()` automatically merges the current `userAttributes` (set via `otel.setUser()`) into the span's initial attributes. These are span-level, not resource-level.

---

### Meter (Metrics)

```typescript
class Meter {
  createCounter(name: string): Counter
  createHistogram(name: string): Histogram
  createGauge(name: string): Gauge
  flush(): void  // drains buffer → exporter
}

class Counter {
  add(value: number, attrs?: Attributes): void
}

class Histogram {
  record(value: number, attrs?: Attributes): void
}

class Gauge {
  set(value: number, attrs?: Attributes): void
}
```

**Flushing:** Metrics are buffered in memory. `flush()` is called automatically when the app goes to background (`AppState → 'background'`) via `installLifecycleInstrumentation`. Also called in `otel.shutdown()`.

**OTLP mapping:**
- `counter` → OTLP `sum` with `isMonotonic: true`, aggregation `CUMULATIVE`
- `histogram` / `gauge` → OTLP `gauge` (no bucket data — raw values only)

---

### OtelLogger (Logs)

```typescript
class OtelLogger {
  trace(body: string, attrs?: Attributes): void
  debug(body: string, attrs?: Attributes): void
  info(body: string, attrs?: Attributes): void
  warn(body: string, attrs?: Attributes): void
  error(body: string, attrs?: Attributes): void
  fatal(body: string, attrs?: Attributes): void
}
```

Each method emits a `LogRecord` immediately (no buffering). `traceId` and `spanId` are auto-attached from `spanContext.current()` — logs are automatically correlated to the active screen span.

**LogRecord shape:**
```typescript
interface LogRecord {
  timestampMs: number
  severity: string          // 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL'
  body: string
  traceId: string | undefined
  spanId: string | undefined
  attributes: Attributes
}
```

**OTLP severity number mapping:**

| Severity | OTLP Number |
|---|---|
| TRACE | 1 |
| DEBUG | 5 |
| INFO | 9 |
| WARN | 13 |
| ERROR | 17 |
| FATAL | 21 |

---

### Attributes

```typescript
type AttributeValue = string | number | boolean | string[] | number[] | boolean[]
type Attributes = Record<string, AttributeValue>

// Sanitizes a single unknown value → AttributeValue | undefined
// Returns undefined for null/undefined so callers can skip writing the key.
// Plain objects → JSON.stringify (avoids '[object Object]')
// Arrays → element-wise string truncation
// Strings → truncated to maxAttributeStringLength (default 1024)
function sanitizeValue(value: unknown): AttributeValue | undefined

// Bulk sanitize — used in Span constructor and addEvent
function sanitizeAttributes(attrs: Attributes | Record<string, unknown>): Attributes
```

`maxAttributeStringLength` is a module-level `let` default `1024`, configurable via `OtelConfig.maxAttributeStringLength` → `setMaxStringLength()` at init time.

---

### Resource

Device/app metadata. Populated once at `otel.init()`, immutable thereafter (frozen object). User identity is NOT stored here — see `otel.setUser()`.

```typescript
interface Resource {
  'service.name': string              // ATTR_SERVICE_NAME
  'service.version': string           // ATTR_SERVICE_VERSION
  'os.name': string                   // ATTR_OS_NAME
  'os.version': string                // ATTR_OS_VERSION
  'device.manufacturer': string       // ATTR_DEVICE_MANUFACTURER (was 'device.brand')
  'device.model.name': string         // ATTR_DEVICE_MODEL_NAME (was 'device.model')
  'device.type': string | number      // custom — no OTel stable equivalent
  'app.build_id': string              // ATTR_APP_BUILD_ID (was 'app.build')
  'deployment.environment.name': string  // ATTR_DEPLOYMENT_ENVIRONMENT_NAME
}
```

The `Resource` is injected into all three exporters via duck-typed `setResource(resource)` — called by `OtelSDK.init()` on any exporter that exposes this method. The OTLP exporters use it to populate the `resource.attributes` in every batch payload.

---

### SpanContext

Module-level singleton tracking the **current active screen span** only.

```typescript
class SpanContextManager {
  current(): Span | NoopSpan | undefined
  setCurrent(span: Span | NoopSpan | undefined): void
}
export const spanContext = new SpanContextManager()
```

**Important:** This is NOT a stack. There is only one current context at a time, representing the current screen. Network spans do NOT interact with `spanContext` — they capture the parent context by value at request start and operate independently (concurrent-safe).

---

## Exporters

### OtlpHttpExporter (Traces)

```typescript
import { OtlpHttpExporter } from '@react-native-otel'

new OtlpHttpExporter({
  endpoint: string,         // Base URL, e.g. 'https://in-otel.hyperdx.io'
                            // '/v1/traces' is appended automatically
  headers?: Record<string, string>,  // e.g. { authorization: '<api-key>' }
  batchSize?: number,       // Default: 50. Flush immediately when buffer reaches this
  flushIntervalMs?: number  // Default: 30_000. Auto-flush interval in ms
})
```

**Behavior:**
- Buffers spans in memory
- Flushes when buffer reaches `batchSize` OR every `flushIntervalMs` ms
- `destroy()` clears the interval timer and flushes remaining spans (called by `otel.shutdown()`)
- All network I/O is fire-and-forget (`fetch()` returns immediately; `.catch(() => {})` suppresses errors)

**OTLP format notes:**
- `parentSpanId` is **omitted** for root spans (empty string breaks trace tree assembly in collectors)
- `status.message` is **omitted** when empty (some parsers reject empty string)
- Timestamps: `ms * 1_000_000` → nanosecond strings (representable in float64 for current epoch values)

### OtlpHttpMetricExporter

```typescript
new OtlpHttpMetricExporter({
  endpoint: string,         // '/v1/metrics' appended automatically
  headers?: Record<string, string>
})
```

**Behavior:** No internal buffering — `export()` sends immediately. Metrics are buffered by `Meter` and delivered as a batch when `meter.flush()` is called. Groups records by metric name into a single OTLP metric per name.

### OtlpHttpLogExporter

```typescript
new OtlpHttpLogExporter({
  endpoint: string,         // '/v1/logs' appended automatically
  headers?: Record<string, string>,
  batchSize?: number,       // Default: 50
  flushIntervalMs?: number  // Default: 30_000
})
```

Same buffering behavior as `OtlpHttpExporter`.

**OTLP format notes:**
- `traceId` and `spanId` are omitted when absent (not empty-string)

### Console Exporters

```typescript
import { ConsoleSpanExporter, ConsoleMetricExporter, ConsoleLogExporter } from '@react-native-otel'

// Pretty-prints only when debug: true OR NODE_ENV === 'development'
new ConsoleSpanExporter()
new ConsoleMetricExporter()
new ConsoleLogExporter()
```

Example output:
```
[OTEL SPAN] screen.HomeScreen (traceId=abc123 spanId=def456)
  duration: 4231ms  status: OK
  attributes: { app.screen.name: 'HomeScreen', user.id: 'u_123' }
  events:
    [+12ms]  Clicked Scan Receipt  {}
    [+820ms] http.POST /api/v1/receipts → 201 (480ms)
  dropped_events: 0
```

### Custom Exporters

Implement the relevant interface:

```typescript
// Spans
interface SpanExporter {
  export(spans: ReadonlySpan[]): void
}

// Metrics
interface MetricExporter {
  export(metrics: MetricRecord[]): void
}

// Logs
interface LogExporter {
  export(logs: LogRecord[]): void
}
```

If your exporter needs the resource (for OTLP payloads), optionally add:
```typescript
setResource(resource: Readonly<Resource>): void  // duck-typed, not part of interface
destroy(): void                                   // duck-typed, called by otel.shutdown()
```

The SDK calls `setResource()` and `destroy()` via duck-typing (no interface cast required).

---

## Instrumentation

### Navigation Instrumentation

Tracks screen transitions as OpenTelemetry spans. Keyed by React Navigation route `key` (not `name`) — handles modals and tabs coexisting safely.

```typescript
import { createNavigationInstrumentation } from '@react-native-otel'

const navOtel = createNavigationInstrumentation(otel.getTracer())

// Call on every route change in NavigationContainer.onStateChange
navOtel.onRouteChange(
  currentName: string,      // e.g. 'HomeScreen'
  previousName: string | undefined,
  currentKey: string,       // React Navigation unique route key
  previousKey: string | undefined,
  params?: Record<string, unknown>
)

// Call when manually ending the current screen span
navOtel.endCurrentScreen()
```

**Span attributes:**

| Attribute | Value |
|---|---|
| `app.screen.name` | Current screen name (OTel `ATTR_APP_SCREEN_NAME`) |
| `app.screen.previous_name` | Previous screen name (custom) |
| `app.screen.params` | `JSON.stringify(params)` (custom, omitted if no params) |
| + user attributes | Merged from `otel.setUser()` |

**Span name format:** `screen.{screenName}` (e.g. `screen.HomeScreen`)

**Why route key, not route name?** Two tabs can share the same screen name. Route `key` is unique per navigation instance — it correctly handles modals, tabs, and deeply nested navigators.

**NavigationContainer wiring (`src/navigation/NavigationContainer.tsx`):**
```typescript
const navOtel = useMemo(() => createNavigationInstrumentation(otel.getTracer()), [])
const routeKeyRef = useRef<string | null>(null)

onStateChange={async () => {
  const currentRoute = navigationRef?.getCurrentRoute()
  const currentRouteKey = currentRoute?.key
  if (!currentRoute || !currentRouteKey) return

  if (previousRouteKey !== currentRouteKey) {  // key comparison, not name
    routeNameRef.current = currentRouteName
    routeKeyRef.current = currentRouteKey
    navOtel.onRouteChange(currentRouteName, previousRouteName, currentRouteKey, previousRouteKey, params)
  }
}}
```

---

### Network / Axios Instrumentation

Creates child spans for every HTTP request, parented to the current screen span.

```typescript
import { createAxiosInstrumentation } from '@react-native-otel'

const axiosOtel = createAxiosInstrumentation(tracer, {
  sensitiveKeys: otel.getSensitiveKeys()  // from OtelConfig.sensitiveKeys
})

// Wire into Axios instance
apiClient.interceptors.request.use(
  config => axiosOtel.onRequest(config as OtelAxiosRequestConfig),
  error => Promise.reject(error)
)
apiClient.interceptors.response.use(
  response => axiosOtel.onResponse(response as OtelAxiosResponse),
  error => axiosOtel.onError(error)
)
```

**Concurrent safety:** Each request generates a unique `otelId` (via `generateSpanId()`) assigned to `config.__otelId`. Parent context (`traceId` + `spanId`) is captured by value at request start — parallel requests don't corrupt each other.

**Span attributes:**

| Attribute | Value |
|---|---|
| `http.request.method` | `'GET'`, `'POST'`, etc. (OTel stable) |
| `http.url` | Request URL |
| `http.request.headers` | JSON-stringified headers (after redaction) |
| `http.request.params` | JSON-stringified query params (after redaction) |
| `http.request.body` | JSON-stringified request body (after redaction; skips Blobs/FormData) |
| `http.response.status_code` | HTTP status code (OTel stable) |
| `http.response.headers` | JSON-stringified response headers (after redaction) |
| `http.response.body` | JSON-stringified response body (after redaction) |

**Span name format:** `http.{METHOD} {url}` (e.g. `http.POST /api/v1/receipts`)

**Redaction:** `sensitiveKeys` leaf sets are pre-computed once at factory call time (not per-request). Values are replaced with `'[REDACTED]'`. Key matching is case-insensitive.

**Body normalization:** Bodies are parsed from object or JSON-string form. Blobs, FormData, arrays, and other non-object types are skipped entirely.

**Axios type note:** Axios's own type system doesn't include `__otelId`. Cast at interceptor boundaries:
```typescript
config => axiosOtel.onRequest(config as unknown as OtelAxiosRequestConfig)
response => axiosOtel.onResponse(response as unknown as OtelAxiosResponse)
```

---

### Error Handling

```typescript
import { installErrorInstrumentation, StorageAdapter } from '@react-native-otel'

installErrorInstrumentation({
  tracer: otel.getTracer(),
  storage: mmkvAdapter,      // optional — enables crash span persistence
  exporter: spanExporter     // optional — needed to re-export pending crash spans
})
```

**What it does:**
1. Reads any pending crash span from `storage` (written in the previous session), re-exports it, then deletes it
2. Wraps `ErrorUtils.setGlobalHandler` to catch uncaught JS errors
3. Creates an ERROR span for every uncaught error with exception attributes
4. For **fatal** errors: synchronously writes the span to `storage` so it survives the process death

**Span name format:** `crash.{error.name}` (e.g. `crash.TypeError`)

**Span attributes:**

| Attribute | Value |
|---|---|
| `exception.type` | `error.name` |
| `exception.message` | `error.message` |
| `exception.stacktrace` | `error.stack` |
| `crash.is_fatal` | `true \| false` (custom) |

#### StorageAdapter Interface

```typescript
interface StorageAdapter {
  setSync(key: string, value: string): void
  getSync(key: string): string | null
  deleteSync(key: string): void
}
```

react-native-otel has **no direct dependency on MMKV**. The app wraps its own MMKV instance:

```typescript
import { MMKV } from 'react-native-mmkv'
const mmkv = new MMKV({ id: 'otel-storage' })

const mmkvAdapter: StorageAdapter = {
  setSync: (key, value) => mmkv.set(key, value),
  getSync: (key) => mmkv.getString(key) ?? null,
  deleteSync: (key) => mmkv.delete(key)
}
```

**Crash key:** `'@react-native-otel/pending-crash'`

**Coverage:** JS exceptions and fatal JS crashes only. Native crashes (SIGSEGV, OOM, jetsam) kill the JS runtime — no JS can run. Use Sentry's native module for native crash coverage.

---

### App Lifecycle

```typescript
import { installLifecycleInstrumentation } from '@react-native-otel'

// Called automatically by otel.init() — no manual wiring needed
installLifecycleInstrumentation(meter)
```

Listens to `AppState.addEventListener('change')`:
- Adds a `app.lifecycle.{state}` event to the current screen span on every state change
- Calls `meter.flush()` when state becomes `'background'`

**Event attributes:**

| Attribute | Value |
|---|---|
| `app.state` | `'active'`, `'background'`, `'inactive'`, `'unknown'`, `'extension'` |

---

## React Integration

### OtelProvider

Provides the SDK to the React tree via context. Must be placed after `otel.init()` (i.e., in a component that renders after App.tsx module scope runs).

```typescript
import { OtelProvider } from '@react-native-otel'

<OtelProvider withErrorBoundary={true}>
  <App />
</OtelProvider>
```

`withErrorBoundary={true}` wraps children in an `OtelErrorBoundary` that calls `tracer.recordException()` on React render errors.

```typescript
interface OtelProviderProps {
  children: ReactNode
  withErrorBoundary?: boolean  // default: false
}
```

### useOtel

```typescript
import { useOtel } from '@react-native-otel'

const { tracer, meter, logger, recordEvent, setUser } = useOtel()

// Record a named event on the current screen span
recordEvent('button_tapped', { button_name: 'submit' })

// Update user identity
setUser({ id: 'user_123', email: 'user@example.com' })
```

```typescript
interface OtelContextValue {
  tracer: Tracer
  meter: Meter
  logger: OtelLogger
  recordEvent: (name: string, attributes?: Record<string, unknown>) => void
  setUser: (user: { id?: string; email?: string }) => void
}
```

---

## OTel Attribute Names

All attribute names come from `@opentelemetry/semantic-conventions` (stable and incubating).

### Stable (`@opentelemetry/semantic-conventions`)

| Constant | Value | Used in |
|---|---|---|
| `ATTR_SERVICE_NAME` | `'service.name'` | Resource |
| `ATTR_SERVICE_VERSION` | `'service.version'` | Resource |
| `ATTR_HTTP_REQUEST_METHOD` | `'http.request.method'` | Network spans |
| `ATTR_HTTP_RESPONSE_STATUS_CODE` | `'http.response.status_code'` | Network spans |
| `ATTR_EXCEPTION_TYPE` | `'exception.type'` | Error spans, crash spans |
| `ATTR_EXCEPTION_MESSAGE` | `'exception.message'` | Error spans, crash spans |
| `ATTR_EXCEPTION_STACKTRACE` | `'exception.stacktrace'` | Error spans, crash spans |

### Incubating (`@opentelemetry/semantic-conventions/incubating`)

| Constant | Value | Used in |
|---|---|---|
| `ATTR_OS_NAME` | `'os.name'` | Resource |
| `ATTR_OS_VERSION` | `'os.version'` | Resource |
| `ATTR_DEVICE_MANUFACTURER` | `'device.manufacturer'` | Resource |
| `ATTR_DEVICE_MODEL_NAME` | `'device.model.name'` | Resource |
| `ATTR_APP_BUILD_ID` | `'app.build_id'` | Resource |
| `ATTR_DEPLOYMENT_ENVIRONMENT_NAME` | `'deployment.environment.name'` | Resource |
| `ATTR_APP_SCREEN_NAME` | `'app.screen.name'` | Navigation spans |

### Custom (no OTel equivalent)

| Attribute | Value | Used in |
|---|---|---|
| `'device.type'` | DeviceType value | Resource |
| `'app.screen.previous_name'` | Previous screen name | Navigation spans |
| `'app.screen.params'` | `JSON.stringify(params)` | Navigation spans |
| `'http.url'` | Request URL | Network spans |
| `'http.request.headers'` | JSON-stringified headers | Network spans |
| `'http.request.params'` | JSON-stringified query params | Network spans |
| `'http.request.body'` | JSON-stringified request body | Network spans |
| `'http.response.headers'` | JSON-stringified response headers | Network spans |
| `'http.response.body'` | JSON-stringified response body | Network spans |
| `'crash.is_fatal'` | `true \| false` | Crash spans |
| `'error.source'` | `'react_error_boundary'` | OtelErrorBoundary |
| `'app.state'` | AppState value | Lifecycle events |
| `'user.id'` | User ID string | All spans (via setUser) |
| `'user.email'` | User email string | All spans (via setUser) |

---

## App Wiring Guide

### 1. App.tsx — SDK initialization

```typescript
// At module scope (before the component definition)
import { OtlpHttpExporter, OtlpHttpMetricExporter, OtlpHttpLogExporter, otel } from '@react-native-otel'
import * as Application from 'expo-application'
import * as Device from 'expo-device'

otel.init({
  serviceName: 'expenseai-mobile',
  serviceVersion: Application.nativeApplicationVersion ?? '0.0.0',
  osName: Device.osName ?? '',
  osVersion: Device.osVersion ?? '',
  deviceBrand: Device.brand ?? '',
  deviceModel: Device.modelName ?? '',
  deviceType: Device.deviceType ?? '',
  appBuild: Application.nativeBuildVersion ?? '',
  environment: process.env.EXPO_PUBLIC_ENV ?? 'production',
  exporter: new OtlpHttpExporter({
    endpoint: 'https://in-otel.hyperdx.io',
    headers: { authorization: process.env.EXPO_PUBLIC_HYPERDX_API_KEY ?? '' }
  }),
  metricExporter: new OtlpHttpMetricExporter({
    endpoint: 'https://in-otel.hyperdx.io',
    headers: { authorization: process.env.EXPO_PUBLIC_HYPERDX_API_KEY ?? '' }
  }),
  logExporter: new OtlpHttpLogExporter({
    endpoint: 'https://in-otel.hyperdx.io',
    headers: { authorization: process.env.EXPO_PUBLIC_HYPERDX_API_KEY ?? '' }
  }),
  sensitiveKeys: ['header.authorization', 'body.password'],
  storage: mmkvAdapter  // optional
})
```

### 2. Root.tsx — OtelProvider + user identity

```typescript
import { OtelProvider } from '@react-native-otel'

// Inside your root component, in the user identity effect:
useEffect(() => {
  if (user) {
    otel.setUser({ id: user.id, email: user.email })
  }
}, [user])

return (
  <OtelProvider withErrorBoundary>
    <NavigationContainer />
  </OtelProvider>
)
```

### 3. NavigationContainer.tsx — screen tracking

```typescript
import { createNavigationInstrumentation, otel } from '@react-native-otel'
import { useMemo, useRef } from 'react'

const navOtel = useMemo(() => createNavigationInstrumentation(otel.getTracer()), [])
const routeNameRef = useRef<Routes>(null)
const routeKeyRef = useRef<string | null>(null)

<NavContainer
  onReady={() => {
    const route = navigationRef.current?.getCurrentRoute()
    routeNameRef.current = route?.name as Routes
    routeKeyRef.current = route?.key ?? null
  }}
  onStateChange={async () => {
    const previousRouteName = routeNameRef.current
    const previousRouteKey = routeKeyRef.current
    const currentRoute = navigationRef?.getCurrentRoute()
    const currentRouteName = currentRoute?.name as Routes
    const currentRouteKey = currentRoute?.key

    if (!currentRoute || !currentRouteKey) return

    if (previousRouteKey !== currentRouteKey) {
      routeNameRef.current = currentRouteName
      routeKeyRef.current = currentRouteKey

      navOtel.onRouteChange(
        currentRouteName,
        previousRouteName ?? undefined,
        currentRouteKey,
        previousRouteKey ?? undefined,
        currentRoute?.params as Record<string, unknown> | undefined
      )
    }
  }}>
```

### 4. apiClient.ts — network tracking

```typescript
import { createAxiosInstrumentation, otel, OtelAxiosRequestConfig, OtelAxiosResponse } from '@react-native-otel'

const axiosOtel = createAxiosInstrumentation(otel.getTracer(), {
  sensitiveKeys: otel.getSensitiveKeys()
})

// Add after any existing interceptors (Firebase perf, etc.)
apiClient.interceptors.request.use(
  config => axiosOtel.onRequest(config as unknown as OtelAxiosRequestConfig) as AxiosRequestConfig,
  error => Promise.reject(error)
)

apiClient.interceptors.response.use(
  response => axiosOtel.onResponse(response as unknown as OtelAxiosResponse) as AxiosResponse,
  error => axiosOtel.onError(error)
)
```

### 5. analytics.ts — event tracking

```typescript
import { otel } from '@react-native-otel'

export const trackEvent = (eventName: string, props?: any) => {
  otel.recordEvent(eventName, props)  // attaches event to current screen span

  if (process.env.NODE_ENV === 'development') return
  track(eventName, props)  // Amplitude
}
```

`otel.recordEvent()` is safe to call before `init()` — it's a no-op if the tracer is not yet initialized.

### 6. Environment Variables

Add to `.env` and `.env.example`:
```
EXPO_PUBLIC_HYPERDX_API_KEY=YOUR_HYPERDX_API_KEY
```

---

## Design Decisions & Rationale

### No async in exporter interface

`SpanExporter.export()` returns `void`, not `Promise<void>`. Exporters buffer and flush; the SDK never awaits. This keeps the span `end()` call synchronous and predictable, and avoids unhandled rejection risk in crash paths where async code may not execute correctly.

### Concurrent network spans (no spanContext push/pop)

Network spans don't use `spanContext`. Each request captures `{ traceId, spanId }` from `spanContext.current()` by value at the moment `onRequest` is called. Parallel requests each get their own `otelId` key in `activeNetworkSpans`. This makes concurrent requests safe without locks or async context propagation.

### Modal/tab navigation via route key

Screen spans are stored in `Map<string, Span>` keyed by React Navigation route `key`. A route key is unique per navigation instance (generated by React Navigation, not reused). This handles:
- Two tabs with the same screen name
- Modal overlaid on a tab — both spans exist simultaneously
- Deep navigation stacks — each level has its own key

### User identity on spans, not resource

`otel.setUser()` writes to `userAttributes` on the SDK instance. These are merged into every new span at creation time. Resource is device/app metadata that doesn't change — it would be incorrect to put user identity there.

### No native crash coverage (explicit non-goal)

`ErrorUtils.setGlobalHandler` catches uncaught JS exceptions only. Native crashes (SIGSEGV, OOM, jetsam) kill the JS thread — no JS runs at crash time. Sentry handles native crash coverage via a C-level signal handler. react-native-otel and Sentry run in parallel: react-native-otel for JS observability and Amplitude replacement, Sentry for native crash reporting.

### Sampling via NoopSpan

`sampleRate` is checked in `Tracer.startSpan()`. Sampled-out spans return a `NoopSpan` that implements the full interface with empty methods. Callers never need to null-check, branches, or guards.

### IDs via Math.random, not crypto

React Native / Hermes does not expose `crypto.getRandomValues()` in all environments. `Math.random()` is fast and produces statistically unique IDs for observability purposes (not a security primitive).

### Timestamp precision: milliseconds

`Date.now()` gives millisecond precision. Hermes/RN has no high-resolution timer. Timestamps are converted to nanoseconds as strings (`ms * 1_000_000`) for OTLP compatibility. Precision loss is negligible for observability use cases.

---

## Known Limitations

| Limitation | Details |
|---|---|
| No unhandled Promise rejection tracking | `rejection-tracking` not yet wired in `errors.ts`. Only `ErrorUtils.setGlobalHandler` is installed. |
| No native crash coverage | By design — see rationale above. Use Sentry in parallel. |
| No distributed tracing | No W3C `traceparent` header injection/extraction for cross-service tracing. |
| Histogram is a raw gauge | No bucket data — `histogram` records are exported as OTLP `gauge` data points. Use a real histogram at the collector layer if needed. |
| Metrics not persisted across sessions | If the app is force-killed before `AppState → background`, buffered metrics are lost. |
| No OpenTelemetry Collector protocol support (gRPC) | OTLP/HTTP JSON only. No gRPC / protobuf. |
| `maxAttributeStringLength` is global | Setting it in one `otel.init()` affects all subsequent attribute writes across the entire process. |

---

## Bugs Fixed / Gotchas

### `[object Object]` in span event attributes

**Root cause:** `sanitizeValue()` had no branch for plain objects. They fell through to `return value` unchanged. When written to OTLP, `toOtlpValue()` called `String(value)` → `'[object Object]'`.

**Fix:** Added `typeof value === 'object'` branch in `sanitizeValue()` that calls `JSON.stringify(value)` and truncates the result.

### Root span `parentSpanId: ''` breaks HyperDX trace assembly

**Root cause:** Root spans were serialized with `parentSpanId: ''`. The OTLP spec requires the field to be **omitted** for root spans — an empty string is treated as a malformed field by some collectors.

**Fix:** `...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {})` in `toOtlpSpan()`.

### `status.message: ''` breaks some OTLP parsers

**Fix:** `...(span.statusMessage ? { message: span.statusMessage } : {})` — message is omitted when empty.

### Inconsistent tab/screen change tracking

**Root cause:** `NavigationContainer.onStateChange` compared `previousRouteName !== currentRouteName`. Tab changes where the nested navigator fires two `onStateChange` events with the same route name but different keys were being missed.

**Fix:** Compare `previousRouteKey !== currentRouteKey`. Also guard against `!currentRoute || !currentRouteKey`.

### Network spans becoming orphan traces

**Root cause:** Network instrumentation was capturing `parentSpanId` only (not `traceId`). Child spans started a new `traceId` instead of inheriting the screen's trace.

**Fix:** `parent` is now a `SpanContext { traceId, spanId }` — both IDs captured together at request start. Child spans inherit `traceId` from the parent context.

### OTLP log `traceId`/`spanId` as empty strings

**Fix:** Both fields are omitted when absent: `...(log.traceId ? { traceId: log.traceId } : {})`.

### IDE injecting `console.error` into exporter fetch calls

Some IDE integrations auto-complete `.catch(console.error)` in fetch chains. All three OTLP exporters use `.catch(() => {})` — errors are intentionally suppressed (fire-and-forget).
