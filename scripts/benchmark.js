// Performance benchmark — exercises the running server and prints a report
// covering latency (incl. p95), cache hit rate, and batch write reduction.
//
// Usage: start the server (`npm start`) in one terminal, then in another:
//   node scripts/benchmark.js
// Optional: BASE=http://localhost:3000 SUGGESTS=5000 SEARCHES=5000 node scripts/benchmark.js

const BASE = process.env.BASE || 'http://localhost:3000';
const N_SUGGEST = Number(process.env.SUGGESTS) || 5000;
const N_SEARCH = Number(process.env.SEARCHES) || 5000;

const PREFIXES = [
  'i', 'ip', 'iph', 'sa', 'sam', 'mac', 'ja', 'jav', 'py', 'pyt', 're', 'rea',
  'no', 'be', 'best', 'how', 'ch', 'che', 'do', 'doc', 'ku', 'aws', 'rt', 'ps',
];
const QUERIES = [
  'iphone', 'iphone 15', 'iphone charger', 'java tutorial', 'macbook pro',
  'python for beginners', 'react tutorial', 'best laptop 2025', 'docker guide',
  'system design interview questions',
];

function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
function pct(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

async function get(path) {
  const t0 = performance.now();
  const r = await fetch(`${BASE}${path}`);
  await r.json();
  return performance.now() - t0;
}

async function run() {
  console.log(`Benchmarking ${BASE}`);
  console.log(`  ${N_SUGGEST} /suggest requests, ${N_SEARCH} /search submissions\n`);

  // Warm caches a little with a first pass, then measure.
  const latencies = [];
  for (let i = 0; i < N_SUGGEST; i++) {
    const ms = await get(`/api/suggest?q=${encodeURIComponent(pick(PREFIXES))}&mode=enhanced`);
    latencies.push(ms);
  }
  latencies.sort((a, b) => a - b);

  // Fire search submissions (these are buffered + batched server-side).
  for (let i = 0; i < N_SEARCH; i++) {
    await fetch(`${BASE}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: pick(QUERIES) }),
    });
  }
  // Force a final flush so write stats are settled.
  await fetch(`${BASE}/api/admin/flush`, { method: 'POST' });

  const metrics = await (await fetch(`${BASE}/api/metrics`)).json();
  const avg = latencies.reduce((s, v) => s + v, 0) / latencies.length;

  console.log('=== /suggest latency (client-side RTT, ms) ===');
  console.log(`  avg  : ${avg.toFixed(3)}`);
  console.log(`  p50  : ${pct(latencies, 50).toFixed(3)}`);
  console.log(`  p95  : ${pct(latencies, 95).toFixed(3)}`);
  console.log(`  p99  : ${pct(latencies, 99).toFixed(3)}`);
  console.log(`  max  : ${latencies[latencies.length - 1].toFixed(3)}`);

  console.log('\n=== server-reported /suggest latency ===');
  console.log(`  p50 ${metrics.latency.p50Ms}ms · p95 ${metrics.latency.p95Ms}ms · p99 ${metrics.latency.p99Ms}ms`);

  console.log('\n=== cache ===');
  console.log(`  hit rate : ${(metrics.cache.hitRate * 100).toFixed(1)}%`);
  console.log(`  hits/misses : ${metrics.cache.hits}/${metrics.cache.misses}`);
  console.log(`  evictions/expirations : ${metrics.cache.evictions}/${metrics.cache.expirations}`);

  console.log('\n=== consistent-hash key distribution (a..z sample) ===');
  console.log('  ' + JSON.stringify(metrics.ring.sampleDistribution));

  console.log('\n=== batch writes ===');
  console.log(`  raw submissions : ${metrics.batch.rawSubmissions}`);
  console.log(`  store writes    : ${metrics.store.writes}`);
  console.log(`  batch flushes   : ${metrics.store.batchFlushes}`);
  console.log(`  write reduction : ${metrics.batch.writeReductionFactor}× fewer writes than naive per-request`);
  console.log(`  store reads     : ${metrics.store.reads}`);
  console.log('\nDone.');
}

run().catch((e) => {
  console.error('Benchmark failed (is the server running?):', e.message);
  process.exit(1);
});
