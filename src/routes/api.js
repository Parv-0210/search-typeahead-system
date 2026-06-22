// HTTP API. All routes are thin: validation + orchestration of the components
// assembled in server.js (passed in via `ctx`).

import express from 'express';
import { SuggestionEngine } from '../engine/SuggestionEngine.js';

export function createApiRouter(ctx) {
  const { engine, cache, batchWriter, store, metrics, recency, config } = ctx;
  const router = express.Router();

  // GET /suggest?q=<prefix>&mode=basic|enhanced
  // Returns up to 10 prefix-matching suggestions sorted by score.
  // Read path: cache (consistent-hash routed) -> Trie fallback on miss.
  router.get('/suggest', (req, res) => {
    const start = process.hrtime.bigint();
    const rawPrefix = req.query.q;
    const mode = req.query.mode === 'basic' ? 'basic' : 'enhanced';

    // Graceful handling of empty / missing input.
    const prefix = SuggestionEngine.normalize(rawPrefix);
    if (!prefix) {
      return res.json({ prefix: '', mode, source: 'none', suggestions: [] });
    }

    const now = Date.now();
    let source = 'cache';
    let suggestions;

    const cached = cache.get(mode, prefix, now);
    if (cached.hit) {
      suggestions = cached.value;
    } else {
      // Cache miss -> compute from the Trie / recency layer, then populate cache.
      source = 'compute';
      suggestions = engine.suggest(prefix, { mode, now });
      cache.set(mode, prefix, suggestions, now);
    }

    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    metrics.recordSuggestLatency(ms);

    res.json({
      prefix,
      mode,
      source, // "cache" hit or "compute" (miss)
      node: cached.node, // which cache node owns this prefix
      latencyMs: Number(ms.toFixed(3)),
      suggestions,
    });
  });

  // POST /search  body: { query }
  // Dummy search response + records the submission via the batch writer.
  router.post('/search', (req, res) => {
    const query = SuggestionEngine.normalize(req.body && req.body.query);
    if (!query) {
      return res.status(400).json({ message: 'query is required' });
    }
    // Non-blocking: buffered now, persisted on the next batch flush.
    batchWriter.add(query);
    res.json({ message: 'Searched', query });
  });

  // GET /trending  -> recently surging queries (recency-decayed ranking).
  router.get('/trending', (req, res) => {
    res.json({ trending: engine.trending(Date.now(), config.trending.limit) });
  });

  // GET /cache/debug?prefix=<prefix>&mode=basic|enhanced
  // Shows the owning cache node (via consistent hashing) and HIT/MISS.
  router.get('/cache/debug', (req, res) => {
    const mode = req.query.mode === 'basic' ? 'basic' : 'enhanced';
    const prefix = SuggestionEngine.normalize(req.query.prefix);
    if (!prefix) return res.status(400).json({ message: 'prefix is required' });
    res.json(cache.debug(mode, prefix, Date.now()));
  });

  // POST /admin/flush -> force a batch flush (handy for the demo / viva).
  router.post('/admin/flush', (req, res) => {
    res.json(batchWriter.flush('manual'));
  });

  // GET /metrics -> latency, cache hit rate, DB read/write & batch stats.
  router.get('/metrics', (req, res) => {
    // Sample many prefixes (a..z and aa..zz) so the distribution is
    // representative — 26 keys alone is too noisy to show even spread.
    const sampleKeys = [];
    for (let a = 97; a <= 122; a++) {
      sampleKeys.push(String.fromCharCode(a));
      for (let b = 97; b <= 122; b++) {
        sampleKeys.push(String.fromCharCode(a) + String.fromCharCode(b));
      }
    }
    res.json({
      datasetSize: store.size(),
      latency: metrics.latency(),
      suggestRequests: metrics.suggestRequests,
      cache: cache.stats(),
      ring: {
        nodes: [...cache.ring.nodes],
        virtualNodesPerNode: config.cache.virtualNodesPerNode,
        sampleDistribution: cache.ring.distribution(sampleKeys),
      },
      store: store.stats,
      batch: batchWriter.status(),
      lastFlush: metrics.lastFlush,
    });
  });

  // GET /ring/debug?key=<key> -> raw ring placement of an arbitrary key.
  router.get('/ring/debug', (req, res) => {
    const key = (req.query.key || '').toString();
    if (!key) return res.status(400).json({ message: 'key is required' });
    res.json(cache.ring.describe(key));
  });

  return router;
}
