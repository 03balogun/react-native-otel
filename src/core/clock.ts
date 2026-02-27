// Returns current time in milliseconds.
// Nanosecond precision is unavailable in RN/Hermes.
export function now(): number {
  return Date.now()
}
