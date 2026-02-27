function randomHex(length: number): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += Math.floor(Math.random() * 16).toString(16);
  }
  return result;
}

export function generateTraceId(): string {
  return randomHex(32);
}

export function generateSpanId(): string {
  return randomHex(16);
}
