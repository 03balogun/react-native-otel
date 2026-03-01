import type { StorageAdapter } from '../instrumentation/errors';

const MAX_BATCHES = 3;
const MAX_ITEMS_PER_BATCH = 500;

// Circuit breaker: after this many consecutive delivery failures, pause for
// CIRCUIT_OPEN_MS before attempting again.
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_OPEN_MS = 60_000;

interface WalBatch<T> {
  id: string;
  timestamp: number;
  data: T[];
}

// Write-ahead log backed by StorageAdapter.
// Persists undelivered export batches so they survive force-kills.
// Stores at most maxBatches batches; oldest are dropped when the limit is exceeded.
export class Wal<T> {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly storageKey: string,
    private readonly maxBatches = MAX_BATCHES,
    private readonly maxItems = MAX_ITEMS_PER_BATCH
  ) {}

  // Persist a batch and return the id needed to delete it after delivery.
  write(items: T[]): string {
    const batches = this.readAll();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    batches.push({
      id,
      timestamp: Date.now(),
      data: items.slice(0, this.maxItems),
    });
    // Keep only the most recent batches to cap storage growth.
    const trimmed = batches.slice(-this.maxBatches);
    this.storage.setSync(this.storageKey, JSON.stringify(trimmed));
    return id;
  }

  // Remove a successfully delivered batch from the WAL.
  delete(id: string): void {
    const remaining = this.readAll().filter((b) => b.id !== id);
    if (remaining.length === 0) {
      this.storage.deleteSync(this.storageKey);
    } else {
      this.storage.setSync(this.storageKey, JSON.stringify(remaining));
    }
  }

  // Return all pending batches (for session-start replay).
  readAll(): WalBatch<T>[] {
    const raw = this.storage.getSync(this.storageKey);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as WalBatch<T>[];
    } catch {
      return [];
    }
  }
}

// Per-endpoint circuit-breaker state.
// Key: URL string. Stores consecutive failure count and open-until timestamp.
interface CircuitState {
  failures: number;
  openUntil: number;
}
const circuitMap = new Map<string, CircuitState>();

function getCircuit(url: string): CircuitState {
  let state = circuitMap.get(url);
  if (!state) {
    state = { failures: 0, openUntil: 0 };
    circuitMap.set(url, state);
  }
  return state;
}

// The fetch implementation used for all OTLP delivery.
// Overridden by the SDK before installing fetch instrumentation so that
// exporter calls always use the original fetch — preventing infinite recursion.
let fetchImpl: typeof fetch | undefined;

export function setFetchImpl(impl: typeof fetch): void {
  fetchImpl = impl;
}

// Retry a fetch up to maxRetries times with exponential backoff + jitter.
// Returns true on success, false if all retries are exhausted.
// 4xx responses are not retried (they indicate a client-side problem).
// After CIRCUIT_BREAKER_THRESHOLD consecutive failures the circuit opens for
// CIRCUIT_OPEN_MS and all attempts are skipped until it closes.
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3,
  baseDelayMs = 500
): Promise<boolean> {
  const circuit = getCircuit(url);

  // Circuit open — bail out immediately without burning retries.
  if (circuit.openUntil > Date.now()) {
    return false;
  }

  // Use the override if set (pre-patch fetch), otherwise fall back to global.
  const doFetch = fetchImpl ?? globalThis.fetch;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await doFetch(url, options);
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        // Reset circuit on success.
        circuit.failures = 0;
        circuit.openUntil = 0;
        return true;
      }
      // 5xx — fall through to retry
    } catch {
      // Network error — fall through to retry
    }
    if (attempt < maxRetries - 1) {
      // Jitter: scale by 0.5–1.0 to spread out retries under load.
      const jitter = 0.5 + Math.random() * 0.5;
      await new Promise<void>((r) =>
        setTimeout(r, baseDelayMs * Math.pow(2, attempt) * jitter)
      );
    }
  }

  // All retries exhausted — update circuit breaker.
  circuit.failures += 1;
  if (circuit.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    circuit.openUntil = Date.now() + CIRCUIT_OPEN_MS;
  }
  return false;
}

// Reset circuit breaker state for a URL (useful in tests).
export function resetCircuit(url: string): void {
  circuitMap.delete(url);
}
