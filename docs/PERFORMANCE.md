# Performance Report

Measured on the reference machine (Node.js 22, Windows, 120,000-query dataset)
using `npm run benchmark` (5,000 `/suggest` requests + 5,000 `/search`
submissions). Reproduce with:

```bash
npm start            # terminal 1
npm run benchmark    # terminal 2
```

Numbers vary run-to-run, but the relationships (cache hit ↔ latency, batching ↔
write reduction) are stable.

---

## 1. Suggestion latency

| Metric | Server-side (compute time) | Client RTT (incl. HTTP/loopback) |
| --- | --- | --- |
| p50 | **0.012 ms** | 1.27 ms |
| p95 | **0.024 ms** | 1.94 ms |
| p99 | **0.061 ms** | 3.88 ms |

The server-side suggestion logic is **tens of microseconds** at p95. The
client-side RTT is dominated by HTTP/loopback overhead, not the suggestion work
itself — which is exactly why the design pushes the actual lookup down to
`O(prefix length)` and caches results.

**Cache hit vs miss (single observation):**
- Cache **miss** (compute from Trie): ~0.5–0.8 ms server-side.
- Cache **hit** (return cached list): ~0.03 ms server-side — roughly **20–25×
  faster**.

---

## 2. Cache hit rate

| Metric | Value |
| --- | --- |
| Hit rate | **99.5%** |
| Hits / misses | 4976 / 24 |
| Evictions / expirations | 0 / 0 (within capacity & TTL for this run) |

The first request for each distinct prefix is a miss (cold); every subsequent
request within the TTL window is a hit. Because typeahead traffic concentrates on
a small set of hot prefixes, the steady-state hit rate is very high.

---

## 3. Consistent-hash key distribution

Distribution of a 702-prefix sample (`a`..`z`, `aa`..`zz`) across the 4 cache
nodes (150 virtual nodes each):

| Node | Keys | Share |
| --- | --- | --- |
| cache-node-0 | 153 | 21.8% |
| cache-node-1 | 207 | 29.5% |
| cache-node-2 | 181 | 25.8% |
| cache-node-3 | 161 | 22.9% |

Reasonably even (ideal is 25% each). The spread is what virtual nodes + the
murmur finalizer buy us — **before** adding the finalizer, the same sample split
as 240 / 382 / 5 / 75 (node-2 nearly starved). See
[DESIGN_CHOICES.md §3](DESIGN_CHOICES.md#3-consistent-hashing--which-cache-node-owns-a-prefix).

**Inspect routing live:**
```bash
curl "http://localhost:3000/api/cache/debug?prefix=iph"
# → { "ownerNode": "cache-node-2", "status": "HIT", "ttlRemainingMs": 29533, ... }
```

---

## 4. Batch writes — write reduction

| Metric | Value |
| --- | --- |
| Raw submissions received | 5,000 |
| Actual store writes | **30** |
| Batch flushes | 3 |
| **Write reduction factor** | **≈ 167×** |
| Store reads (suggest path) | 0 (served by cache/Trie, not the store) |

5,000 search submissions were aggregated into **30** store writes — about a
**167× reduction**. The exact factor scales with how repetitive the traffic is:
the more often the same query is searched within a flush window, the more writes
collapse into one. Store **reads** stay at 0 on the suggest path because
suggestions are served from the cache and the Trie index, not the primary store.

---

## 5. Read/write counts summary

| Path | Without this design | With this design |
| --- | --- | --- |
| Suggest reads | 1 store/Trie scan per keystroke | ~0.5% hit the Trie (rest cached); store reads = 0 |
| Search writes | 1 store write per submission (5,000) | 30 aggregated writes |

---

## 6. Demonstration: basic vs enhanced ranking

After submitting `iphone charger usa step by step` ~30 times then flushing:

**Basic mode** (`GET /suggest?q=iph&mode=basic`) — ordered by all-time count:
```
1. iphone setup for beginners                  count 45568
2. iphone alternatives release date cheat sheet count 29374
3. iphone comparison best youtube              count  8127
4. iphone deals reddit interview questions     count  6613
5. iphone charger usa step by step             count  4270   ← lowest of the five
```

**Enhanced mode** (`mode=enhanced`) — recency-aware combined score:
```
1. iphone charger usa step by step             count 4270 · score 77.92   ← jumped to #1
2. iphone setup for beginners                  count 45568 · score  4.66
3. iphone alternatives release date cheat sheet count 29374 · score  4.47
...
```

The recently-searched query overtakes far more popular ones because of its
recency boost — and as time passes with no further searches, its score decays and
it falls back down (no permanent over-ranking). This is the core difference
between the 60% (count-only) and +20% (recency-aware) versions.

---

## How to capture your own numbers

- Live dashboard: open the UI — the **Live metrics** panel shows hit rate, p95,
  write reduction, etc., refreshing automatically.
- Raw JSON: `curl http://localhost:3000/api/metrics`.
- Full load test: `npm run benchmark` (tune with `SUGGESTS=`, `SEARCHES=`,
  `BASE=` env vars).
