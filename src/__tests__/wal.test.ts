import { Wal } from '../exporters/wal';
import type { StorageAdapter } from '../instrumentation/errors';

function makeStorage(): StorageAdapter & { store: Record<string, string> } {
  const store: Record<string, string> = {};
  return {
    store,
    setSync: (key, value) => {
      store[key] = value;
    },
    getSync: (key) => store[key] ?? null,
    deleteSync: (key) => {
      delete store[key];
    },
  };
}

describe('Wal', () => {
  it('write() persists a batch and returns an id', () => {
    const storage = makeStorage();
    const wal = new Wal<number>(storage, 'test-key');

    const id = wal.write([1, 2, 3]);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(storage.store['test-key']).toBeDefined();
  });

  it('readAll() returns all persisted batches', () => {
    const storage = makeStorage();
    const wal = new Wal<number>(storage, 'test-key');

    wal.write([1, 2]);
    wal.write([3, 4]);
    const batches = wal.readAll();

    expect(batches).toHaveLength(2);
    expect(batches[0]!.data).toEqual([1, 2]);
    expect(batches[1]!.data).toEqual([3, 4]);
  });

  it('delete() removes a specific batch by id', () => {
    const storage = makeStorage();
    const wal = new Wal<number>(storage, 'test-key');

    const id1 = wal.write([1]);
    wal.write([2]);
    wal.delete(id1);

    const batches = wal.readAll();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.data).toEqual([2]);
  });

  it('delete() removes the storage key entirely when the last batch is deleted', () => {
    const storage = makeStorage();
    const wal = new Wal<number>(storage, 'test-key');

    const id = wal.write([1]);
    wal.delete(id);

    expect(storage.store['test-key']).toBeUndefined();
    expect(wal.readAll()).toHaveLength(0);
  });

  it('respects maxBatches — oldest batch is dropped when limit is exceeded', () => {
    const storage = makeStorage();
    const wal = new Wal<number>(storage, 'test-key', 2);

    wal.write([1]);
    wal.write([2]);
    wal.write([3]); // should evict [1]

    const batches = wal.readAll();
    expect(batches).toHaveLength(2);
    expect(batches[0]!.data).toEqual([2]);
    expect(batches[1]!.data).toEqual([3]);
  });

  it('respects maxItems — oversized batches are truncated', () => {
    const storage = makeStorage();
    const wal = new Wal<number>(storage, 'test-key', 3, 3);

    wal.write([1, 2, 3, 4, 5]);
    const batches = wal.readAll();
    expect(batches[0]!.data).toHaveLength(3);
    expect(batches[0]!.data).toEqual([1, 2, 3]);
  });

  it('readAll() returns empty array when nothing has been written', () => {
    const storage = makeStorage();
    const wal = new Wal<number>(storage, 'test-key');
    expect(wal.readAll()).toEqual([]);
  });

  it('readAll() returns empty array when storage contains corrupt JSON', () => {
    const storage = makeStorage();
    storage.store['test-key'] = 'not valid json {{{';
    const wal = new Wal<number>(storage, 'test-key');
    expect(wal.readAll()).toEqual([]);
  });

  it('simulates cross-session recovery: new Wal instance reads persisted data', () => {
    const storage = makeStorage();
    const wal1 = new Wal<string>(storage, 'session-key');
    wal1.write(['span-a', 'span-b']);

    // New session — new Wal instance over the same storage
    const wal2 = new Wal<string>(storage, 'session-key');
    const batches = wal2.readAll();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.data).toEqual(['span-a', 'span-b']);
  });
});
