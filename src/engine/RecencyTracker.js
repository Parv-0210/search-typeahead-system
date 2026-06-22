// Recency tracker — the "trending" / recency-aware layer (the +20% feature).
//
// Goal: recently searched queries should rank higher than their all-time count
// alone would suggest, WITHOUT permanently over-ranking a query that was popular
// once and then went quiet.
//
// How recent activity is tracked:
//   Each query carries a `recentScore` that uses exponential time decay. When a
//   query is searched at time t, we first decay its existing score to t, then add
//   1 for the new event:
//       decay(s, dt) = s * 0.5 ^ (dt / halfLife)
//       recentScore  = decay(recentScore, now - lastTs) + 1
//   A half-life means: with no further searches, the boost halves every
//   `halfLifeMs`. So old bursts fade automatically — that is what stops permanent
//   over-ranking.
//
// How it affects ranking (enhanced mode):
//       finalScore = popularityWeight * log10(1 + count)
//                  + recencyWeight    * decayedRecentScore(now)
//   Using log10(count) compresses the huge dynamic range of all-time counts so a
//   genuine recent surge can actually move an item up the list, while a hugely
//   popular evergreen query still ranks well.
//
// Trade-offs (freshness vs latency vs complexity):
//   - We only re-decay lazily (at read time / on update), never with a background
//     sweep, so there is no continuous CPU cost — cheap, but a query's stored
//     score is "as of its last touch" until read.
//   - The trending set is kept small (only recently active queries), so scanning
//     it per request is negligible.

export class RecencyTracker {
  constructor({ halfLifeMs, popularityWeight, recencyWeight }) {
    this.halfLifeMs = halfLifeMs;
    this.popularityWeight = popularityWeight;
    this.recencyWeight = recencyWeight;
    // Decay constant for s * e^(-lambda*dt). Equivalent to 0.5^(dt/halfLife).
    this.lambda = Math.LN2 / halfLifeMs;
  }

  // Decay a stored score from its timestamp up to `now`.
  decay(score, fromTs, now) {
    if (!score || !fromTs) return 0;
    const dt = Math.max(0, now - fromTs);
    return score * Math.exp(-this.lambda * dt);
  }

  // Fold a fresh search event (count `times`) into an existing recency state.
  // Returns the new recentScore as-of `now`.
  bump(prevScore, prevTs, now, times = 1) {
    return this.decay(prevScore, prevTs, now) + times;
  }

  // Combined score used by enhanced ranking and trending.
  combinedScore(record, now) {
    const popularity = this.popularityWeight * Math.log10(1 + (record.count || 0));
    const recency =
      this.recencyWeight *
      this.decay(record.recentScore || 0, record.recentTs || 0, now);
    return popularity + recency;
  }
}
