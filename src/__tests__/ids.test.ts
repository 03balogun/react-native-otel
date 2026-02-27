import { generateTraceId, generateSpanId } from '../core/ids';

describe('generateTraceId', () => {
  it('returns 32 hex characters (128 bits)', () => {
    const id = generateTraceId();
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('returns unique values across many calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, generateTraceId));
    expect(ids.size).toBe(1000);
  });
});

describe('generateSpanId', () => {
  it('returns 16 hex characters (64 bits)', () => {
    const id = generateSpanId();
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns unique values across many calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, generateSpanId));
    expect(ids.size).toBe(1000);
  });
});
