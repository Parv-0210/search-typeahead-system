// Primary data store (the "database").
//
// For a locally-runnable assignment we use an in-memory Map as the source of
// truth. It is wrapped behind this class so the rest of the system depends on a
// narrow interface (get / upsert / readCount / writeCount) and the backing store
// could later be swapped for Redis / a SQL table without touching callers.
//
// Each record holds:
//   - count        : all-time popularity (monotonically increasing)
//   - lastSearched : timestamp of the most recent search (epoch ms)
//   - recentScore  : time-decayed recency signal (see RecencyTracker)
//   - recentTs     : timestamp recentScore was last decayed to
//
// We deliberately count reads and writes so the performance report can show how
// caching reduces reads and batching reduces writes.

export class DataStore {
  constructor() {
    /** @type {Map<string, {count:number,lastSearched:number,recentScore:number,recentTs:number}>} */
    this.map = new Map();
    this.stats = { reads: 0, writes: 0, batchFlushes: 0 };
  }

  size() {
    return this.map.size;
  }

  get(query) {
    this.stats.reads++;
    return this.map.get(query);
  }

  has(query) {
    return this.map.has(query);
  }

  // Bulk load from the dataset on boot. Does NOT count as application writes —
  // this is ingestion, not user-driven traffic.
  bulkLoad(entries) {
    for (const { query, count } of entries) {
      this.map.set(query, {
        count,
        lastSearched: 0,
        recentScore: 0,
        recentTs: 0,
      });
    }
  }

  // Apply one aggregated update (called by the batch writer, not per request).
  // delta = number of times this query was searched in the flushed batch.
  // Returns the new record.
  upsert(query, { delta = 1, recentScore = 0, lastSearched = 0 } = {}) {
    this.stats.writes++;
    let rec = this.map.get(query);
    if (!rec) {
      rec = { count: 0, lastSearched: 0, recentScore: 0, recentTs: 0 };
      this.map.set(query, rec);
    }
    rec.count += delta;
    if (lastSearched > rec.lastSearched) rec.lastSearched = lastSearched;
    rec.recentScore = recentScore;
    rec.recentTs = lastSearched || rec.recentTs;
    return rec;
  }

  // Iterate all records (used to rebuild structures / compute trending).
  *entries() {
    for (const [query, rec] of this.map) yield [query, rec];
  }
}
