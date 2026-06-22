# Design Choices & Trade-offs

This document explains every major decision and its trade-offs — the material you
should be ready to defend in the viva/mock interview.

---

## 1. Data modeling — how query-count data is stored

**Choice:** An in-memory `Map<query, {count, lastSearched, recentScore, recentTs}>`
as the primary store, plus a **Trie** as the suggestion index.

- The `Map` is the source of truth for counts and recency state.
- The Trie is a derived index optimized for prefix reads.

**Why a Trie for suggestions?** The requirement is "suggest as you type", so the
read happens on every keystroke and must be fast regardless of dataset size.
Options considered:

| Approach | Prefix lookup | Notes |
| --- | --- | --- |
| Linear scan + filter | O(N) per query | 120k string scans per keystroke — too slow. |
| Sorted array + binary search on prefix range | O(log N + matches) | Finds the range fast, but still must sort matches by count each time. |
| **Trie with precomputed Top-K per node** | **O(L + K)** | L = prefix length, K = 10. Independent of N. Chosen. |

**The Top-K trick:** for a short prefix like `i`, thousands of words match. Re-scanning
that subtree per keystroke is too slow, so each Trie node stores the Top-K best
completions in its subtree, computed once at build time (bottom-up) and repaired
incrementally on updates (only along the changed word's root path).

**Trade-off:** extra memory for the per-node Top-K arrays, and a small cost to
repair Top-K on writes. Both are bounded (K=12) and writes are batched, so it's a
good trade for the read speed gained.

**Why in-memory?** The assignment must run locally with no external services. The
store is abstracted behind a class, so it can be swapped for Redis/SQL later. The
durability implications are discussed in §6.

---

## 2. Caching — serving suggestions with low latency

**Choice:** A read-through cache in front of the Trie. The suggestion flow checks
the cache first; on a miss it computes from the Trie and writes the result back.

- **Key:** `mode:prefix` (so `basic` and `enhanced` rankings never collide).
- **Value:** the final suggestion list for that prefix.
- **Eviction:** LRU per node, bounded by `capacityPerNode`.
- **Expiry/invalidation:** every entry has a TTL (default 30s) so stale results
  cannot live forever; additionally, the batch writer **explicitly invalidates**
  every prefix of any query whose count/recency changed, so popularity updates are
  reflected promptly rather than waiting out the TTL.

**Why both TTL and explicit invalidation?** TTL is a safety net (bounds staleness
even for prefixes we forget to invalidate); explicit invalidation gives
correctness right after a write. Together they bound staleness tightly while
keeping the hit rate high.

**Trade-off:** caching means suggestions can be briefly stale between a write and
the corresponding invalidation/TTL — acceptable for a popularity-ranked feature
where exactness isn't required.

---

## 3. Consistent hashing — which cache node owns a prefix

**Choice:** A hash ring with **virtual nodes**. Each physical cache node is placed
at 150 points on a `[0, 2^32)` ring; a key is owned by the first virtual node
clockwise from `hash(key)`.

**Why not `hash(key) % N`?** Modulo hashing remaps almost every key when `N`
changes (a node added/removed), which would invalidate the entire cache. Consistent
hashing remaps only ~`1/N` of keys on a membership change.

**Why virtual nodes?** With one point per node, arc sizes vary wildly and load is
uneven. Virtual nodes (replicas) smooth the distribution; variance shrinks as
~`1/√(virtualNodes)`.

**Hash function:** FNV-1a (fast, dependency-free) followed by a **murmur3 fmix32
finalizer**. Plain FNV-1a has weak avalanche on near-identical inputs like
`cache-node-0#0` vs `cache-node-1#0`, which clustered the virtual nodes and skewed
the ring badly (one node got 5/702 sample keys). The finalizer scrambles the
output; the four nodes then split a 702-key sample as ≈ 153 / 207 / 181 / 161.

**Lookup cost:** ring points are kept sorted; lookup is a binary search, `O(log V)`.

**Trade-off:** virtual nodes cost memory (600 ring points here) and the ring must
be re-sorted on membership change — both negligible at this scale.

---

## 4. Trending / recency-aware ranking (the +20% feature)

**Choice:** Combine all-time popularity with an exponential time-decayed recency
score.

- **How recent searches are tracked:** each query has a `recentScore`. On a search
  at time `t`, we decay the old score to `t` then add the event count:
  `recentScore = recentScore · 0.5^(Δt / halfLife) + events`. A configurable
  half-life (default 60s) controls how fast the boost fades.
- **How recent activity affects ranking:** enhanced mode scores each candidate as
  `popularityWeight·log10(1+count) + recencyWeight·decayedRecentScore(now)`.
  `log10(count)` compresses the huge range of all-time counts so a genuine recent
  surge can actually move an item up, while evergreen-popular queries still rank
  well.
- **Avoiding permanent over-ranking:** the recency term **decays continuously**.
  A query that was hammered once and then goes quiet sees its recency contribution
  halve every half-life and fade to ~0, dropping back to popularity-only ranking.
  This is the key difference from naively bumping a counter forever.
- **Candidate pool:** Trie Top-K (popular) ∪ recently-active queries matching the
  prefix (fresh). This mirrors real systems: a stable popular index plus a small,
  fast recency overlay.

**Trade-offs (freshness vs latency vs complexity):**
- We decay **lazily** (at read/update time), with no background sweep — zero idle
  CPU cost, but a stored score is "as of last touch" until read.
- The recency overlay is kept small (bounded recently-active set), so scanning it
  per request is cheap.
- The same `/suggest` endpoint serves both rankings via `mode`, so the enhancement
  required no API change.

**Demonstration:** after submitting `iphone charger usa step by step` ~30 times,
it jumps from #5 (by count) in basic mode to **#1** in enhanced mode (recency
score dominates), while basic mode order is unchanged. See [PERFORMANCE.md](PERFORMANCE.md).

---

## 5. Batch writes — reducing write pressure

**Choice:** A write buffer that **aggregates by query**, flushed on a size or time
trigger.

- Every `POST /search` is added to an in-memory buffer keyed by query; repeats
  increment the buffered count instead of writing.
- Flush when the buffer holds `maxBatchSize` distinct queries **or** every
  `flushIntervalMs` — whichever comes first.
- On flush, each distinct query is written **once** with its aggregated delta,
  regardless of how many times it was searched in the window.

**Result:** in the benchmark, ~5,031 raw submissions became **33** store writes —
a **~152× reduction** (it scales with how repetitive the traffic is).

**Why aggregate, not just buffer?** Typeahead traffic is highly repetitive (many
people search the same hot query). Aggregation collapses N searches of one query
into one write; plain buffering would still write N times.

---

## 6. Failure trade-offs (must discuss)

The buffer is in-memory and not yet durable. **If the process crashes before a
flush, the un-flushed window is lost.** Consequences and reasoning:

- **What is lost:** only the most recent (≤ flush interval) counts. Because counts
  are a popularity *signal*, a small under-count is tolerable and the system stays
  consistent — it never double-counts or corrupts existing data.
- **Mitigation in place:** on graceful shutdown (SIGINT/SIGTERM) we flush the
  buffer before exiting, so normal restarts lose nothing.
- **If durability were required:** write submissions to an append-only log / durable
  queue (e.g. Kafka, or an fsync'd WAL) *before* acknowledging, then batch-consume
  from there. This trades a little write latency and added infrastructure for
  exactly-once-ish durability. For this assignment's approximate-popularity goal,
  the in-memory buffer is the right cost/benefit point.

Other failure considerations:
- **Cache node loss:** consistent hashing means losing a node only drops that
  node's cached prefixes; they are recomputed from the Trie on the next miss
  (correctness preserved, brief latency bump). Only ~1/N of keys are affected.
- **Stale cache:** bounded by TTL + explicit invalidation (§2).

---

## 7. Why Node.js + Express + vanilla frontend

Single language across the stack, no build step, trivial to run locally
(`npm install && npm start`), and the event loop comfortably handles the
in-memory, CPU-light workload. The components are framework-agnostic plain classes,
so the design — not the framework — is what's on display.
