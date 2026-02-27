import { Tracer } from '../core/tracer';
import { NoopSpan, Span } from '../core/span';
import { spanContext } from '../context/span-context';

function makeTracer(sampleRate = 1.0): Tracer {
  return new Tracer({ getUserAttributes: () => ({}), sampleRate });
}

beforeEach(() => {
  spanContext.setCurrent(undefined);
});

describe('Tracer.startSpan()', () => {
  it('returns a Span when sampling passes', () => {
    const tracer = makeTracer(1.0);
    const span = tracer.startSpan('test');
    expect(span).toBeInstanceOf(Span);
  });

  it('returns a NoopSpan when sampled out (sampleRate=0)', () => {
    const tracer = makeTracer(0.0);
    const span = tracer.startSpan('test');
    expect(span).toBeInstanceOf(NoopSpan);
  });

  it('creates a root span (no parent, no screen span) with a fresh traceId', () => {
    const tracer = makeTracer();
    const span = tracer.startSpan('root') as Span;
    expect(span.parentSpanId).toBeUndefined();
    expect(span.traceId).toHaveLength(32);
  });

  it('uses the current screen span as parent when no explicit parent is given', () => {
    const tracer = makeTracer();
    const screen = tracer.startSpan('screen') as Span;
    spanContext.setCurrent(screen);

    const child = tracer.startSpan('child') as Span;
    expect(child.traceId).toBe(screen.traceId);
    expect(child.parentSpanId).toBe(screen.spanId);
  });

  it('uses explicit parent over the current screen span', () => {
    const tracer = makeTracer();
    const screen = tracer.startSpan('screen') as Span;
    spanContext.setCurrent(screen);

    const explicitParent = tracer.startSpan('explicit') as Span;
    const child = tracer.startSpan('child', {
      parent: {
        traceId: explicitParent.traceId,
        spanId: explicitParent.spanId,
      },
    }) as Span;

    expect(child.traceId).toBe(explicitParent.traceId);
    expect(child.parentSpanId).toBe(explicitParent.spanId);
  });

  it('creates a root span when parent is explicitly null (even with active screen span)', () => {
    const tracer = makeTracer();
    const screen = tracer.startSpan('screen') as Span;
    spanContext.setCurrent(screen);

    const root = tracer.startSpan('root', { parent: null }) as Span;
    expect(root.parentSpanId).toBeUndefined();
    expect(root.traceId).not.toBe(screen.traceId);
  });

  it('merges user attributes with span attributes', () => {
    const tracer = new Tracer({
      getUserAttributes: () => ({ 'user.id': 'u1' }),
    });
    const span = tracer.startSpan('test', {
      attributes: { key: 'val' },
    }) as Span;
    expect(span.attributes).toMatchObject({ 'user.id': 'u1', 'key': 'val' });
  });

  it('span attributes override user attributes on key collision', () => {
    const tracer = new Tracer({
      getUserAttributes: () => ({ 'user.id': 'old' }),
    });
    const span = tracer.startSpan('test', {
      attributes: { 'user.id': 'new' },
    }) as Span;
    expect(span.attributes['user.id']).toBe('new');
  });
});
