import { Span, NoopSpan } from '../core/span';

describe('Span', () => {
  it('starts with UNSET status and no endTimeMs', () => {
    const span = new Span({ name: 'test' });
    expect(span.status).toBe('UNSET');
    expect(span.endTimeMs).toBeUndefined();
  });

  it('generates a traceId and spanId on construction', () => {
    const span = new Span({ name: 'test' });
    expect(span.traceId).toHaveLength(32);
    expect(span.spanId).toHaveLength(16);
  });

  it('inherits traceId and sets parentSpanId when given a parent', () => {
    const parent = new Span({ name: 'parent' });
    const child = new Span({
      name: 'child',
      parent: { traceId: parent.traceId, spanId: parent.spanId },
    });
    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
  });

  it('has no parentSpanId when no parent is given', () => {
    const span = new Span({ name: 'root' });
    expect(span.parentSpanId).toBeUndefined();
  });

  it('end() sets endTimeMs and marks status OK', () => {
    const span = new Span({ name: 'test' });
    span.end();
    expect(span.endTimeMs).toBeGreaterThan(0);
    expect(span.status).toBe('OK');
  });

  it('end() preserves ERROR status set before end()', () => {
    const span = new Span({ name: 'test' });
    span.setStatus('ERROR', 'boom');
    span.end();
    expect(span.status).toBe('ERROR');
    expect(span.statusMessage).toBe('boom');
  });

  it('end() is idempotent — second call is a no-op', () => {
    const exported: unknown[] = [];
    const span = new Span({
      name: 'test',
      exporter: { export: (s) => exported.push(s) },
    });
    span.end();
    span.end();
    expect(exported).toHaveLength(1);
  });

  it('addEvent() up to MAX_EVENTS (128) stores events', () => {
    const span = new Span({ name: 'test' });
    for (let i = 0; i < 128; i++) span.addEvent(`evt-${i}`);
    expect(span.events).toHaveLength(128);
    expect(span.droppedEventsCount).toBe(0);
  });

  it('addEvent() beyond MAX_EVENTS increments droppedEventsCount', () => {
    const span = new Span({ name: 'test' });
    for (let i = 0; i < 130; i++) span.addEvent(`evt-${i}`);
    expect(span.events).toHaveLength(128);
    expect(span.droppedEventsCount).toBe(2);
  });

  it('addEvent() after end() is a no-op', () => {
    const span = new Span({ name: 'test' });
    span.end();
    span.addEvent('late');
    expect(span.events).toHaveLength(0);
  });

  it('setAttribute() after end() is a no-op', () => {
    const span = new Span({ name: 'test', attributes: { a: 1 } });
    span.end();
    span.setAttribute('b', 2);
    expect(span.attributes).toEqual({ a: 1 });
  });

  it('calls exporter.export() with itself on end()', () => {
    const exported: unknown[][] = [];
    const exporter = { export: (spans: unknown[]) => exported.push(spans) };
    const span = new Span({ name: 'test', exporter });
    span.end();
    expect(exported).toHaveLength(1);
    expect(exported[0]).toContain(span);
  });
});

describe('NoopSpan', () => {
  it('all methods are no-ops', () => {
    const noop = new NoopSpan();
    expect(() => noop.addEvent('x')).not.toThrow();
    expect(() => noop.setAttribute('k', 'v')).not.toThrow();
    expect(() => noop.setStatus('ERROR')).not.toThrow();
    expect(() => noop.end()).not.toThrow();
    expect(noop.traceId).toBe('');
    expect(noop.spanId).toBe('');
    expect(noop.events).toHaveLength(0);
  });
});
