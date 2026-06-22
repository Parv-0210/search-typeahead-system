// SuggestionEngine — turns a prefix into a ranked list of suggestions.
//
// It owns:
//   - the Trie (historical popularity, ranked by all-time count)
//   - a "recent activity" set (queries touched recently, for the recency layer
//     and for the /trending endpoint)
//
// Basic mode (60% feature):
//     suggestions = Trie.topKForPrefix(prefix) sorted by all-time count.
//
// Enhanced mode (the +20% recency-aware feature):
//     candidate pool = Trie top-K for the prefix          (popular completions)
//                    ∪ recently-active queries matching the prefix (fresh ones)
//     each candidate is re-scored with RecencyTracker.combinedScore and the
//     best `limit` are returned. This mirrors real systems: a stable popular
//     index plus a small, fast-moving recency overlay.

export class SuggestionEngine {
  constructor({ trie, store, recency, limit }) {
    this.trie = trie;
    this.store = store;
    this.recency = recency;
    this.limit = limit;
    // query -> last activity timestamp, for recently active queries only.
    /** @type {Map<string, number>} */
    this.recentActive = new Map();
  }

  // Normalise user input: trim, collapse spaces, lower-case (case-insensitive).
  // Full trim (not just leading) so a trailing space can't fragment a query into
  // a separate key, and "iphone " still matches completions of "iphone".
  static normalize(q) {
    return (q ?? '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // Record that a query just became active (called after a batch flush).
  markActive(query, ts) {
    this.recentActive.set(query, ts);
    // Keep the recent set bounded; drop the oldest if it grows large.
    if (this.recentActive.size > 2_000) {
      const oldest = [...this.recentActive.entries()].sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < 500; i++) this.recentActive.delete(oldest[i][0]);
    }
  }

  // BASIC: pure count ordering straight from the Trie's precomputed topK.
  suggestBasic(prefix) {
    const norm = SuggestionEngine.normalize(prefix);
    if (!norm) return [];
    return this.trie
      .topKForPrefix(norm, this.limit)
      .map((e) => ({ query: e.word, count: e.score }));
  }

  // ENHANCED: re-rank a popular ∪ recent candidate pool by combined score.
  suggestEnhanced(prefix, now) {
    const norm = SuggestionEngine.normalize(prefix);
    if (!norm) return [];

    const pool = new Map(); // query -> record
    // 1) Popular completions from the Trie.
    for (const e of this.trie.topKForPrefix(norm, this.trie.k)) {
      const rec = this.store.map.get(e.word) || { count: e.score };
      pool.set(e.word, rec);
    }
    // 2) Recently active queries that also match the prefix.
    for (const q of this.recentActive.keys()) {
      if (q.startsWith(norm) && !pool.has(q)) {
        const rec = this.store.map.get(q);
        if (rec) pool.set(q, rec);
      }
    }

    return [...pool.entries()]
      .map(([query, rec]) => ({
        query,
        count: rec.count || 0,
        score: this.recency.combinedScore(rec, now),
      }))
      .sort((a, b) => b.score - a.score || b.count - a.count)
      .slice(0, this.limit);
  }

  suggest(prefix, { mode = 'enhanced', now } = {}) {
    return mode === 'basic'
      ? this.suggestBasic(prefix)
      : this.suggestEnhanced(prefix, now ?? Date.now());
  }

  // Trending = recently active queries ranked by their decayed recency score.
  trending(now, limit) {
    const out = [];
    for (const q of this.recentActive.keys()) {
      const rec = this.store.map.get(q);
      if (!rec) continue;
      const recScore = this.recency.decay(rec.recentScore, rec.recentTs, now);
      if (recScore <= 0.01) continue;
      out.push({ query: q, count: rec.count, recencyScore: Number(recScore.toFixed(3)) });
    }
    return out.sort((a, b) => b.recencyScore - a.recencyScore).slice(0, limit);
  }
}
