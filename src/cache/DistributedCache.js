// DistributedCache — a set of logical cache nodes fronted by a consistent-hash
// ring. This simulates a real distributed cache (e.g. a Redis cluster / a fleet
// of memcached nodes) inside one process: each "node" is an independent LRUCache,
// and the ring decides which node owns a given prefix key.
//
// Read path for suggestions:
//     prefix -> ring.getNode(prefix) -> that node's LRUCache.get(prefix)
//     hit  => return cached suggestions (no DB / Trie work)
//     miss => caller computes from the Trie, then cache.set(prefix, result)
//
// Cache key design: we namespace by ranking mode ("basic" vs "enhanced") so the
// two ranking strategies never serve each other's cached results.

import { ConsistentHashRing } from './ConsistentHashRing.js';
import { LRUCache } from './LRUCache.js';

export class DistributedCache {
  constructor({ nodes, virtualNodesPerNode, ttlMs, capacityPerNode }) {
    this.ring = new ConsistentHashRing(nodes, virtualNodesPerNode);
    /** @type {Map<string, LRUCache>} */
    this.nodes = new Map();
    for (const name of nodes) {
      this.nodes.set(name, new LRUCache(name, { capacity: capacityPerNode, ttlMs }));
    }
  }

  static key(mode, prefix) {
    return `${mode}:${prefix}`;
  }

  _nodeFor(key) {
    const name = this.ring.getNode(key);
    return { name, node: this.nodes.get(name) };
  }

  get(mode, prefix, now = Date.now()) {
    const key = DistributedCache.key(mode, prefix);
    const { name, node } = this._nodeFor(key);
    const value = node.get(key, now);
    return { value, hit: value !== undefined, node: name, key };
  }

  set(mode, prefix, value, now = Date.now()) {
    const key = DistributedCache.key(mode, prefix);
    const { node } = this._nodeFor(key);
    node.set(key, value, now);
  }

  // Invalidate every cached entry for a prefix (both ranking modes). Called by
  // the batch writer after counts change so suggestions don't go stale.
  invalidatePrefix(prefix) {
    for (const mode of ['basic', 'enhanced']) {
      const key = DistributedCache.key(mode, prefix);
      const { node } = this._nodeFor(key);
      node.delete(key);
    }
  }

  // Debug view for GET /cache/debug — which node owns the prefix and hit/miss.
  debug(mode, prefix, now = Date.now()) {
    const key = DistributedCache.key(mode, prefix);
    const desc = this.ring.describe(key);
    const node = this.nodes.get(desc.node);
    const entry = node.map.get(key);
    const present = entry && entry.expiresAt > now;
    return {
      prefix,
      mode,
      cacheKey: key,
      keyHash: desc.keyHash,
      ownerNode: desc.node,
      status: present ? 'HIT' : 'MISS',
      ttlRemainingMs: present ? entry.expiresAt - now : 0,
    };
  }

  // Aggregate stats across all nodes (for /metrics and the perf report).
  stats() {
    let hits = 0;
    let misses = 0;
    let evictions = 0;
    let expirations = 0;
    const perNode = {};
    for (const [name, node] of this.nodes) {
      hits += node.stats.hits;
      misses += node.stats.misses;
      evictions += node.stats.evictions;
      expirations += node.stats.expirations;
      perNode[name] = { ...node.stats, size: node.size() };
    }
    const total = hits + misses;
    return {
      hits,
      misses,
      evictions,
      expirations,
      hitRate: total ? Number((hits / total).toFixed(4)) : 0,
      perNode,
    };
  }
}
