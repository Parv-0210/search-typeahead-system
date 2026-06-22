# Architecture

## Overview

The system is a single Node.js process that serves both the API and the static
frontend. Internally it is composed of clearly separated components so each
responsibility can be explained and swapped independently.

```
                          ┌─────────────────────────────────────────────┐
                          │                  Browser UI                  │
                          │  search box · debounce · keyboard nav · panels│
                          └───────────────┬───────────────┬──────────────┘
                       GET /suggest        │   POST /search │  GET /trending,/metrics
                                           ▼               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Express API (routes/api.js)                        │
└───────┬───────────────────────────────┬────────────────────────┬──────────────┘
        │ read path                      │ write path             │
        ▼                                ▼                        ▼
┌──────────────────┐            ┌──────────────────┐     ┌──────────────────┐
│ DistributedCache │            │   BatchWriter    │     │ SuggestionEngine │
│  (consistent     │            │  buffer +        │     │   trending()     │
│   hash ring →    │  miss      │  aggregate +     │     └──────────────────┘
│   N LRU+TTL      │──────────► │  periodic flush  │
│   cache nodes)   │            └────────┬─────────┘
└────────┬─────────┘                     │ on flush (size/time trigger)
         │ hit: cached suggestions       │  - upsert counts + recency
         ▼                               ▼  - update Trie
┌──────────────────┐            ┌──────────────────────────────────────────┐
│ SuggestionEngine │◄───────────│              DataStore                    │
│  Trie Top-K  +   │   reads    │   source of truth: query → {count,        │
│  recency re-rank │            │   lastSearched, recentScore, recentTs}    │
└────────┬─────────┘            └──────────────────────────────────────────┘
         │ uses
         ▼
┌──────────────────┐    ┌──────────────────┐
│       Trie       │    │  RecencyTracker  │
│ precomputed Top-K│    │ exponential decay│
│ per node         │    │ combined scoring │
└──────────────────┘    └──────────────────┘
```

## Components

### DataStore (`src/store/DataStore.js`)
The primary store / source of truth. An in-memory `Map<query, record>` where each
record holds `count`, `lastSearched`, `recentScore`, and `recentTs`. It tracks
read/write counters so we can demonstrate cache (read reduction) and batching
(write reduction). The narrow interface (`get`, `upsert`, `entries`) means the
backing store could be replaced by Redis or SQL without touching callers.

### Trie (`src/engine/Trie.js`)
A prefix tree. The key idea is that **every node caches the Top-K best-scoring
completions in its subtree**, computed bottom-up. A suggestion lookup is then:

1. Walk to the prefix node — `O(prefix length)`, independent of dataset size.
2. Read that node's precomputed `topK` — `O(K)`.

On an update, only the nodes on the path from the changed word to the root can be
affected, so we recompute their Top-K bottom-up along that single path.

### RecencyTracker (`src/engine/RecencyTracker.js`)
Implements exponential time-decay recency scoring with a configurable half-life,
and the combined score used by enhanced ranking:
`popularityWeight·log10(1+count) + recencyWeight·decayedRecentScore`.

### SuggestionEngine (`src/engine/SuggestionEngine.js`)
Turns a prefix into ranked suggestions in two modes:
- **basic**: straight from the Trie's Top-K (by all-time count).
- **enhanced**: candidate pool = Trie Top-K ∪ recently-active queries matching the
  prefix, re-scored by the RecencyTracker. Also produces the trending list.

### DistributedCache (`src/cache/`)
- `ConsistentHashRing` — maps a prefix key to a cache node using virtual nodes on
  a hash ring.
- `LRUCache` — one cache node: bounded LRU + per-entry TTL.
- `DistributedCache` — the fleet of nodes behind the ring, with HIT/MISS stats,
  prefix invalidation, and a debug view.

### BatchWriter (`src/batch/BatchWriter.js`)
Buffers `POST /search` submissions, aggregates repeated queries, and flushes to
the store + Trie + recency layer on a size or time trigger, invalidating affected
cache prefixes.

### Metrics (`src/metrics/Metrics.js`)
Ring buffer of recent `/suggest` latencies → p50/p95/p99, plus flush bookkeeping.

## Request flows

### `GET /suggest?q=<prefix>` (read, hot path)
1. Normalize the prefix (trim, collapse spaces, lower-case).
2. Compute cache key `mode:prefix`; the ring picks the owning cache node.
3. **Cache hit** → return the cached suggestion list immediately.
4. **Cache miss** → SuggestionEngine computes from the Trie (+ recency re-rank in
   enhanced mode), the result is written back to the cache, and returned.
5. Record latency in Metrics.

### `POST /search` (write path)
1. Normalize the query; reject empty.
2. `BatchWriter.add(query)` buffers it and returns `{ "message": "Searched" }`
   immediately — no synchronous store write.
3. On the next flush (size ≥ `maxBatchSize` or every `flushIntervalMs`):
   aggregated counts are applied to the store, the Trie Top-K is updated, the
   recency score is decayed-then-bumped, the query joins the trending layer, and
   the affected cache prefixes are invalidated.

### `GET /trending`
Reads recently-active queries, decays each recency score to "now", and returns the
top entries by decayed score.

## Why this shape

- **Read/write split.** Reads go through a cache in front of an O(L) Trie; writes
  are absorbed by a batch buffer. The two paths scale independently.
- **Popular index + recency overlay.** A stable, precomputed popularity index
  (the Trie) plus a small, fast-moving recency layer is exactly how production
  typeahead systems separate "evergreen popular" from "trending now".
- **Distributed cache via consistent hashing.** Keys are owned by specific nodes
  so the cache scales horizontally, and adding/removing a node remaps only ~1/N of
  keys instead of the whole cache.
