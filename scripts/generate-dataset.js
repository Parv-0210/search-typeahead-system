// Generates a synthetic but realistic search-query dataset.
//
// Why synthetic: the assignment allows any dataset with a (query, count) shape.
// Generating one keeps the repo self-contained and reproducible, and lets us
// guarantee the >= 100,000-query minimum without shipping a large binary blob.
//
// The counts follow a Zipf-like distribution (a few very popular queries, a long
// tail of rare ones) which mirrors real search traffic and makes the
// "sort by count" behaviour visually obvious in the demo.
//
// Usage:  node scripts/generate-dataset.js [targetCount]

import fs from 'node:fs';
import path from 'node:path';

const TARGET = Number(process.argv[2]) || 120_000;
const OUT = path.resolve('data/queries.csv');

// A deterministic PRNG so regenerating gives a stable dataset (good for demos).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);

const heads = [
  'iphone', 'samsung galaxy', 'macbook', 'java', 'python', 'react', 'node js',
  'best laptop', 'how to', 'cheap flights', 'pizza near', 'weather', 'bitcoin',
  'world cup', 'netflix', 'amazon', 'youtube', 'instagram', 'chatgpt', 'openai',
  'used car', 'home loan', 'stock price', 'recipe for', 'movie', 'song lyrics',
  'data structures', 'system design', 'leetcode', 'docker', 'kubernetes',
  'aws certification', 'gpu', 'rtx 4090', 'ps5', 'xbox', 'nintendo switch',
  'air jordan', 'nike', 'adidas', 'coffee maker', 'air fryer', 'smart tv',
  'wireless earbuds', 'mechanical keyboard', 'standing desk', 'ergonomic chair',
];

const modifiers = [
  'review', 'price', 'vs', 'near me', 'online', 'tutorial', 'for beginners',
  '2024', '2025', 'pro', 'max', 'mini', 'cheap', 'best', 'used', 'specs',
  'release date', 'deals', 'discount', 'amazon', 'india', 'usa', 'reddit',
  'comparison', 'alternatives', 'download', 'free', 'with case', 'charger',
  'battery life', 'how to use', 'setup', 'guide', 'pdf', 'github', 'example',
];

const tails = [
  '', 'in 2025', 'step by step', 'youtube', 'explained', 'crash course',
  'interview questions', 'cheat sheet', 'documentation', 'stack overflow',
];

function pick(arr) {
  return arr[Math.floor(rand() * arr.length)];
}

// Zipf-ish count: rank-based with noise. Rank 1 ~ 100k, decaying.
function zipfCount(rank) {
  const base = 100_000 / Math.pow(rank + 1, 0.55);
  const noise = 0.7 + rand() * 0.6;
  return Math.max(1, Math.round(base * noise));
}

console.log(`Generating ~${TARGET.toLocaleString()} unique queries...`);

const seen = new Set();
const rows = [];

function addQuery(q) {
  q = q.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!q || seen.has(q)) return false;
  seen.add(q);
  rows.push(q);
  return true;
}

// Seed with a few hand-picked rows that match the assignment's example so the
// demo output is recognisable.
['iphone', 'iphone 15', 'iphone charger', 'java tutorial'].forEach(addQuery);

let guard = 0;
while (rows.length < TARGET && guard < TARGET * 40) {
  guard++;
  const shape = rand();
  let q;
  if (shape < 0.45) {
    q = `${pick(heads)} ${pick(modifiers)}`;
  } else if (shape < 0.8) {
    q = `${pick(heads)} ${pick(modifiers)} ${pick(tails)}`;
  } else {
    q = `${pick(heads)} ${pick(modifiers)} ${pick(modifiers)} ${pick(tails)}`;
  }
  addQuery(q);
}

// Assign counts: sort by a random priority so popularity isn't alphabetical,
// then rank-assign Zipf counts.
const shuffled = rows
  .map((q) => ({ q, p: rand() }))
  .sort((a, b) => a.p - b.p);

const out = ['query,count'];
shuffled.forEach((item, i) => {
  const count = zipfCount(i);
  // CSV-escape queries that contain a comma (none currently, but be safe).
  const q = item.q.includes(',') ? `"${item.q}"` : item.q;
  out.push(`${q},${count}`);
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out.join('\n'), 'utf8');

console.log(`Wrote ${shuffled.length.toLocaleString()} queries to ${OUT}`);
console.log('Sample:');
console.log(out.slice(0, 6).join('\n'));
