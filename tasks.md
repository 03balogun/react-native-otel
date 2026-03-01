# react-native-otel Improvement Tasks

## Status Legend
- [ ] Pending
- [x] Done
- [~] Future / out-of-scope

---

## Group 1 – Quick wins

- [x] 1. `src/version.ts` – SDK_VERSION constant from package.json
- [x] 2. `OtlpHttpMetricExporter` flush timer – `flushIntervalMs` + setInterval/destroy
- [x] 3. Jitter in `fetchWithRetry` – `delay * (0.5 + Math.random() * 0.5)`
- [x] 4. Custom resource attributes – `resourceAttributes?: Attributes` in OtelConfig

## Group 2 – New modules

- [x] 5. Multi-exporter – `MultiSpanExporter`, `MultiMetricExporter`, `MultiLogExporter`
- [x] 6. Sampler interface + built-ins (AlwaysOn, AlwaysOff, TraceIdRatio)
- [x] 7. Span links – `links?: SpanLink[]` on Span/ReadonlySpan; serialize in OTLP
- [x] 8. WAL for logs – `setStorage()` on `OtlpHttpLogExporter`
- [x] 9. Auto resource detection – `Platform.OS` / `Platform.Version` defaults in sdk.ts

## Group 3 – New instrumentation

- [x] 10. Fetch instrumentation – `createFetchInstrumentation(tracer, options?)`
- [x] 11. App startup – `installStartupInstrumentation(tracer)`
- [x] 12. Attribute sanitization caching – memoize in Counter/Gauge
- [x] 13. App lifecycle metrics – foreground/background counters in lifecycle.ts
- [x] 14. W3C Baggage + tracestate – inject `baggage` header; forward `tracestate`

## Group 4 – Architecture

- [x] 15. Span processor pipeline – `SpanProcessor` interface; Tracer accepts processors
- [x] 16. Circuit breaker in `fetchWithRetry` – 5 consecutive failures → 60s backoff
- [x] 17. Connectivity-aware flushing – `NetworkAdapter` interface in SDK

## Group 5 – Platform adapters

- [x] 18. Expo Router – `createExpoRouterInstrumentation(tracer)` using `usePathname`
- [x] 19. Deep links & push notifications – `createLinkingInstrumentation(tracer)`

## Group 6 – Tests

- [x] 20. Snapshot tests – `toMatchSnapshot()` on `buildBody()` results
- [x] 21. Integration test – mock HTTP OTLP server verify payload structure
- [~] 22. OTLP protobuf – **Future**: requires protobufjs (~30 KB), significant scope

---

## Notes

- OTLP protobuf marked as future: would add ~30 KB to bundle, needs `protobufjs` dep.
  Track in a separate issue when there is clear user demand.
