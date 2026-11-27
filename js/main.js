/* ==========================================================================
   main.js — bootstrap, central state machine, i18n, overlay manager, stars.

   This is the ONLY file that owns app state. Feature modules never import
   each other; each receives the shared `app` object and talks through it.

   STATE MACHINE   home ──select()──▶ ready ──beginRitual()──▶ ritual
                    ▲                   ▲                         │
                    │                   └────abortRitual()────────┤
                    └────────reset()──── result ◀──finishRitual()─┘

   MODULE CONTRACTS (files still to be written must follow these)
     content.js  export async function loadContent(url) → {
                   pick({ intention, question }) → result   // pure: no side effects
                   commit(result)                           // record as "seen" this session
                 }
                 result = { id, message, meaning, guidance }  each {vi, en}
     home.js     export function initHome(app)      renders #intentions and #ask,
                   calls app.select(id) / sets app.question, opens the "fun" modal
     book.js     export function initBook(app)      builds #book-scene, runs the ritual;
                   calls app.beginRitual() on the first page flip, then
                   app.finishRitual() once pages settle, or app.abortRitual();
                   owns the stage classes is-active / is-open
     result.js   export function initResult(app)    shows #result on state "result",
                   builds the Share Card; "New Ritual" calls app.reset()

   EVENTS (app.on)   'state' {state, prev} · 'lang' lang · 'intention' id · 'reset' ·
                     'needtopic' (the book was pressed before an intention was chosen)
   ========================================================================== */

import { loadContent } from './content.js';
import { initHome } from './home.js';
import { initBook } from './book.js';
import { initResult } from './result.js';
import { initSound } from './sound.js';

/* ---------- Small helpers ---------- */

const $ = (sel, root = document) => root.querySelector(sel);

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

const debounce = (fn, ms) => {
  let id;
  return (...args) => { clearTimeout(id); id = setTimeout(() => fn(...args), ms); };
};

/* Developer-facing failure (not product copy, so it is intentionally not in ui.json) */
function showFatal(err) {
  console.error('[WonderBook]', err);
  const p = document.createElement('p');
  p.style.cssText = 'position:relative;z-index:5;max-width:420px;margin:30vh auto 0;padding:0 24px;' +
    'text-align:center;font:16px/1.6 system-ui,sans-serif;color:#b3bad0';
  p.textContent = location.protocol === 'file:'
    ? 'WonderBook cần chạy qua một local server (ví dụ: npx serve). / WonderBook must be served over HTTP (e.g. npx serve).'
    : 'Không thể tải nội dung. Vui lòng tải lại trang. / Could not load content. Please reload.';
  document.body.append(p);
}

/* ---------- Stars (twinkle layer over the background photo) ---------- */

function initStars(canvas) {
  const ctx = canvas.getContext('2d');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let w = 0, h = 0, stars = [], raf = 0;

  function draw(t) {
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      const a = reduceMotion.matches ? 0.4 : 0.15 + 0.5 * Math.max(0, Math.sin(t / 1500 + s.phase));
      ctx.fillStyle = `rgba(235, 240, 255, ${a})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function loop(t) { draw(t); raf = requestAnimationFrame(loop); }

  function start() {
    cancelAnimationFrame(raf);
    if (reduceMotion.matches || document.hidden) draw(0);
    else raf = requestAnimationFrame(loop);
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth; h = window.innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    stars = Array.from({ length: Math.round((w * h) / 22000) }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      r: Math.random() + 0.3, phase: Math.random() * Math.PI * 2,
    }));
    start();
  }

  window.addEventListener('resize', debounce(resize, 200));
  document.addEventListener('visibilitychange', start);
  reduceMotion.addEventListener('change', start);
  resize();
}

/* ---------- Boot ---------- */

async function main() {
  const [ui, content] = await Promise.all([
    fetchJson('data/ui.json'),
    loadContent('data/results.json'),
  ]);

  const appEl = $('#app');
  const stageEl = $('#stage');
  const { supported, storageKey } = ui.languages;
  const defaultLang = ui.languages.default;

  /* ----- i18n ----- */
  let lang = defaultLang;
  try {
    const saved = localStorage.getItem(storageKey);
    if (supported.includes(saved)) lang = saved;
  } catch { /* storage unavailable: stay on default */ }

  /** {vi, en} object → string in the current language (plain strings pass through). */
  const tr = (v) => (v == null ? '' : typeof v === 'string' ? v : v[lang] ?? v[defaultLang] ?? '');

  /** 'home.sectionTitle' → string in the current language, resolved from data/ui.json. */
  const t = (path) => {
    const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), ui);
    if (v == null) console.warn(`[i18n] missing key: ${path}`);
    return tr(v);
  };

  /** Apply data-i18n / data-i18n-attr="attr:path;attr2:path2" inside `root`. */
  function applyI18n(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      el.dataset.i18nAttr.split(';').forEach((pair) => {
        const [attr, path] = pair.split(':');
        if (attr && path) el.setAttribute(attr.trim(), t(path.trim()));
      });
    });
  }

  /* ----- events ----- */
  const handlers = {};
  const on = (name, fn) => {
    (handlers[name] ||= []).push(fn);
    return () => { handlers[name] = handlers[name].filter((f) => f !== fn); };
  };
  const emit = (name, detail) => {
    (handlers[name] || []).slice().forEach((fn) => {
      try { fn(detail); } catch (err) { console.error(`[WonderBook] "${name}" handler failed`, err); }
    });
  };

  /* ----- state ----- */
  let state = 'home';
  let intention = null;
  let question = '';
  let result = null;

  function setState(next) {
    if (next === state) return;
    const prev = state;
    state = next;
    document.body.dataset.state = state;
    stageEl.classList.toggle('is-ready', state !== 'home');
    emit('state', { state, prev });
  }

  const isSelectable = (id) => ui.intentions.some((i) => i.id === id && i.type !== 'fun');

  function select(id) {
    if ((state !== 'home' && state !== 'ready') || !isSelectable(id)) return false;
    intention = id;
    emit('intention', id);
    setState('ready');
    return true;
  }

  /** One ritual produces one result: it is locked here, before any page flips. */
  function beginRitual() {
    if (state !== 'ready') return false;
    result = content.pick({ intention, question: question.trim() });
    setState('ritual');
    return true;
  }

  function finishRitual() {
    if (state !== 'ritual' || !result) return;
    content.commit(result);
    setState('result');
  }

  function abortRitual() {
    if (state !== 'ritual') return;
    result = null;
    setState('ready');
  }

  /** "New Ritual": back to a clean Home. The question is discarded, never stored. */
  function reset() {
    intention = null; question = ''; result = null;
    emit('reset');
    setState('home');
  }

  /** The book was pressed while no intention is chosen: let the modules that can guide the user react. */
  const needTopic = () => { if (state === 'home') emit('needtopic'); };

  /* ----- language ----- */
  function setLang(next) {
    if (!supported.includes(next) || next === lang) return;
    lang = next;
    try { localStorage.setItem(storageKey, lang); } catch { /* ignore */ }
    document.documentElement.lang = lang;
    document.title = `${t('brand.name')} — ${t('brand.tagline')}`;
    applyI18n();
    emit('lang', lang); // interaction state is untouched: only copy is re-rendered
  }

  /* ----- overlays: focus trap, Escape, inert background, focus restore ----- */
  const FOCUSABLE = 'button:not([hidden]):not([disabled]), input:not([hidden]):not([disabled])';
  const overlays = [];

  function trap(e) {
    const top = overlays[overlays.length - 1];
    if (!top || e.currentTarget !== top.el) return;
    if (e.key === 'Escape' && top.onEscape) { e.preventDefault(); top.onEscape(); return; }
    if (e.key !== 'Tab') return;
    const items = [...top.el.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
    if (!items.length) { e.preventDefault(); top.el.focus(); return; }
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === top.el)) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  }

  function openOverlay(el, { onEscape } = {}) {
    if (overlays.some((o) => o.el === el)) return;
    const below = overlays[overlays.length - 1];
    (below ? below.el : appEl).inert = true;
    overlays.push({ el, onEscape, returnFocus: document.activeElement });
    el.hidden = false;
    el.addEventListener('keydown', trap);
    requestAnimationFrame(() => el.focus({ preventScroll: true }));
  }

  function closeOverlay(el) {
    const i = overlays.findIndex((o) => o.el === el);
    if (i < 0) return;
    const [{ returnFocus }] = overlays.splice(i, 1);
    el.removeEventListener('keydown', trap);
    el.hidden = true;
    const top = overlays[overlays.length - 1];
    (top ? top.el : appEl).inert = false;
    if (!top && returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
  }

  /* ----- the shared object handed to every feature module ----- */
  const app = {
    ui,
    content,
    t, tr, applyI18n,
    on,
    select, beginRitual, finishRitual, abortRitual, reset, needTopic,
    setLang,
    overlay: { open: openOverlay, close: closeOverlay },
    get lang() { return lang; },
    get state() { return state; },
    get intention() { return intention; },
    get result() { return result; },
    get question() { return question; },
    set question(value) { question = String(value ?? ''); },
  };

  /* ----- start ----- */
  document.documentElement.lang = lang;
  document.title = `${t('brand.name')} — ${t('brand.tagline')}`;
  document.body.dataset.state = state;
  applyI18n();

  $('#lang-toggle').addEventListener('click', () => setLang(lang === 'vi' ? 'en' : 'vi'));
  initStars($('#stars'));

  app.sound = initSound(app); // optional sound; book.js and result.js call app.sound.flip() / .chime()
  initHome(app);
  initBook(app);
  initResult(app);

  // Warm the Result Screen background so it never flashes in during the reveal.
  const warm = () => { new Image().src = 'assets/bg-reveal.jpg'; };
  (window.requestIdleCallback || ((fn) => setTimeout(fn, 800)))(warm);
}

main().catch(showFatal);
