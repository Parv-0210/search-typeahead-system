# API Reference

Every endpoint is reachable at **both** `http://localhost:3000/<path>` (the exact
paths from the assignment, e.g. `GET /suggest`, `POST /search`,
`GET /cache/debug`) and under `http://localhost:3000/api/<path>` (used by the
frontend). They are identical — the router is mounted at both `/` and `/api`.

Base URL (either works): `http://localhost:3000` or `http://localhost:3000/api`

All responses are JSON. Prefixes/queries are normalized server-side: trimmed,
internal whitespace collapsed, and lower-cased (matching is case-insensitive).

---

## `GET /suggest`

Fetch up to 10 prefix-matching suggestions.

**Query params**
| Param | Required | Default | Description |
| --- | --- | --- | --- |
| `q` | yes | — | The typed prefix. Empty/missing → empty list (handled gracefully). |
| `mode` | no | `enhanced` | `basic` = sort by all-time count; `enhanced` = recency-aware score. |

**Example**
```bash
curl "http://localhost:3000/api/suggest?q=iph&mode=enhanced"
```
```json
{
  "prefix": "iph",
  "mode": "enhanced",
  "source": "cache",
  "node": "cache-node-2",
  "latencyMs": 0.036,
  "suggestions": [
    { "query": "iphone setup for beginners", "count": 45568, "score": 4.66 },
    { "query": "iphone alternatives release date cheat sheet", "count": 29374, "score": 4.47 }
  ]
}
```
- `source` — `cache` (HIT) or `compute` (MISS, freshly computed and cached).
- `node` — which cache node owns this prefix (consistent hashing).
- `score` — present in `enhanced` mode; the combined popularity+recency score.

---

## `POST /search`

Submit a search. Returns the dummy response and records the query for a batched
write.

**Body**
```json
{ "query": "iphone 15 pro" }
```
**Example**
```bash
curl -X POST http://localhost:3000/api/search \
  -H "Content-Type: application/json" \
  -d '{"query":"iphone 15 pro"}'
```
```json
{ "message": "Searched", "query": "iphone 15 pro" }
```
Empty/missing `query` → `400 { "message": "query is required" }`.

The count update is **not** applied synchronously — it is buffered and applied on
the next batch flush (≤ `flushIntervalMs`, default 2s, or sooner if the buffer
fills). Use `POST /admin/flush` to apply immediately.

---

## `GET /trending`

Recently surging queries, ranked by decayed recency score.

```bash
curl http://localhost:3000/api/trending
```
```json
{
  "trending": [
    { "query": "iphone charger usa step by step", "count": 4270, "recencyScore": 29.741 },
    { "query": "iphone 15 pro", "count": 1, "recencyScore": 0.845 }
  ]
}
```

---

## `GET /cache/debug`

Show how a prefix routes through the cache and whether it is currently cached.

**Query params**: `prefix` (required), `mode` (`basic`|`enhanced`, default `enhanced`).

```bash
curl "http://localhost:3000/api/cache/debug?prefix=iph"
```
```json
{
  "prefix": "iph",
  "mode": "enhanced",
  "cacheKey": "enhanced:iph",
  "keyHash": 511620130,
  "ownerNode": "cache-node-2",
  "status": "HIT",
  "ttlRemainingMs": 29533
}
```

---

## `GET /metrics`

Performance and internal stats.

```bash
curl http://localhost:3000/api/metrics
```
```json
{
  "datasetSize": 120000,
  "latency": { "samples": 5000, "avgMs": 0.012, "p50Ms": 0.011, "p95Ms": 0.033, "p99Ms": 0.051, "maxMs": 1.2 },
  "suggestRequests": 5000,
  "cache": { "hits": 4979, "misses": 28, "hitRate": 0.994, "evictions": 0, "expirations": 0, "perNode": { } },
  "ring": { "nodes": ["cache-node-0","..."], "virtualNodesPerNode": 150, "sampleDistribution": { } },
  "store": { "reads": 0, "writes": 33, "batchFlushes": 6 },
  "batch": { "rawSubmissions": 5031, "storeWrites": 33, "writeReductionFactor": 152.45, "bufferedDistinctQueries": 0 }
}
```

---

## `POST /admin/flush`

Force the batch buffer to flush now (handy in the demo).

```bash
curl -X POST http://localhost:3000/api/admin/flush
```
```json
{ "flushed": 3, "reason": "manual" }
```

---

## `GET /ring/debug`

Inspect where an arbitrary key lands on the hash ring.

```bash
curl "http://localhost:3000/api/ring/debug?key=hello"
```
```json
{ "key": "hello", "keyHash": 1335831723, "node": "cache-node-1" }
```

---

## `GET /health`

Liveness check: `{ "ok": true, "datasetSize": 120000 }`.
