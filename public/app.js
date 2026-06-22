// Frontend logic: debounced suggestions, keyboard navigation, search submission,
// trending + live metrics refresh.

const $ = (id) => document.getElementById(id);
const input = $('search');
const list = $('suggestions');
const statusEl = $('status');
const resultCard = $('result');
const resultBody = $('resultBody');
const cacheInfo = $('cacheInfo');
const modeSel = $('mode');

let activeIndex = -1; // highlighted suggestion for keyboard nav
let currentSuggestions = [];
let lastRequestId = 0; // guards against out-of-order responses

// --- Debounce: avoid a backend call on every keystroke -----------------------
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// --- Fetch + render suggestions ---------------------------------------------
async function fetchSuggestions() {
  const q = input.value;
  if (!q.trim()) {
    hideList();
    statusEl.textContent = '';
    return;
  }
  const mode = modeSel.value;
  const reqId = ++lastRequestId;
  try {
    const t0 = performance.now();
    const res = await fetch(`/api/suggest?q=${encodeURIComponent(q)}&mode=${mode}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (reqId !== lastRequestId) return; // a newer keystroke already fired
    const rtt = (performance.now() - t0).toFixed(1);

    currentSuggestions = data.suggestions || [];
    renderList(currentSuggestions, data.prefix);

    statusEl.classList.remove('error');
    statusEl.textContent = currentSuggestions.length
      ? `${currentSuggestions.length} suggestions · ${data.source} · server ${data.latencyMs}ms · rtt ${rtt}ms`
      : 'No matches';
    renderCacheInfo(data);
  } catch (err) {
    if (reqId !== lastRequestId) return;
    statusEl.classList.add('error');
    statusEl.textContent = `Error fetching suggestions: ${err.message}`;
    hideList();
  }
}

function renderList(items, prefix) {
  activeIndex = -1;
  if (!items.length) {
    hideList();
    return;
  }
  list.innerHTML = '';
  items.forEach((s, i) => {
    const li = document.createElement('li');
    li.role = 'option';
    li.dataset.index = i;

    const left = document.createElement('span');
    left.className = 'q';
    left.innerHTML = highlight(s.query, prefix);
    // Tag items that are riding a recency boost (enhanced mode only).
    if (s.score !== undefined && s.count !== undefined) {
      const popularityRank = Math.log10(1 + s.count);
      if (s.score - popularityRank > 0.6) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'trending';
        left.appendChild(badge);
      }
    }

    const right = document.createElement('span');
    right.className = 'count';
    right.textContent = (s.count ?? 0).toLocaleString();

    li.append(left, right);
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      submitSearch(s.query);
    });
    list.appendChild(li);
  });
  list.hidden = false;
}

function highlight(text, prefix) {
  const safe = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  if (prefix && safe.toLowerCase().startsWith(prefix.toLowerCase())) {
    return `<b>${safe.slice(0, prefix.length)}</b>${safe.slice(prefix.length)}`;
  }
  return safe;
}

function renderCacheInfo(data) {
  const tag = data.source === 'cache'
    ? '<span class="tag-hit">HIT</span>'
    : '<span class="tag-miss">MISS</span>';
  cacheInfo.innerHTML = `prefix "<b>${data.prefix}</b>" → node <b>${data.node}</b> · ${tag}`;
}

function hideList() {
  list.hidden = true;
  list.innerHTML = '';
  activeIndex = -1;
}

// --- Keyboard navigation -----------------------------------------------------
input.addEventListener('keydown', (e) => {
  const n = currentSuggestions.length;
  if (e.key === 'ArrowDown' && !list.hidden) {
    e.preventDefault();
    activeIndex = (activeIndex + 1) % n;
    paintActive();
  } else if (e.key === 'ArrowUp' && !list.hidden) {
    e.preventDefault();
    activeIndex = (activeIndex - 1 + n) % n;
    paintActive();
  } else if (e.key === 'Enter') {
    const q = activeIndex >= 0 ? currentSuggestions[activeIndex].query : input.value;
    submitSearch(q);
  } else if (e.key === 'Escape') {
    hideList();
  }
});

function paintActive() {
  [...list.children].forEach((li, i) => li.classList.toggle('active', i === activeIndex));
  if (activeIndex >= 0) {
    input.value = currentSuggestions[activeIndex].query;
    list.children[activeIndex].scrollIntoView({ block: 'nearest' });
  }
}

// --- Search submission -------------------------------------------------------
async function submitSearch(query) {
  query = (query || '').trim();
  if (!query) return;
  input.value = query;
  hideList();
  statusEl.textContent = 'Searching…';
  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    resultBody.textContent = JSON.stringify(data, null, 2);
    resultCard.hidden = false;
    statusEl.textContent = `Submitted "${query}". Counts update on the next batch flush.`;
    // Refresh trending + metrics shortly after, once the flush lands.
    setTimeout(refreshTrending, 300);
    setTimeout(refreshMetrics, 300);
  } catch (err) {
    statusEl.classList.add('error');
    statusEl.textContent = `Search failed: ${err.message}`;
  }
}

$('searchBtn').addEventListener('click', () => submitSearch(input.value));
input.addEventListener('input', debounce(fetchSuggestions, 120));
modeSel.addEventListener('change', fetchSuggestions);
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) hideList();
});

// --- Trending ----------------------------------------------------------------
async function refreshTrending() {
  try {
    const res = await fetch('/api/trending');
    const { trending } = await res.json();
    const ol = $('trending');
    ol.innerHTML = '';
    if (!trending.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No trending searches yet — submit a few searches.';
      ol.appendChild(li);
      return;
    }
    trending.forEach((t) => {
      const li = document.createElement('li');
      li.innerHTML = `${t.query}<span class="score">↑ ${t.recencyScore}</span>`;
      li.addEventListener('click', () => {
        input.value = t.query;
        fetchSuggestions();
        input.focus();
      });
      ol.appendChild(li);
    });
  } catch { /* ignore transient errors */ }
}

// --- Metrics -----------------------------------------------------------------
async function refreshMetrics() {
  try {
    const res = await fetch('/api/metrics');
    const m = await res.json();
    const cells = [
      ['Dataset', m.datasetSize.toLocaleString()],
      ['Suggest reqs', m.suggestRequests.toLocaleString()],
      ['Cache hit rate', `${(m.cache.hitRate * 100).toFixed(1)}%`],
      ['p95 latency', `${m.latency.p95Ms} ms`],
      ['p50 latency', `${m.latency.p50Ms} ms`],
      ['Store writes', m.store.writes.toLocaleString()],
      ['Raw submissions', m.batch.rawSubmissions.toLocaleString()],
      ['Write reduction', `${m.batch.writeReductionFactor}×`],
    ];
    $('metrics').innerHTML = cells
      .map(([k, v]) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}</div></div>`)
      .join('');
  } catch { /* ignore */ }
}

// Initial paint + periodic refresh.
refreshTrending();
refreshMetrics();
setInterval(refreshTrending, 4000);
setInterval(refreshMetrics, 3000);
input.focus();
