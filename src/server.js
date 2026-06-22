// Application entry point — wires every component together and starts Express.
//
// Boot sequence:
//   1. Build the store + Trie, stream the dataset into them.
//   2. Construct the recency tracker, suggestion engine, distributed cache,
//      metrics, and the batch writer.
//   3. Mount the API router and serve the static frontend from /public.
//
// Component ownership / data flow:
//   /suggest  : cache (consistent-hash) -> SuggestionEngine -> Trie + recency
//   /search   : BatchWriter buffer -> (flush) -> DataStore + Trie + cache invalidate
//   /trending : SuggestionEngine recency layer

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { DataStore } from './store/DataStore.js';
import { loadDataset } from './store/loadDataset.js';
import { Trie } from './engine/Trie.js';
import { RecencyTracker } from './engine/RecencyTracker.js';
import { SuggestionEngine } from './engine/SuggestionEngine.js';
import { DistributedCache } from './cache/DistributedCache.js';
import { BatchWriter } from './batch/BatchWriter.js';
import { Metrics } from './metrics/Metrics.js';
import { createApiRouter } from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const t0 = Date.now();

  // 1) Storage + suggestion index.
  const store = new DataStore();
  const trie = new Trie(config.suggestions.trieTopK);
  console.log(`Loading dataset from "${config.dataset.path}"...`);
  const loaded = await loadDataset(config.dataset.path, { store, trie });
  console.log(
    `Loaded ${loaded.toLocaleString()} queries into store + Trie ` +
      `(${trie.wordCount.toLocaleString()} trie words) in ${Date.now() - t0}ms`
  );

  // 2) Ranking, cache, metrics, batching.
  const recency = new RecencyTracker({
    halfLifeMs: config.ranking.recencyHalfLifeMs,
    popularityWeight: config.ranking.popularityWeight,
    recencyWeight: config.ranking.recencyWeight,
  });
  const engine = new SuggestionEngine({
    trie,
    store,
    recency,
    limit: config.suggestions.limit,
  });
  const cache = new DistributedCache(config.cache);
  const metrics = new Metrics();
  const batchWriter = new BatchWriter({
    store,
    trie,
    recency,
    cache,
    engine,
    metrics,
    maxBatchSize: config.batch.maxBatchSize,
    flushIntervalMs: config.batch.flushIntervalMs,
  });
  batchWriter.start();

  // 3) HTTP layer.
  const app = express();
  app.use(express.json());
  const apiRouter = createApiRouter({
    engine, cache, batchWriter, store, metrics, recency, config,
  });
  // Mounted at BOTH "/api" (used by the frontend) and "/" so the exact endpoint
  // paths from the spec work directly: GET /suggest, POST /search,
  // GET /cache/debug. The router has no "/" handler, so a request for the UI
  // falls through to the static middleware below.
  app.use('/api', apiRouter);
  app.use(apiRouter);
  // Serve the frontend.
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/health', (req, res) => res.json({ ok: true, datasetSize: store.size() }));

  const server = app.listen(config.server.port, () => {
    console.log(`\nSearch Typeahead System ready:`);
    console.log(`  UI    : http://localhost:${config.server.port}/`);
    console.log(`  API   : http://localhost:${config.server.port}/api/suggest?q=iph`);
    console.log(
      `  Cache : ${config.cache.nodes.length} nodes, ` +
        `${config.cache.virtualNodesPerNode} virtual nodes each, ` +
        `TTL ${config.cache.ttlMs}ms`
    );
    console.log(
      `  Batch : flush at ${config.batch.maxBatchSize} queries or ` +
        `${config.batch.flushIntervalMs}ms\n`
    );
  });

  // Graceful shutdown: flush the buffer so we don't lose the last window.
  const shutdown = () => {
    console.log('\nShutting down — flushing batch buffer...');
    batchWriter.flush('shutdown');
    batchWriter.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
