# Project Report — Search Typeahead System

**Author:** Parv Mehta
**Repository:** https://github.com/Parv-0210/search-typeahead-system
**Stack:** Node.js + Express (backend), vanilla HTML/CSS/JS (frontend) — no build step.

A search-as-you-type system that suggests popular queries while the user types,
records submitted searches, updates query popularity, and serves suggestions with
low latency through a distributed cache. The focus is the backend data-system
design: how query-count data is stored, how suggestions are served quickly, how
the cache is distributed, and how write pressure is reduced.

---

## 1. Architecture

### 1.1 Diagram

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
         ▼                               ▼  - update Trie · invalidate cache
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

### 1.2 Components

| Component | File | Responsibility |
| --- | --- | --- |
| **DataStore** | `src/store/DataStore.js` | Primary store / source of truth. In-memory `Map<query, {count, lastSearched, recentScore, recentTs}>`. Tracks read/write counters. Narrow interface so it could be swapped for Redis/SQL. |
| **Trie** | `src/engine/Trie.js` | Prefix tree; every node caches the **Top-K** best completions in its subtree. Prefix lookup is O(prefix length). |
| **RecencyTracker** | `src/engine/RecencyTracker.js` | Exponential time-decay recency scoring + the combined popularity+recency score. |
| **SuggestionEngine** | `src/engine/SuggestionEngine.js` | Produces ranked suggestions (basic/enhanced) and the trending list. |
| **DistributedCache** | `src/cache/*.js` | Consistent-hash ring + N LRU/TTL cache nodes; HIT/MISS stats, prefix invalidation, debug view. |
| **BatchWriter** | `src/batch/BatchWriter.js` | Buffers and aggregates `POST /search` submissions, flushes on size/time trigger. |
| **Metrics** | `src/metrics/Metrics.js` | p50/p95/p99 latency + flush bookkeeping. |
| **API** | `src/routes/api.js` | HTTP endpoints (mounted at both `/` and `/api`). |

### 1.3 Request flows

**`GET /suggest?q=<prefix>` (read, hot path)**
1. Normalize the prefix (trim, collapse spaces, lower-case).
2. Cache key = `mode:prefix`; the consistent-hash ring picks the owning cache node.
3. **Hit** → return the cached suggestion list immediately.
4. **Miss** → SuggestionEngine computes from the Trie (+ recency re-rank in enhanced mode); the result is written back to the cache and returned.
5. Latency recorded in Metrics.

**`POST /search` (write path)**
1. Normalize the query; reject empty (`400`).
2. `BatchWriter.add(query)` buffers it and returns `{ "message": "Searched" }` immediately — no synchronous store write.
3. On the next flush (buffer ≥ `maxBatchSize` or every `flushIntervalMs`): aggregated counts are applied to the store, the Trie Top-K is repaired, the recency score is decayed-then-bumped, the query joins the trending layer, and affected cache prefixes are invalidated.

**`GET /trending`** — reads recently-active queries, decays each recency score to "now", returns the top by decayed score.

### 1.4 Why this shape
- **Read/write split.** Reads go through a cache in front of an O(L) Trie; writes are absorbed by a batch buffer. The paths scale independently.
- **Popular index + recency overlay.** A stable precomputed popularity index (the Trie) plus a small, fast-moving recency layer is how production typeahead separates "evergreen popular" from "trending now".
- **Distributed cache via consistent hashing.** Keys are owned by specific nodes so the cache scales horizontally; adding/removing a node remaps only ~1/N of keys.

---

## 2. Dataset — source and loading instructions

### 2.1 Source
The dataset is **synthetic but realistic and reproducible**, generated by
`scripts/generate-dataset.js`. The assignment permits any `(query, count)` dataset;
generating one keeps the repo self-contained and guarantees the ≥100,000-query
minimum without shipping a large binary.

- **Size:** ~120,000 unique queries (above the 100k minimum).
- **Distribution:** counts follow a **Zipf-like** distribution (a few very popular
  queries, a long tail of rare ones), mirroring real search traffic — this makes
  the "sort by count" behaviour visually obvious in the demo.
- **Reproducibility:** a fixed-seed PRNG (`mulberry32(42)`), so regenerating yields
  a stable dataset.
- **Format** (`data/queries.csv`):
  ```csv
  query,count
  iphone,100000
  iphone 15,85000
  iphone charger,60000
  java tutorial,40000
  ```

### 2.2 Loading instructions
```bash
npm install          # installs Express
npm run generate     # writes data/queries.csv (~120k rows)
npm start            # boots server; streams the CSV into the store + Trie
# open http://localhost:3000/
```
On boot, `src/store/loadDataset.js` **streams** the CSV line-by-line (so a large
file is never held as one giant string), inserts each row into the DataStore and
Trie, then runs a single bottom-up pass to populate every Trie node's Top-K.
Boot time for 120k rows is ≈ 3.7 s.

**Using your own dataset:** replace `data/queries.csv` (same `query,count` header)
or set `DATASET_PATH=path/to/file.csv`. If your data lacks counts, aggregate to
derive them first.

---

## 3. API documentation

Every endpoint is reachable at both `http://localhost:3000/<path>` (the exact
assignment paths) and `http://localhost:3000/api/<path>` (used by the frontend).

### `GET /suggest?q=<prefix>&mode=basic|enhanced`
Returns up to 10 prefix-matching suggestions. `mode` defaults to `enhanced`
(`basic` = sort by all-time count; `enhanced` = recency-aware). Empty/missing `q`
returns an empty list. Matching is case-insensitive.
```json
{
  "prefix": "iph", "mode": "enhanced", "source": "cache",
  "node": "cache-node-2", "latencyMs": 0.036,
  "suggestions": [
    { "query": "iphone setup for beginners", "count": 45568, "score": 4.66 }
  ]
}
```
- `source`: `cache` (HIT) or `compute` (MISS, then cached). `node`: owning cache node.

### `POST /search`  body `{ "query": "..." }`
Returns the dummy response and records the query for a batched write.
```json
{ "message": "Searched", "query": "iphone 15 pro" }
```
Empty query → `400 { "message": "query is required" }`. The count update is applied
on the next flush (≤ `flushIntervalMs`, default 2 s); existing queries increment,
new queries are inserted.

### `GET /cache/debug?prefix=<prefix>&mode=basic|enhanced`
Shows the cache node responsible for the prefix (via consistent hashing) and HIT/MISS.
```json
{
  "prefix": "iph", "mode": "enhanced", "cacheKey": "enhanced:iph",
  "keyHash": 511620130, "ownerNode": "cache-node-2",
  "status": "HIT", "ttlRemainingMs": 29533
}
```

### `GET /trending`
Recently surging queries by decayed recency score.
```json
{ "trending": [ { "query": "iphone charger usa step by step", "count": 4270, "recencyScore": 29.741 } ] }
```

### `GET /metrics`
Latency percentiles, cache hit rate, store read/write counts, ring distribution,
write-reduction factor. (See §5.)

### `POST /admin/flush`
Forces a batch flush now → `{ "flushed": 3, "reason": "manual" }`.

### `GET /ring/debug?key=<key>`  ·  `GET /health`
Inspect raw ring placement of any key; liveness check.

---

## 4. Design choices and trade-offs

### 4.1 Data modeling — how query-count data is stored
In-memory `Map` as the source of truth + a **Trie** as the suggestion index.

**Why a Trie?** The read happens on every keystroke and must be fast regardless of
dataset size.

| Approach | Prefix lookup | Verdict |
| --- | --- | --- |
| Linear scan + filter | O(N) per query | 120k scans/keystroke — too slow |
| Sorted array + binary search | O(log N + matches) | Still must sort matches by count each time |
| **Trie + precomputed Top-K per node** | **O(L + K)** | Independent of N — **chosen** |

**The Top-K trick:** for a short prefix like `i`, thousands of words match.
Re-scanning that subtree per keystroke is too slow, so each node stores the Top-K
best completions in its subtree, computed once at build (bottom-up) and repaired
incrementally on updates (only along the changed word's root path, since only
ancestors of a changed word can be affected).
**Trade-off:** extra memory for per-node Top-K arrays (bounded, K=12) and a small
write-time repair cost — a good trade for the read speed gained. In-memory keeps it
locally runnable; the store is abstracted so it could become Redis/SQL.

### 4.2 Caching — low-latency reads
Read-through cache in front of the Trie. **Key** = `mode:prefix` (so basic/enhanced
never collide); **value** = the suggestion list. **Eviction** = LRU per node;
**expiry** = per-entry TTL (30 s) *plus* explicit invalidation of every prefix of a
query whose count/recency changed.
**Why both TTL and invalidation?** TTL bounds staleness as a safety net; explicit
invalidation gives correctness immediately after a write. Together they keep
staleness tight and the hit rate high.
**Trade-off:** suggestions can be briefly stale between a write and its
invalidation/TTL — acceptable for a popularity-ranked feature.

### 4.3 Consistent hashing — which cache node owns a prefix
A hash ring with **virtual nodes** (150 per physical node on a `[0, 2^32)` ring); a
key is owned by the first virtual node clockwise from `hash(key)`.
**Why not `hash % N`?** Modulo remaps almost every key when N changes, wiping the
cache. Consistent hashing remaps only ~1/N of keys.
**Why virtual nodes?** They smooth the distribution; load variance shrinks as
~1/√(virtualNodes).
**Hash function:** FNV-1a + a **murmur3 fmix32 finalizer**. Plain FNV-1a has weak
avalanche on near-identical inputs (`cache-node-0#0` vs `cache-node-1#0`), which
clustered virtual nodes and skewed the ring badly (one node got 5/702 keys). The
finalizer fixes it → ≈ even 4-way split (§5.3). Lookup is a binary search over
sorted ring points, O(log V).

### 4.4 Trending / recency-aware ranking (the +20%)
- **How recent searches are tracked:** each query has a `recentScore`. On a search
  at time `t`: `recentScore = recentScore · 0.5^(Δt / halfLife) + events`
  (decay-then-add). Half-life default 60 s.
- **How recency affects ranking:** enhanced score =
  `popularityWeight·log10(1+count) + recencyWeight·decayedRecentScore(now)`.
  `log10(count)` compresses the huge count range so a real surge can move an item up
  while evergreen-popular queries still rank well.
- **Avoiding permanent over-ranking:** the recency term **decays continuously** — a
  one-off spike halves every half-life and fades to ~0, dropping back to
  popularity-only ranking. This is the key difference from a counter you bump forever.
- **Cache update when rankings change:** the batch flush invalidates all affected
  prefixes, so the next `/suggest` recomputes with fresh scores.
- **Candidate pool:** Trie Top-K (popular) ∪ recently-active queries matching the
  prefix (fresh), re-scored — mirroring real systems' "popular index + recency overlay".
- **Trade-offs (freshness vs latency vs complexity):** decay is **lazy** (at
  read/update time, no background sweep) → zero idle CPU but a stored score is "as of
  last touch" until read; the recency overlay is bounded so per-request scanning is
  cheap; the **same `/suggest` API** serves both rankings via `mode`, so no API change.

### 4.5 Batch writes — reducing write pressure
A write buffer that **aggregates by query**, flushed on a size or time trigger.
Repeated searches of one query in a window collapse into a **single** store write
with the aggregated delta.
**Why aggregate, not just buffer?** Typeahead traffic is highly repetitive;
aggregation turns N searches of a hot query into one write, where plain buffering
would still write N times. Measured reduction: ~167× (§5.4).

### 4.6 Failure trade-offs (crash before flush)
The buffer is in-memory and not yet durable. **If the process crashes before a
flush, the un-flushed window (≤ flush interval) is lost.**
- **Impact:** only a small, recent under-count. Counts are a popularity *signal*, so
  this is tolerable, and the system never double-counts or corrupts existing data.
- **Mitigation in place:** on graceful shutdown (SIGINT/SIGTERM) the buffer is
  flushed, so normal restarts lose nothing.
- **If durability were required:** write submissions to an append-only log / durable
  queue (e.g. Kafka or an fsync'd WAL) *before* acknowledging, then batch-consume —
  trading a little latency + infrastructure for durability. For this assignment's
  approximate-popularity goal, the in-memory buffer is the right cost/benefit point.
- **Cache node loss:** consistent hashing means losing a node drops only its cached
  prefixes (~1/N of keys), recomputed from the Trie on the next miss — correctness
  preserved, brief latency bump.

---

## 5. Performance report

Measured on the reference machine (Node.js 22, Windows, 120,000-query dataset) via
`npm run benchmark` (5,000 `/suggest` requests + 5,000 `/search` submissions).
Reproduce: `npm start` (terminal 1), `npm run benchmark` (terminal 2). Numbers vary
run-to-run; the relationships are stable.

### 5.1 Suggestion latency (incl. p95)
| Metric | Server-side (compute) | Client RTT (incl. HTTP/loopback) |
| --- | --- | --- |
| p50 | **0.012 ms** | 1.27 ms |
| p95 | **0.024 ms** | 1.94 ms |
| p99 | **0.061 ms** | 3.88 ms |

The suggestion logic itself is tens of microseconds at p95; client RTT is dominated
by HTTP/loopback. Single-observation cache effect: **miss** ≈ 0.5–0.8 ms (compute
from Trie) vs **hit** ≈ 0.03 ms — roughly **20–25× faster**.

### 5.2 Cache hit rate
| Metric | Value |
| --- | --- |
| Hit rate | **99.5%** |
| Hits / misses | 4976 / 24 |
| Evictions / expirations | 0 / 0 (within capacity & TTL this run) |

First request for each distinct prefix is a cold miss; subsequent requests within
the TTL hit. Typeahead traffic concentrates on few hot prefixes → very high
steady-state hit rate.

### 5.3 Consistent-hash key distribution
702-prefix sample (`a`..`z`, `aa`..`zz`) across 4 nodes (150 virtual nodes each):
| Node | Keys | Share |
| --- | --- | --- |
| cache-node-0 | 153 | 21.8% |
| cache-node-1 | 207 | 29.5% |
| cache-node-2 | 181 | 25.8% |
| cache-node-3 | 161 | 22.9% |

Reasonably even (ideal 25% each). **Before** the murmur finalizer the same sample
split as 240 / 382 / **5** / 75 — demonstrating why the finalizer matters. Inspect
live: `curl "http://localhost:3000/cache/debug?prefix=iph"`.

### 5.4 Batch writes — write reduction
| Metric | Value |
| --- | --- |
| Raw submissions received | 5,000 |
| Actual store writes | **30** |
| Batch flushes | 3 |
| **Write reduction** | **≈ 167×** |
| Store reads (suggest path) | 0 (served by cache/Trie) |

5,000 submissions aggregated into **30** store writes. The factor scales with
traffic repetitiveness. Suggest-path store reads stay at 0 because suggestions come
from the cache and Trie index, not the primary store.

### 5.5 Basic vs enhanced ranking (demonstration)
After submitting `iphone charger usa step by step` ~30 times then flushing:

**Basic** (`mode=basic`, by all-time count):
```
1. iphone setup for beginners                   count 45568
2. iphone alternatives release date cheat sheet  count 29374
3. iphone comparison best youtube                count  8127
4. iphone deals reddit interview questions       count  6613
5. iphone charger usa step by step               count  4270   ← lowest of five
```
**Enhanced** (`mode=enhanced`, recency-aware):
```
1. iphone charger usa step by step               count 4270 · score 77.92  ← jumped to #1
2. iphone setup for beginners                     count 45568 · score 4.66
3. iphone alternatives release date cheat sheet   count 29374 · score 4.47
```
The recently-searched query overtakes far more popular ones via its recency boost,
then decays back down over time — the core difference between the 60% (count-only)
and +20% (recency-aware) versions.

### 5.6 Capturing your own numbers
- Live dashboard: the UI's **Live metrics** panel auto-refreshes hit rate, p95,
  write reduction, etc.
- Raw JSON: `curl http://localhost:3000/metrics`.
- Full load test: `npm run benchmark` (tune with `SUGGESTS=`, `SEARCHES=`, `BASE=`).

---

## Appendix — running the project
```bash
git clone https://github.com/Parv-0210/search-typeahead-system.git
cd search-typeahead-system
npm install
npm run generate     # data/queries.csv (~120k queries)
npm start            # http://localhost:3000/
npm run benchmark    # performance report (in a second terminal)
```
Config knobs (cache nodes, TTL, batch size, ranking weights) live in `src/config.js`.
