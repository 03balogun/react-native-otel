import type { StorageAdapter } from '../instrumentation/errors';

const MAX_BATCHES = 3;
const MAX_ITEMS_PER_BATCH = 500;

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

// Retry a fetch up to maxRetries times with exponential backoff.
// Returns true on success, false if all retries are exhausted.
// 4xx responses are not retried (they indicate a client-side problem).
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3,
  baseDelayMs = 500
): Promise<boolean> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        return true;
      }
      // 5xx — fall through to retry
    } catch {
      // Network error — fall through to retry
    }
    if (attempt < maxRetries - 1) {
      await new Promise<void>((r) =>
        setTimeout(r, baseDelayMs * Math.pow(2, attempt))
      );
    }
  }
  return false;
}
