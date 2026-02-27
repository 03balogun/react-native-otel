import {
  sanitizeValue,
  sanitizeAttributes,
  setMaxStringLength,
} from '../core/attributes';

// Reset the module-level maxStringLength between tests
afterEach(() => {
  setMaxStringLength(1024);
});

describe('sanitizeValue', () => {
  it('returns undefined for null', () => {
    expect(sanitizeValue(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(sanitizeValue(undefined)).toBeUndefined();
  });

  it('passes through strings within the limit', () => {
    expect(sanitizeValue('hello')).toBe('hello');
  });

  it('truncates strings exceeding maxStringLength', () => {
    setMaxStringLength(5);
    expect(sanitizeValue('hello world')).toBe('hello');
  });

  it('passes through numbers', () => {
    expect(sanitizeValue(42)).toBe(42);
    expect(sanitizeValue(3.14)).toBe(3.14);
  });

  it('passes through booleans', () => {
    expect(sanitizeValue(true)).toBe(true);
    expect(sanitizeValue(false)).toBe(false);
  });

  it('truncates string elements within arrays', () => {
    setMaxStringLength(3);
    expect(sanitizeValue(['abcde', 'fg'])).toEqual(['abc', 'fg']);
  });

  it('JSON.stringifies plain objects', () => {
    const result = sanitizeValue({ a: 1 });
    expect(result).toBe('{"a":1}');
  });

  it('truncates JSON-stringified objects that exceed the limit', () => {
    setMaxStringLength(5);
    expect(sanitizeValue({ a: 'long' })).toBe('{"a":');
  });

  it('returns undefined for objects that cannot be stringified', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(sanitizeValue(circular)).toBeUndefined();
  });
});

describe('sanitizeAttributes', () => {
  it('drops keys with null or undefined values', () => {
    const result = sanitizeAttributes({
      a: null as unknown as string,
      b: undefined as unknown as string,
      c: 'keep',
    });
    expect(result).toEqual({ c: 'keep' });
  });

  it('sanitizes all values in the record', () => {
    setMaxStringLength(3);
    const result = sanitizeAttributes({ x: 'abcde', y: 42 });
    expect(result).toEqual({ x: 'abc', y: 42 });
  });
});
