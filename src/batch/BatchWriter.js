// BatchWriter — absorbs the write pressure of POST /search.
//
// Problem: writing to the primary store on every single search submission means
// one DB write per request. Under typeahead-scale traffic that is wasteful,
// especially because the same query is often searched many times in a short
// window.
//
// Approach (buffer + aggregate + flush):
//   - Each submitted query is added to an in-memory buffer that AGGREGATES by
//     query: 1000 searches for "iphone" in a window become a single entry with
//     count=1000 (and the latest timestamp), i.e. ONE write instead of 1000.
//   - The buffer is flushed when EITHER it reaches `maxBatchSize` distinct
//     queries OR `flushIntervalMs` elapses (size- and time-based trigger).
//   - On flush we apply each aggregated entry to the store + Trie + recency
//     layer, invalidate the affected cache prefixes, and clear the buffer.
//
// Write reduction = (raw submissions received) / (actual store writes performed).
//
// Failure trade-off (must be discussed): the buffer lives only in memory. If the
// process crashes before a flush, the un-flushed window is lost — counts are
// slightly under-counted, but the system stays consistent and never double
// counts. For an approximate-popularity signal that is an acceptable trade; a
// production system wanting durability would write the buffer to an append-only
// log / durable queue (e.g. Kafka) before acknowledging, at the cost of latency.

export class BatchWriter {
  constructor({ store, trie, recency, cache, engine, metrics, maxBatchSize, flushIntervalMs }) {
    this.store = store;
    this.trie = trie;
    this.recency = recency;
    this.cache = cache;
    this.engine = engine;
    this.metrics = metrics;
    this.maxBatchSize = maxBatchSize;
    this.flushIntervalMs = flushIntervalMs;

    /** @type {Map<string,{count:number,lastTs:number}>} */
    this.buffer = new Map();
    this.rawSubmissions = 0; // total events ever buffered
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush('timer'), this.flushIntervalMs);
    // Don't keep the event loop alive solely for the flush timer.
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Record a search submission. Returns immediately — the durable write happens
  // asynchronously on the next flush.
  add(query, now = Date.now()) {
    this.rawSubmissions++;
    const cur = this.buffer.get(query);
    if (cur) {
      cur.count++;
      cur.lastTs = now;
    } else {
      this.buffer.set(query, { count: 1, lastTs: now });
    }
    // Size-based trigger.
    if (this.buffer.size >= this.maxBatchSize) this.flush('size');
  }

  // Apply the buffered, aggregated updates to the durable store and indexes.
  flush(reason = 'manual') {
    if (this.buffer.size === 0) return { flushed: 0, reason };
    const batch = this.buffer;
    this.buffer = new Map();
    const now = Date.now();

    for (const [query, agg] of batch) {
      const prev = this.store.map.get(query);
      const prevRecent = prev ? prev.recentScore : 0;
      const prevTs = prev ? prev.recentTs : 0;
      // Decay the old recency score to now, then add this window's events.
      const recentScore = this.recency.bump(prevRecent, prevTs, now, agg.count);

      // One write per distinct query, regardless of how many times it was searched.
      const rec = this.store.upsert(query, {
        delta: agg.count,
        recentScore,
        lastSearched: agg.lastTs,
      });

      // Keep the suggestion indexes in sync.
      this.trie.upsert(query, rec.count); // Trie ranks basic mode by count.
      this.engine.markActive(query, now); // add to recency/trending layer.

      // Invalidate cached suggestion results for every prefix of this query so
      // stale suggestions are not served after the count/recency changed.
      for (let i = 1; i <= query.length; i++) {
        this.cache.invalidatePrefix(query.slice(0, i));
      }
    }

    this.store.stats.batchFlushes++;
    if (this.metrics) this.metrics.recordFlush(batch.size, reason);
    return { flushed: batch.size, reason };
  }

  status() {
    return {
      bufferedDistinctQueries: this.buffer.size,
      rawSubmissions: this.rawSubmissions,
      storeWrites: this.store.stats.writes,
      batchFlushes: this.store.stats.batchFlushes,
      writeReductionFactor: this.store.stats.writes
        ? Number((this.rawSubmissions / this.store.stats.writes).toFixed(2))
        : 0,
      maxBatchSize: this.maxBatchSize,
      flushIntervalMs: this.flushIntervalMs,
    };
  }
}
