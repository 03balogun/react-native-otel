function randomBytesHex(byteCount: number): string {
  try {
    const bytes = new Uint8Array(byteCount);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // Fallback if crypto.getRandomValues is unavailable
    if (__DEV__) {
      console.warn(
        '[react-native-otel] crypto.getRandomValues unavailable; falling back to Math.random for ID generation. IDs may collide at scale.'
      );
    }
    let result = '';
    for (let i = 0; i < byteCount * 2; i++) {
      result += Math.floor(Math.random() * 16).toString(16);
    }
    return result;
  }
}

// 128-bit trace ID per OTel spec (32 hex chars)
export function generateTraceId(): string {
  return randomBytesHex(16);
}

// 64-bit span ID per OTel spec (16 hex chars)
export function generateSpanId(): string {
  return randomBytesHex(8);
}
