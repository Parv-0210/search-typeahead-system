# Search Typeahead System

A search-as-you-type (typeahead) system, similar to the suggestion feature in
search engines and e-commerce sites. It suggests popular queries while you type,
records submitted searches, updates query popularity, and serves suggestions
with low latency through a distributed cache.

This project focuses on the **backend data-system design**: how query-count data
is stored, how suggestions are served quickly, how the cache is distributed, and
how write pressure is reduced.

> Built with Node.js + Express (backend) and vanilla HTML/CSS/JS (frontend).
> No build step, no external services — `npm install && npm start` and open a browser.

---

## Features

| Area | What it does |
| --- | --- |
| **Typeahead suggestions** | `GET /suggest?q=<prefix>` returns up to 10 prefix matches sorted by score. Backed by a **Trie with a precomputed Top-K at every node** → O(prefix length) reads. |
| **Search submission** | `POST /search` returns `{ "message": "Searched" }` and records the query. |
| **Distributed cache** | Suggestion results are cached across **4 logical cache nodes** chosen by **consistent hashing** (FNV-1a + murmur finalizer, 150 virtual nodes/node). Each node is an **LRU cache with per-entry TTL**. |
| **Trending / recency-aware ranking** | Enhanced ranking blends all-time popularity with a **time-decayed recency score** so recently surging queries rank higher — without permanently over-ranking once-popular queries. |
| **Batch writes** | Submissions are buffered and **aggregated by query**, then flushed on a size/time trigger — turning thousands of per-request writes into a handful of store writes. |
| **Metrics** | `GET /metrics` reports p50/p95/p99 latency, cache hit rate, store read/write counts, ring distribution, and write-reduction factor. |
| **UI** | Search box with debounced suggestions, keyboard navigation, dummy search response, live trending panel, live metrics, and a cache HIT/MISS routing indicator. |

---

## Quick start

```bash
# 1. Install dependencies (only Express)
npm install

# 2. Generate the dataset (~120,000 queries → data/queries.csv)
npm run generate

# 3. Start the server
npm start

# 4. Open the UI
#    http://localhost:3000/
```

Then start typing in the search box (try `iph`, `mac`, `best`). Press **Enter**
or click **Search** to submit — watch the Trending and Metrics panels update.

### Optional: run the performance benchmark

With the server running, in a second terminal:

```bash
npm run benchmark
```

It fires thousands of `/suggest` and `/search` calls and prints latency
percentiles, cache hit rate, ring distribution, and write reduction.

---

## API summary

| API | Purpose | Behaviour |
| --- | --- | --- |
| `GET /api/suggest?q=<prefix>&mode=basic\|enhanced` | Fetch suggestions | Up to 10 prefix matches, sorted by count (basic) or recency-aware score (enhanced). Cache-first. |
| `POST /api/search` `{ "query": "..." }` | Submit a search | Returns `{ "message": "Searched" }`, buffers the query for batched write. |
| `GET /api/trending` | Trending searches | Recently surging queries by decayed recency score. |
| `GET /api/cache/debug?prefix=<p>&mode=...` | Debug cache routing | Owning cache node (consistent hashing) + HIT/MISS + TTL remaining. |
| `GET /api/metrics` | Performance metrics | Latency percentiles, cache stats, ring distribution, write reduction. |
| `POST /api/admin/flush` | Force a batch flush | Useful for the demo so updates appear immediately. |
| `GET /api/ring/debug?key=<k>` | Inspect raw ring placement of any key | Hash + owning node. |

Full details and example responses: [docs/API.md](docs/API.md).

---

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, data flow, diagram.
- [docs/DESIGN_CHOICES.md](docs/DESIGN_CHOICES.md) — every major decision and its trade-offs (data modeling, caching, consistent hashing, trending, batching, failure modes).
- [docs/API.md](docs/API.md) — full API reference with examples.
- [docs/PERFORMANCE.md](docs/PERFORMANCE.md) — measured latency, hit rate, and write-reduction report.

---

## Dataset

The dataset is **synthetic** but realistic and reproducible. `scripts/generate-dataset.js`
produces ~120,000 unique queries (above the 100,000 minimum) with **Zipf-like
counts** (a few very popular queries, a long tail of rare ones), mirroring real
search traffic. It is seeded with a fixed PRNG so regenerating gives a stable
dataset. Format:

```csv
query,count
iphone,100000
iphone 15,85000
iphone charger,60000
java tutorial,40000
```

To use your own dataset, replace `data/queries.csv` (same `query,count` header)
or set `DATASET_PATH=path/to/file.csv`.

---

## Project layout

```
src/
  server.js                 # wires everything together, starts Express
  config.js                 # all tunable knobs (cache nodes, TTL, batch size, weights)
  store/
    DataStore.js            # in-memory primary store (source of truth) + read/write stats
    loadDataset.js          # streams the CSV into the store + Trie
  engine/
    Trie.js                 # prefix tree with precomputed Top-K per node
    RecencyTracker.js       # exponential time-decay recency scoring
    SuggestionEngine.js     # basic + enhanced ranking, trending
  cache/
    ConsistentHashRing.js   # ring with virtual nodes (which node owns a prefix)
    LRUCache.js             # one cache node: LRU + TTL
    DistributedCache.js     # the fleet of cache nodes behind the ring
  batch/
    BatchWriter.js          # buffer → aggregate → flush
  metrics/
    Metrics.js              # latency percentiles + flush stats
  routes/
    api.js                  # HTTP endpoints
public/                     # frontend (index.html, styles.css, app.js)
scripts/
  generate-dataset.js       # dataset generator
  benchmark.js              # load test + performance report
data/queries.csv            # generated dataset
```

---

## Configuration

All knobs live in [src/config.js](src/config.js):

- `cache.nodes`, `virtualNodesPerNode`, `ttlMs`, `capacityPerNode`
- `batch.maxBatchSize`, `flushIntervalMs`
- `ranking.popularityWeight`, `recencyWeight`, `recencyHalfLifeMs`
- `suggestions.limit`, `trieTopK`

Port via `PORT` env var (default `3000`).
