// Prefix tree (Trie) for typeahead, with a precomputed Top-K cache at every node.
//
// Why a Trie:
//   - Finding the node for a prefix is O(L) where L = prefix length, independent
//     of dataset size.
//   - Without precomputation, returning the best completions for a short prefix
//     like "i" would mean scanning every word under that subtree (could be tens
//     of thousands). That is too slow for a "type-ahead on every keystroke" path.
//
// The fix: each node stores `topK` — the K highest-scoring complete queries in
// its subtree, already sorted descending. A /suggest then becomes:
//     walk to prefix node (O(L))  ->  read its topK  (O(K))
//
// Maintaining topK on updates:
//   When one query's score changes, only the nodes on the path from the root to
//   that query's terminal node can be affected (its ancestors). We recompute
//   their topK bottom-up: a node's topK is the K-best merge of its own terminal
//   entry plus the topK heads of all its children. Because children are already
//   correct, each node recomputes in O(children * K).
//
// `score` here is generic: in basic mode it is the all-time count; the engine can
// also feed a recency-adjusted score, and the same machinery ranks by it.

class TrieNode {
  constructor() {
    this.children = new Map(); // char -> TrieNode
    this.isWord = false;
    this.word = null; // the complete query if isWord
    this.score = 0; // score of THIS word (0 if not a word)
    /** @type {{word:string,score:number}[]} */
    this.topK = []; // best K (word,score) in this subtree, sorted desc
  }
}

export class Trie {
  constructor(k = 12) {
    this.root = new TrieNode();
    this.k = k;
    this.wordCount = 0;
  }

  // Insert without maintaining topK (used during bulk build for speed).
  // Call build() afterwards to populate topK across the whole tree.
  insertRaw(word, score) {
    let node = this.root;
    for (const ch of word) {
      let next = node.children.get(ch);
      if (!next) {
        next = new TrieNode();
        node.children.set(ch, next);
      }
      node = next;
    }
    if (!node.isWord) this.wordCount++;
    node.isWord = true;
    node.word = word;
    node.score = score;
  }

  // One-time bottom-up build of every node's topK after bulk insertRaw.
  // O(total nodes * K). Done once on boot.
  build() {
    this._buildNode(this.root);
  }

  _buildNode(node) {
    const lists = [];
    for (const child of node.children.values()) {
      this._buildNode(child);
      lists.push(child.topK);
    }
    node.topK = this._merge(node, lists);
  }

  // Insert OR update a word's score and incrementally repair topK along its path.
  // O(L * children * K). Used at runtime when the batch writer applies updates.
  upsert(word, score) {
    const path = [this.root];
    let node = this.root;
    for (const ch of word) {
      let next = node.children.get(ch);
      if (!next) {
        next = new TrieNode();
        node.children.set(ch, next);
      }
      node = next;
      path.push(node);
    }
    if (!node.isWord) this.wordCount++;
    node.isWord = true;
    node.word = word;
    node.score = score;

    // Recompute topK bottom-up along the affected path only.
    for (let i = path.length - 1; i >= 0; i--) {
      const n = path[i];
      const lists = [];
      for (const child of n.children.values()) lists.push(child.topK);
      n.topK = this._merge(n, lists);
    }
  }

  // Merge a node's own word (if any) with the topK heads of its children,
  // returning the global best K, sorted by score desc (ties broken by word).
  _merge(node, childLists) {
    const candidates = [];
    if (node.isWord) candidates.push({ word: node.word, score: node.score });
    for (const list of childLists) {
      for (const item of list) candidates.push(item);
    }
    candidates.sort((a, b) =>
      b.score - a.score || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0)
    );
    return candidates.slice(0, this.k);
  }

  // Return up to `limit` best completions for `prefix`, or [] if none.
  // This is the hot read path.
  topKForPrefix(prefix, limit = this.k) {
    let node = this.root;
    for (const ch of prefix) {
      node = node.children.get(ch);
      if (!node) return [];
    }
    return node.topK.slice(0, limit);
  }
}
