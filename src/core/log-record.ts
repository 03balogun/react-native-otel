import { Attributes, sanitizeAttributes } from './attributes'
import { now } from './clock'
import { spanContext } from '../context/span-context'
import { LogExporter, LogRecord } from '../exporters/types'

export type LogSeverity =
  | 'TRACE'
  | 'DEBUG'
  | 'INFO'
  | 'WARN'
  | 'ERROR'
  | 'FATAL'

export class OtelLogger {
  private exporter: LogExporter | undefined

  constructor(exporter?: LogExporter) {
    this.exporter = exporter
  }

  private emit(severity: LogSeverity, body: string, attrs?: Attributes): void {
    const current = spanContext.current()
    const record: LogRecord = {
      timestampMs: now(),
      severity,
      body,
      traceId: current?.traceId,
      spanId: current?.spanId,
      attributes: attrs ? sanitizeAttributes(attrs) : {}
    }
    this.exporter?.export([record])
  }

  trace(body: string, attrs?: Attributes): void {
    this.emit('TRACE', body, attrs)
  }

  debug(body: string, attrs?: Attributes): void {
    this.emit('DEBUG', body, attrs)
  }

  info(body: string, attrs?: Attributes): void {
    this.emit('INFO', body, attrs)
  }

  warn(body: string, attrs?: Attributes): void {
    this.emit('WARN', body, attrs)
  }

  error(body: string, attrs?: Attributes): void {
    this.emit('ERROR', body, attrs)
  }

  fatal(body: string, attrs?: Attributes): void {
    this.emit('FATAL', body, attrs)
  }
}
