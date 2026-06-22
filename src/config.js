// Central configuration. All tunable knobs live here so they are easy to explain
// and adjust during the demo / viva.

export const config = {
  server: {
    port: Number(process.env.PORT) || 3000,
  },

  dataset: {
    // Path to the CSV the server loads on boot (query,count).
    path: process.env.DATASET_PATH || 'data/queries.csv',
  },

  suggestions: {
    // Max suggestions returned to the client.
    limit: 10,
    // How many top entries the Trie keeps precomputed per node.
    // Kept >= limit so we have headroom for re-ranking in enhanced mode.
    trieTopK: 12,
  },

  cache: {
    // Number of logical (virtual) cache nodes the ring is built over.
    nodes: ['cache-node-0', 'cache-node-1', 'cache-node-2', 'cache-node-3'],
    // Virtual nodes (replicas) per physical node on the hash ring.
    // More replicas => smoother key distribution.
    virtualNodesPerNode: 150,
    // Time-to-live for a cached prefix result, in milliseconds.
    ttlMs: 30_000,
    // Max prefix entries each cache node holds before LRU eviction.
    capacityPerNode: 5_000,
  },

  batch: {
    // Flush when the buffer holds this many distinct queries...
    maxBatchSize: 50,
    // ...or this many milliseconds have elapsed since the last flush.
    flushIntervalMs: 2_000,
  },

  ranking: {
    // Enhanced (recency-aware) ranking weights.
    // finalScore = popularityWeight * normalizedPopularity
    //            + recencyWeight   * decayedRecentScore
    popularityWeight: 1.0,
    recencyWeight: 2.5,
    // Half-life of the recency boost, in milliseconds.
    // After this much time, a recent search's contribution halves.
    recencyHalfLifeMs: 60_000,
  },

  trending: {
    // How many trending queries the /trending endpoint returns.
    limit: 10,
  },
};
