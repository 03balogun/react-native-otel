let maxStringLength = 1024;

export function setMaxStringLength(length: number): void {
  maxStringLength = length;
}

export type AttributeValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | boolean[];
export type Attributes = Record<string, AttributeValue>;

// Sanitize a single value. Returns undefined for null/undefined inputs so the
// caller can skip writing the key entirely — no object allocation needed.
// Accepts `unknown` so loose props (e.g. from analytics trackEvent) are safe.
export function sanitizeValue(value: unknown): AttributeValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    return value.length > maxStringLength
      ? value.slice(0, maxStringLength)
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return (value as unknown[]).map((v) =>
      typeof v === 'string' && v.length > maxStringLength
        ? v.slice(0, maxStringLength)
        : v
    ) as AttributeValue;
  }
  // Plain objects → JSON string so they don't become '[object Object]'
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      return json.length > maxStringLength
        ? json.slice(0, maxStringLength)
        : json;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// Bulk sanitize used once in the Span constructor and addEvent.
// Accepts Record<string, unknown> so callers don't need to pre-cast.
export function sanitizeAttributes(
  attrs: Attributes | Record<string, unknown>
): Attributes {
  const result: Attributes = {};
  for (const key of Object.keys(attrs)) {
    const sanitized = sanitizeValue(attrs[key]);
    if (sanitized !== undefined) {
      result[key] = sanitized;
    }
  }
  return result;
}
