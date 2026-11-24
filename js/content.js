/* ==========================================================================
   content.js — load the content library and choose ONE result per ritual.

   Contract (see main.js)
     loadContent(url) → { pick({ intention, question }), commit(result) }
       pick()   chooses a result. It never records anything, except that it
                recycles a pool that has been fully seen.
       commit() records the result as "seen" for this browser session.

   How a result is chosen (all knobs live in data/results.json → "algorithm")
     1. Score   topic match +topicWeight · universal +universalWeight (topic
                selected) · every result +openBaseWeight ("What Awaits?")
                + tagWeight per Context Tag found in the question (max 2 tags)
     2. Unseen  results already shown this session are skipped; when a pool is
                exhausted it is recycled, and the last result is never repeated
     3. Theme   a result with the same theme as the previous one is damped
     4. Draw    weighted random among the top-K, using crypto.getRandomValues
                (hold duration plays NO part: it only drives animation)
     5. Surprise with probability outsideTopicChance the result comes from
                another topic instead

   Privacy: the question is matched in memory and thrown away. Only result IDs
   and the last theme are kept, in sessionStorage (cleared when the tab closes).
   ========================================================================== */

/* ---------- Helpers ---------- */

/** Lowercase, strip diacritics (incl. đ), keep a-z0-9, pad with spaces for whole-word matching. */
const norm = (s) =>
  ` ${String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, ' ').trim()} `;

function secureRandom() {
  const c = globalThis.crypto;
  if (c && c.getRandomValues) {
    const a = new Uint32Array(1);
    c.getRandomValues(a);
    return a[0] / 4294967296;
  }
  return Math.random();
}

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

function defaultStorage() {
  try {
    const s = globalThis.sessionStorage;
    s.setItem('wonderbook.probe', '1');
    s.removeItem('wonderbook.probe');
    return s;
  } catch {
    return memoryStorage(); // private mode / blocked storage: still works, just per page load
  }
}

function validate(data) {
  if (!data || !Array.isArray(data.results) || !data.results.length) throw new Error('results.json: no results');
  if (!data.algorithm) throw new Error('results.json: missing "algorithm"');
  const ids = new Set();
  for (const r of data.results) {
    if (!r.id || ids.has(r.id)) throw new Error(`results.json: missing or duplicate id "${r.id}"`);
    ids.add(r.id);
    for (const field of ['message', 'meaning', 'guidance']) {
      if (!r[field] || !r[field].vi || !r[field].en) throw new Error(`results.json: ${r.id}.${field} needs vi and en`);
    }
    for (const t of r.tags || []) {
      if (!data.keywords[t]) console.warn(`[content] ${r.id}: tag "${t}" has no keywords`);
    }
  }
}

/* ---------- Core (pure of the DOM, so it can be unit-tested in Node) ---------- */

export function createContent(data, { storage = defaultStorage(), random = secureRandom } = {}) {
  validate(data);
  const cfg = data.algorithm;
  const results = data.results;
  const byId = new Map(results.map((r) => [r.id, r]));
  const keywordIndex = Object.entries(data.keywords).map(([tag, words]) => [
    tag, [...(words.vi || []), ...(words.en || [])].map(norm),
  ]);

  /* --- session memory --- */
  let session = { seen: new Set(), lastTheme: null, lastId: null };
  try {
    const saved = JSON.parse(storage.getItem(cfg.sessionKey) || 'null');
    if (saved && Array.isArray(saved.seen)) {
      session = {
        seen: new Set(saved.seen.filter((id) => byId.has(id))),
        lastTheme: saved.lastTheme ?? null,
        lastId: byId.has(saved.lastId) ? saved.lastId : null,
      };
    }
  } catch { /* corrupt or unavailable: start fresh */ }

  const save = () => {
    try {
      storage.setItem(cfg.sessionKey, JSON.stringify({
        seen: [...session.seen], lastTheme: session.lastTheme, lastId: session.lastId,
      }));
    } catch { /* ignore */ }
  };

  /* --- Context Tags: question → set of tags (whole-word, diacritic-insensitive, both languages) --- */
  function matchTags(question) {
    const text = norm(question || '');
    const found = new Set();
    if (text.trim() === '') return found;
    for (const [tag, words] of keywordIndex) {
      if (words.some((w) => w.trim() !== '' && text.includes(w))) found.add(tag);
    }
    return found;
  }

  const tagBonus = (r, tags) =>
    Math.min((r.tags || []).filter((t) => tags.has(t)).length, cfg.maxTagMatches) * cfg.tagWeight;

  /* --- weighted random --- */
  function weightedPick(items) {
    const total = items.reduce((s, x) => s + x.w, 0);
    let roll = random() * total;
    for (const x of items) { roll -= x.w; if (roll <= 0) return x.r; }
    return items[items.length - 1].r;
  }

  /* --- steps 2–4 over a scored candidate list --- */
  function choose(scored, poolIds) {
    let pool = scored.filter((x) => !session.seen.has(x.r.id));
    if (!pool.length) { // pool exhausted → recycle it
      poolIds.forEach((id) => session.seen.delete(id));
      pool = scored.slice();
    }
    if (pool.length > 1) pool = pool.filter((x) => x.r.id !== session.lastId); // never twice in a row

    pool = pool.map((x) => ({
      r: x.r,
      w: x.w * (x.r.theme === session.lastTheme ? cfg.sameThemeMultiplier : 1),
    }));

    // top-K by weight, ties broken randomly
    pool.sort((a, b) => b.w - a.w || random() - 0.5);
    return weightedPick(pool.slice(0, cfg.topK));
  }

  /* --- public API --- */
  function pick({ intention, question } = {}) {
    const tags = matchTags(question);
    const topicMode = data.topics.includes(intention);
    if (!topicMode && intention !== 'open') console.warn(`[content] unknown intention "${intention}", treating as open`);

    const baseWeight = (r) => {
      if (!topicMode) return cfg.openBaseWeight;
      if (r.topics.includes(intention)) return cfg.topicWeight;
      return r.universal ? cfg.universalWeight : 0;
    };
    const scored = results
      .map((r) => ({ r, w: baseWeight(r) + tagBonus(r, tags) }))
      .filter((x) => x.w > 0);
    const poolIds = scored.map((x) => x.r.id);

    // Step 5: occasionally step outside the chosen topic
    if (topicMode && random() < cfg.outsideTopicChance) {
      const outside = results
        .filter((r) => !r.universal && !r.topics.includes(intention) && !session.seen.has(r.id))
        .map((r) => ({ r, w: 1 + tagBonus(r, tags) }));
      if (outside.length) return choose(outside, outside.map((x) => x.r.id));
    }
    return choose(scored, poolIds);
  }

  function commit(result) {
    if (!result || !byId.has(result.id)) return;
    session.seen.add(result.id);
    session.lastTheme = result.theme;
    session.lastId = result.id;
    save();
  }

  return { pick, commit };
}

/* ---------- Browser entry ---------- */

export async function loadContent(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return createContent(await res.json());
}
