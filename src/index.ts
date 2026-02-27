// SDK
export { otel } from './sdk';
export type { OtelConfig } from './sdk';

// Core
export { Span, NoopSpan } from './core/span';
export type {
  SpanKind,
  SpanStatus,
  SpanEvent,
  ReadonlySpan,
} from './core/span';
export { Tracer } from './core/tracer';
export { Meter, Counter, Histogram, Gauge } from './core/meter';
export type { HistogramOptions } from './core/meter';
export { OtelLogger } from './core/log-record';
export type { LogSeverity } from './core/log-record';
export type { Attributes, AttributeValue } from './core/attributes';
export type { Resource } from './core/resource';

// Context
export { spanContext } from './context/span-context';
export type { SpanContextManagerPublic } from './context/span-context';

// Exporters
export type {
  SpanExporter,
  MetricExporter,
  LogExporter,
  MetricRecord,
  LogRecord,
} from './exporters/types';
export {
  ConsoleSpanExporter,
  ConsoleMetricExporter,
  ConsoleLogExporter,
} from './exporters/console-exporter';
export {
  OtlpHttpExporter,
  OtlpHttpMetricExporter,
  OtlpHttpLogExporter,
} from './exporters/otlp-http-exporter';
export type {
  OtlpHttpExporterOptions,
  OtlpHttpMetricExporterOptions,
  OtlpHttpLogExporterOptions,
} from './exporters/otlp-http-exporter';

// Instrumentation
export { createNavigationInstrumentation } from './instrumentation/navigation';
export type { NavigationInstrumentation } from './instrumentation/navigation';
export { createAxiosInstrumentation } from './instrumentation/network';
export type {
  AxiosInstrumentation,
  AxiosInstrumentationOptions,
  AxiosRequestConfig as OtelAxiosRequestConfig,
  AxiosResponse as OtelAxiosResponse,
} from './instrumentation/network';
export { installErrorInstrumentation } from './instrumentation/errors';
export type { StorageAdapter } from './instrumentation/errors';

// React
export { OtelProvider, OtelContext } from './react/OtelProvider';
export type { OtelContextValue, OtelProviderProps } from './react/OtelProvider';
export { useOtel } from './react/useOtel';
