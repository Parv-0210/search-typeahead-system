// Streams the (query,count) CSV into the store and builds the Trie.
//
// We read line-by-line so a large dataset (100k+ rows) never has to be held in
// memory as one giant string array beyond what the store itself keeps.

import fs from 'node:fs';
import readline from 'node:readline';

// Minimal CSV value parser: handles an optional double-quoted first field.
function parseLine(line) {
  if (line[0] === '"') {
    const end = line.indexOf('"', 1);
    const query = line.slice(1, end);
    const count = Number(line.slice(end + 2)); // skip closing quote + comma
    return { query, count };
  }
  const comma = line.lastIndexOf(',');
  if (comma === -1) return null;
  return { query: line.slice(0, comma), count: Number(line.slice(comma + 1)) };
}

export async function loadDataset(path, { store, trie }) {
  if (!fs.existsSync(path)) {
    throw new Error(
      `Dataset not found at "${path}". Run \`npm run generate\` first to create it.`
    );
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let loaded = 0;
  let first = true;
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    if (first) {
      first = false;
      if (/^query\s*,\s*count$/i.test(line)) continue; // skip header
    }
    const row = parseLine(line);
    if (!row || !row.query || !Number.isFinite(row.count)) continue;
    const query = row.query.toLowerCase();
    store.map.set(query, { count: row.count, lastSearched: 0, recentScore: 0, recentTs: 0 });
    trie.insertRaw(query, row.count);
    loaded++;
  }

  // One bottom-up pass to populate every node's precomputed Top-K.
  trie.build();
  return loaded;
}
