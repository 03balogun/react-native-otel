import { spanContext, spanContextInternal } from '../context/span-context';
import { Span, NoopSpan } from '../core/span';
import { Tracer } from '../core/tracer';

function makeSpan(name = 'test'): Span {
  return new Span({ name });
}

function makeTracer(): Tracer {
  return new Tracer({ getUserAttributes: () => ({}) });
}

beforeEach(() => {
  spanContext.setCurrent(undefined);
});

// ─── SpanContextManager ───────────────────────────────────────────────────────

describe('SpanContextManager.setCurrent / current', () => {
  it('returns undefined by default', () => {
    expect(spanContext.current()).toBeUndefined();
  });

  it('returns the screen span after setCurrent', () => {
    const span = makeSpan('screen');
    spanContext.setCurrent(span);
    expect(spanContext.current()).toBe(span);
  });

  it('setCurrent(undefined) clears the context', () => {
    spanContext.setCurrent(makeSpan());
    spanContext.setCurrent(undefined);
    expect(spanContext.current()).toBeUndefined();
  });
});

describe('SpanContextManager push/pop (internal)', () => {
  it('push makes a span the active context above the screen span', () => {
    const screen = makeSpan('screen');
    const manual = makeSpan('manual');
    spanContext.setCurrent(screen);
    const token = spanContextInternal.push(manual);
    expect(spanContext.current()).toBe(manual);
    spanContextInternal.pop(token);
    expect(spanContext.current()).toBe(screen);
  });

  it('pop restores the previous span', () => {
    const screen = makeSpan('screen');
    spanContext.setCurrent(screen);
    const token = spanContextInternal.push(makeSpan('inner'));
    spanContextInternal.pop(token);
    expect(spanContext.current()).toBe(screen);
  });

  it('pop is identity-based — removes only the entry matching the token', () => {
    const a = makeSpan('a');
    const b = makeSpan('b');
    const tokenA = spanContextInternal.push(a);
    const tokenB = spanContextInternal.push(b);
    // Pop a out of order (simulating async interleaving)
    spanContextInternal.pop(tokenA);
    // b is still the active context
    expect(spanContext.current()).toBe(b);
    spanContextInternal.pop(tokenB);
    expect(spanContext.current()).toBeUndefined();
  });

  it('stale manual spans are cleared by setCurrent', () => {
    const token = spanContextInternal.push(makeSpan('stale'));
    spanContext.setCurrent(makeSpan('new-screen'));
    expect(spanContextInternal).toBeDefined(); // push existed
    // Manual stack was cleared — popping the stale token is a no-op
    spanContextInternal.pop(token);
    expect(spanContext.current()).toBeInstanceOf(Span);
  });
});

// ─── Tracer.startActiveSpan ───────────────────────────────────────────────────

describe('Tracer.startActiveSpan', () => {
  it('makes the new span active inside the callback', () => {
    const tracer = makeTracer();
    let activeInsideFn: unknown;
    tracer.startActiveSpan('op', (span) => {
      activeInsideFn = spanContext.current();
      return span;
    });
    expect(activeInsideFn).toBeDefined();
  });

  it('span is no longer active after the callback returns', () => {
    const tracer = makeTracer();
    const result = tracer.startActiveSpan('op', (span) => span);
    expect(spanContext.current()).toBeUndefined();
    expect(result.endTimeMs).toBeDefined(); // auto-ended
  });

  it('auto-ends the span on synchronous completion', () => {
    const tracer = makeTracer();
    const span = tracer.startActiveSpan('op', (s) => s);
    expect(span.endTimeMs).toBeDefined();
  });

  it('auto-ends the span on synchronous throw', () => {
    const tracer = makeTracer();
    let captured: Span | NoopSpan | undefined;
    expect(() => {
      tracer.startActiveSpan('op', (s) => {
        captured = s;
        throw new Error('boom');
      });
    }).toThrow('boom');
    expect(captured?.endTimeMs).toBeDefined();
    expect(spanContext.current()).toBeUndefined();
  });

  it('sets status to ERROR on synchronous throw', () => {
    const tracer = makeTracer();
    let captured: Span | NoopSpan | undefined;
    expect(() => {
      tracer.startActiveSpan('op', (s) => {
        captured = s;
        throw new Error('fail');
      });
    }).toThrow();
    expect((captured as Span).status).toBe('ERROR');
  });

  it('auto-ends the span after the returned Promise resolves', async () => {
    const tracer = makeTracer();
    let captured: Span | NoopSpan | undefined;
    await tracer.startActiveSpan('op', async (s) => {
      captured = s;
      await Promise.resolve();
    });
    expect(captured?.endTimeMs).toBeDefined();
    expect(spanContext.current()).toBeUndefined();
  });

  it('auto-ends the span after the returned Promise rejects', async () => {
    const tracer = makeTracer();
    let captured: Span | NoopSpan | undefined;
    await expect(
      tracer.startActiveSpan('op', async (s) => {
        captured = s;
        throw new Error('async fail');
      })
    ).rejects.toThrow('async fail');
    expect(captured?.endTimeMs).toBeDefined();
  });

  it('supports nested startActiveSpan — inner span parents to outer', () => {
    const tracer = makeTracer();
    let outerSpan: Span | NoopSpan | undefined;
    let innerSpan: Span | NoopSpan | undefined;

    tracer.startActiveSpan('outer', (outer) => {
      outerSpan = outer;
      tracer.startActiveSpan('inner', (inner) => {
        innerSpan = inner;
      });
    });

    expect((innerSpan as Span).parentSpanId).toBe((outerSpan as Span).spanId);
    expect((innerSpan as Span).traceId).toBe((outerSpan as Span).traceId);
  });

  it('accepts options as the second argument', () => {
    const tracer = makeTracer();
    const span = tracer.startActiveSpan('op', { kind: 'CLIENT' }, (s) => s);
    expect((span as Span).kind).toBe('CLIENT');
  });

  it('startSpan inside startActiveSpan auto-parents to the active span', () => {
    const tracer = makeTracer();
    let parentSpan: Span | NoopSpan | undefined;
    let childSpan: Span | NoopSpan | undefined;

    tracer.startActiveSpan('parent', (p) => {
      parentSpan = p;
      // startSpan (not startActiveSpan) should read the active context and parent to p
      childSpan = tracer.startSpan('child');
      childSpan.end();
      return p;
    });

    expect((childSpan as Span).parentSpanId).toBe((parentSpan as Span).spanId);
    expect((childSpan as Span).traceId).toBe((parentSpan as Span).traceId);
  });
});

// ─── Tracer.withSpan ──────────────────────────────────────────────────────────

describe('Tracer.withSpan', () => {
  it('makes an existing span active for the duration of the callback', () => {
    const tracer = makeTracer();
    const span = makeSpan('existing');
    let activeInsideFn: unknown;
    tracer.withSpan(span, () => {
      activeInsideFn = spanContext.current();
    });
    expect(activeInsideFn).toBe(span);
  });

  it('does NOT end the span — caller owns the lifetime', () => {
    const tracer = makeTracer();
    const span = makeSpan();
    tracer.withSpan(span, () => {});
    expect(span.endTimeMs).toBeUndefined();
  });

  it('restores prior context after the callback', () => {
    const tracer = makeTracer();
    const screen = makeSpan('screen');
    spanContext.setCurrent(screen);
    tracer.withSpan(makeSpan('inner'), () => {});
    expect(spanContext.current()).toBe(screen);
  });

  it('restores context even if the callback throws', () => {
    const tracer = makeTracer();
    const screen = makeSpan('screen');
    spanContext.setCurrent(screen);
    expect(() => {
      tracer.withSpan(makeSpan('inner'), () => {
        throw new Error('x');
      });
    }).toThrow('x');
    expect(spanContext.current()).toBe(screen);
  });

  it('supports async callbacks and restores context after promise settles', async () => {
    const tracer = makeTracer();
    const screen = makeSpan('screen');
    spanContext.setCurrent(screen);
    await tracer.withSpan(makeSpan('inner'), async () => {
      await Promise.resolve();
    });
    expect(spanContext.current()).toBe(screen);
  });

  it('token-based pop does not corrupt context when spans overlap (async)', async () => {
    const tracer = makeTracer();
    const spanA = makeSpan('a');
    const spanB = makeSpan('b');

    // Start both overlapping async operations
    const opA = tracer.withSpan(
      spanA,
      () => new Promise<void>((resolve) => setTimeout(resolve, 10))
    );
    const opB = tracer.withSpan(
      spanB,
      () => new Promise<void>((resolve) => setTimeout(resolve, 5))
    );

    // B finishes first — should not corrupt A's token
    await opB;
    await opA;

    // After both settle, context should be clear
    expect(spanContext.current()).toBeUndefined();
  });
});

// ─── W3C traceparent in network instrumentation ───────────────────────────────
// (Covered in network.test.ts)
