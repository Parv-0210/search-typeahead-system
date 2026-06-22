// Metrics — latency percentiles for /suggest plus flush bookkeeping.
//
// We keep a bounded ring buffer of recent /suggest latencies (in milliseconds)
// and compute p50 / p95 / p99 on demand by sorting a copy. A ring buffer keeps
// memory constant under sustained load while still reflecting recent behaviour.

export class Metrics {
  constructor(windowSize = 5_000) {
    this.windowSize = windowSize;
    this.suggestLatencies = []; // ring buffer of recent latencies (ms)
    this.idx = 0;
    this.suggestRequests = 0;
    this.flushes = 0;
    this.lastFlush = null;
  }

  recordSuggestLatency(ms) {
    this.suggestRequests++;
    if (this.suggestLatencies.length < this.windowSize) {
      this.suggestLatencies.push(ms);
    } else {
      this.suggestLatencies[this.idx] = ms;
      this.idx = (this.idx + 1) % this.windowSize;
    }
  }

  recordFlush(size, reason) {
    this.flushes++;
    this.lastFlush = { size, reason, at: new Date().toISOString() };
  }

  _percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const rank = Math.ceil((p / 100) * sorted.length) - 1;
    const i = Math.min(sorted.length - 1, Math.max(0, rank));
    return Number(sorted[i].toFixed(3));
  }

  latency() {
    const sorted = [...this.suggestLatencies].sort((a, b) => a - b);
    const sum = sorted.reduce((s, v) => s + v, 0);
    return {
      samples: sorted.length,
      avgMs: sorted.length ? Number((sum / sorted.length).toFixed(3)) : 0,
      p50Ms: this._percentile(sorted, 50),
      p95Ms: this._percentile(sorted, 95),
      p99Ms: this._percentile(sorted, 99),
      maxMs: sorted.length ? Number(sorted[sorted.length - 1].toFixed(3)) : 0,
    };
  }
}
