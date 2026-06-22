// A single cache node: bounded LRU store with per-entry TTL.
//
// - LRU eviction: when capacity is exceeded, the least-recently-used key is
//   dropped. We exploit the fact that a JS Map preserves insertion order — on
//   read/write we delete and re-insert the key so the most-recently-used entry
//   is always last, and the first entry is always the LRU victim.
// - TTL: each entry stores an expiry timestamp. A read past expiry is treated as
//   a miss and the entry is purged (lazy expiration). This is the "expiry /
//   invalidation so stale data does not remain forever" requirement.

export class LRUCache {
  constructor(name, { capacity, ttlMs }) {
    this.name = name;
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    /** @type {Map<string,{value:any,expiresAt:number}>} */
    this.map = new Map();
    this.stats = { hits: 0, misses: 0, evictions: 0, expirations: 0, sets: 0 };
  }

  get(key, now = Date.now()) {
    const entry = this.map.get(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }
    if (entry.expiresAt <= now) {
      // Expired -> lazy delete, count as a miss.
      this.map.delete(key);
      this.stats.expirations++;
      this.stats.misses++;
      return undefined;
    }
    // Touch: move to most-recently-used position.
    this.map.delete(key);
    this.map.set(key, entry);
    this.stats.hits++;
    return entry.value;
  }

  set(key, value, now = Date.now()) {
    this.stats.sets++;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: now + this.ttlMs });
    // Evict LRU entries until within capacity.
    while (this.map.size > this.capacity) {
      const lruKey = this.map.keys().next().value;
      this.map.delete(lruKey);
      this.stats.evictions++;
    }
  }

  delete(key) {
    return this.map.delete(key);
  }

  size() {
    return this.map.size;
  }
}
