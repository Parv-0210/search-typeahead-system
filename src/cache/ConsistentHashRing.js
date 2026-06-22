// Consistent hashing ring.
//
// Problem it solves: we have several cache nodes and must decide which node owns
// a given prefix key. The naive answer, hash(key) % N, remaps almost every key
// whenever N changes (a node is added/removed), which would blow away the whole
// cache. Consistent hashing remaps only ~1/N of keys on a membership change.
//
// How it works:
//   - Place each physical node at many points ("virtual nodes" / replicas) on a
//     circular keyspace [0, 2^32).
//   - To look up a key, hash it to a point on the ring and walk clockwise to the
//     first virtual node; that node owns the key.
//   - Virtual nodes smooth out the distribution so no single node gets a hugely
//     oversized arc of the ring.
//
// We use a 32-bit FNV-1a hash (small, fast, dependency-free) and a sorted array
// of ring points with binary search for the clockwise lookup (O(log V)).

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619, kept in 32-bit unsigned range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  // Avalanche/finalizer (murmur3 fmix32). Plain FNV-1a has weak bit-mixing on
  // near-identical inputs like "cache-node-0#0" vs "cache-node-1#0", which makes
  // virtual nodes cluster and skews the ring. This scrambles the output so
  // virtual nodes spread evenly across the keyspace.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export class ConsistentHashRing {
  constructor(nodes = [], replicas = 150) {
    this.replicas = replicas;
    /** @type {{hash:number, node:string}[]} sorted by hash ascending */
    this.ring = [];
    this.nodes = new Set();
    for (const n of nodes) this.addNode(n);
  }

  static hash(key) {
    return fnv1a32(key);
  }

  addNode(node) {
    if (this.nodes.has(node)) return;
    this.nodes.add(node);
    for (let i = 0; i < this.replicas; i++) {
      this.ring.push({ hash: fnv1a32(`${node}#${i}`), node });
    }
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  removeNode(node) {
    if (!this.nodes.has(node)) return;
    this.nodes.delete(node);
    this.ring = this.ring.filter((p) => p.node !== node);
  }

  // Return the node that owns `key` (first virtual node clockwise from hash(key)).
  getNode(key) {
    if (this.ring.length === 0) return null;
    const h = fnv1a32(key);
    // Binary search for the first ring point with hash >= h.
    let lo = 0;
    let hi = this.ring.length - 1;
    if (h > this.ring[hi].hash) return this.ring[0].node; // wrap around
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ring[mid].hash < h) lo = mid + 1;
      else hi = mid;
    }
    return this.ring[lo].node;
  }

  // Diagnostic: hash of a key plus the owning node (used by /cache/debug).
  describe(key) {
    return { key, keyHash: fnv1a32(key), node: this.getNode(key) };
  }

  // Diagnostic: how evenly keys would spread across nodes (used in perf report).
  distribution(sampleKeys) {
    const counts = Object.fromEntries([...this.nodes].map((n) => [n, 0]));
    for (const k of sampleKeys) counts[this.getNode(k)]++;
    return counts;
  }
}
