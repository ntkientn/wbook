/* ==========================================================================
   result.js — the Result Screen and the Share Card.

   Owns       #result, #share
   Talks to   app.result · app.overlay · app.reset() · app.on(...)
   Reacts to  'state' (open on "result", close when leaving it) · 'lang'

   - Fills Message / Meaning / Guidance in the current language. Switching
     language while the result is on screen swaps the words only: the same
     result stays, and the reveal animation (css/result.css) does not restart.
   - Share Card: painted on a 1080×1350 canvas (4:5), exported as PNG. It holds
     the result and the brand only: never the question, topic or tags.
     Shared through the Web Share API where files are supported, otherwise saved.
   - layoutCard() is pure (it needs only a text-measuring function), so the
     worst-case text fit can be tested without a browser.
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);

/* ---------- Share Card geometry & type ---------- */

const CARD = { W: 1080, H: 1350, safeTop: 330, safeBottom: 1120, textW: 800 };
const SERIF = '"Cormorant Garamond", Georgia, "Times New Roman", serif';
const SANS = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';

/** Greedy word wrap. `measure(font, text)` → width in px. */
function wrapText(measure, font, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const test = line ? `${line} ${word}` : word;
    if (line && measure(font, test) > maxWidth) { lines.push(line); line = word; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Decide font sizes, line breaks and vertical positions so the text always fits
 * inside the safe area. Shrinks everything together until it does.
 */
export function layoutCard(measure, { message, meaning, guidance }) {
  const avail = CARD.safeBottom - CARD.safeTop;
  let result = null;

  for (let scale = 1; scale >= 0.6; scale -= 0.04) {
    // Message: as large as possible, but at most 4 lines
    let msgSize = 112 * scale, msgFont, msgLines;
    do {
      msgFont = `600 ${msgSize}px ${SERIF}`;
      msgLines = wrapText(measure, msgFont, message, CARD.textW);
      if (msgLines.length <= 4) break;
      msgSize -= 4;
    } while (msgSize > 56 * scale);

    const blocks = [
      { kind: 'message',  font: msgFont, size: msgSize, lh: msgSize * 1.08, lines: msgLines },
      { kind: 'rule',     gapBefore: 56 * scale, height: 2, gapAfter: 56 * scale },
      { kind: 'meaning',  font: `300 ${34 * scale}px ${SANS}`, size: 34 * scale, lh: 34 * scale * 1.55,
        lines: wrapText(measure, `300 ${34 * scale}px ${SANS}`, meaning, CARD.textW - 60) },
      { kind: 'guidance', gapBefore: 44 * scale, font: `italic 400 ${42 * scale}px ${SERIF}`, size: 42 * scale,
        lh: 42 * scale * 1.42, lines: wrapText(measure, `italic 400 ${42 * scale}px ${SERIF}`, guidance, CARD.textW - 40) },
    ];

    let total = 0;
    for (const b of blocks) {
      total += (b.gapBefore || 0) + (b.lines ? b.lines.length * b.lh : b.height) + (b.gapAfter || 0);
    }
    result = { blocks, total, scale, top: CARD.safeTop + Math.max(0, (avail - total) / 2), fits: total <= avail };
    if (result.fits) break;
  }

  // assign y positions
  let y = result.top;
  for (const b of result.blocks) {
    y += b.gapBefore || 0;
    b.y = y;
    y += (b.lines ? b.lines.length * b.lh : b.height) + (b.gapAfter || 0);
  }
  return result;
}

/* ---------- Canvas painting helpers ---------- */

const hexToRgba = (hex, a) => {
  const h = hex.replace('#', '').trim();
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

function seededRandom(text) { // mulberry32 seeded by the result id: the same result always gets the same sky
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) { h = Math.imul(h ^ text.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawSpaced(g, text, cx, y, spacing) { // centred, letter-spaced (works in every browser)
  const chars = [...text];
  const widths = chars.map((ch) => g.measureText(ch).width);
  let x = cx - (widths.reduce((s, w) => s + w, 0) + spacing * (chars.length - 1)) / 2;
  g.textAlign = 'left';
  chars.forEach((ch, i) => { g.fillText(ch, x, y); x += widths[i] + spacing; });
  g.textAlign = 'center';
}

async function loadCardFonts(text) {
  if (!document.fonts || !document.fonts.load) return;
  await Promise.allSettled([
    `600 100px ${SERIF}`, `500 30px ${SERIF}`, `italic 400 40px ${SERIF}`,
    `300 34px ${SANS}`, `400 24px ${SANS}`,
  ].map((f) => document.fonts.load(f, text)));
}

/* ========================================================================== */

export function initResult(app) {
  const resultEl = $('#result');
  const shareEl = $('#share');
  const cardImg = $('#share-card');
  const sendBtn = $('#share-send');
  const saveBtn = $('#share-save');

  /* ------------------------------------------------------------------
     1. Result Screen
     ------------------------------------------------------------------ */

  function renderResult() {
    const r = app.result;
    if (!r) return;
    $('#res-message').textContent = app.tr(r.message);
    $('#res-meaning').textContent = app.tr(r.meaning);
    $('#res-guidance').textContent = app.tr(r.guidance);
  }

  $('#res-reset').addEventListener('click', () => app.reset());
  $('#res-share').addEventListener('click', openShare);

  /* ------------------------------------------------------------------
     2. Share Card
     ------------------------------------------------------------------ */

  const css = (name, fallback) => getComputedStyle(shareEl).getPropertyValue(name).trim() || fallback;

  async function paintCard(result) {
    const message = app.tr(result.message);
    const meaning = app.tr(result.meaning);
    const guidance = app.tr(result.guidance);
    const brand = app.t('brand.name').toLocaleUpperCase(app.lang);
    const tagline = app.t('share.cardTagline').toLocaleUpperCase(app.lang);

    await loadCardFonts([message, meaning, guidance, brand, tagline].join(' '));

    const ink = css('--card-ink', '#060a1c'), ink2 = css('--card-ink-2', '#0e1840');
    const gold = css('--card-gold', '#c9a45c'), goldSoft = css('--card-gold-soft', '#e6c98a');
    const paper = css('--card-paper', '#efe6d0'), mist = css('--card-mist', '#9aa3bd');
    const { W, H } = CARD;

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const g = canvas.getContext('2d');

    // sky
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, ink2); sky.addColorStop(1, ink);
    g.fillStyle = sky; g.fillRect(0, 0, W, H);

    const rand = seededRandom(result.id);
    for (let i = 0; i < 160; i++) {
      g.fillStyle = `rgba(235, 240, 255, ${0.15 + rand() * 0.55})`;
      g.beginPath(); g.arc(rand() * W, rand() * H, 0.6 + rand() * 1.4, 0, Math.PI * 2); g.fill();
    }
    const glow = g.createRadialGradient(W / 2, H + 80, 0, W / 2, H + 80, 760);
    glow.addColorStop(0, hexToRgba(goldSoft, 0.26)); glow.addColorStop(1, hexToRgba(goldSoft, 0));
    g.fillStyle = glow; g.fillRect(0, 0, W, H);

    // frame
    g.strokeStyle = hexToRgba(gold, 0.55); g.lineWidth = 2; g.strokeRect(54, 54, W - 108, H - 108);
    g.strokeStyle = hexToRgba(gold, 0.22); g.lineWidth = 1; g.strokeRect(70, 70, W - 140, H - 140);
    g.fillStyle = gold;
    for (const [x, y] of [[54, 54], [W - 54, 54], [54, H - 54], [W - 54, H - 54]]) {
      g.save(); g.translate(x, y); g.rotate(Math.PI / 4); g.fillRect(-6, -6, 12, 12); g.restore();
    }

    // header
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillStyle = gold; g.font = `400 46px ${SERIF}`; g.fillText('✦', W / 2, 190);
    g.fillStyle = goldSoft; g.font = `500 30px ${SERIF}`; drawSpaced(g, brand, W / 2, 252, 11);

    // body
    g.textBaseline = 'top';
    const layout = layoutCard((font, text) => { g.font = font; return g.measureText(text).width; },
      { message, meaning, guidance });
    for (const b of layout.blocks) {
      if (b.kind === 'rule') {
        g.fillStyle = gold; g.fillRect(W / 2 - 34, b.y, 68, b.height);
        continue;
      }
      g.font = b.font;
      g.fillStyle = b.kind === 'message' ? goldSoft : b.kind === 'meaning' ? hexToRgba(paper, 0.82) : paper;
      if (b.kind === 'message') { g.shadowColor = hexToRgba(goldSoft, 0.35); g.shadowBlur = 36; }
      b.lines.forEach((line, i) => g.fillText(line, W / 2, b.y + i * b.lh));
      g.shadowBlur = 0;
    }

    // footer
    g.textBaseline = 'alphabetic';
    g.fillStyle = mist; g.font = `400 24px ${SANS}`; drawSpaced(g, tagline, W / 2, H - 128, 7);

    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  /* --- preview, save and share --- */
  let cardUrl = '';
  let cardFile = null;
  let token = 0; // ignores a card that finished painting after it stopped being wanted

  function setCard(blob) {
    if (cardUrl) URL.revokeObjectURL(cardUrl);
    cardUrl = URL.createObjectURL(blob);
    cardFile = new File([blob], `${app.ui.share.fileName}.png`, { type: 'image/png' });
    cardImg.src = cardUrl;
    cardImg.alt = app.tr(app.result.message);
    sendBtn.hidden = !(navigator.canShare && navigator.canShare({ files: [cardFile] }));
  }

  async function buildCard() {
    try { return await paintCard(app.result); }
    catch (err) { console.error('[WonderBook] share card failed', err); return null; }
  }

  async function openShare() {
    if (!app.result) return;
    const mine = ++token;
    const blob = await buildCard();
    if (!blob || mine !== token || app.state !== 'result') return;
    setCard(blob);
    app.overlay.open(shareEl, { onEscape: closeShare });
  }

  function closeShare() {
    token += 1;
    app.overlay.close(shareEl);
    if (cardUrl) { URL.revokeObjectURL(cardUrl); cardUrl = ''; }
    cardFile = null;
    cardImg.removeAttribute('src');
  }

  async function refreshShare() { // language changed while the card is open
    const mine = ++token;
    const blob = await buildCard();
    if (blob && mine === token && !shareEl.hidden) setCard(blob);
  }

  saveBtn.addEventListener('click', () => {
    if (!cardUrl) return;
    const a = document.createElement('a');
    a.href = cardUrl;
    a.download = `${app.ui.share.fileName}.png`;
    document.body.append(a);
    a.click();
    a.remove();
  });

  sendBtn.addEventListener('click', async () => {
    if (!cardFile) return;
    try { await navigator.share({ files: [cardFile], title: app.t('share.shareTitle') }); }
    catch (err) { if (err.name !== 'AbortError') console.warn('[WonderBook] share failed', err); }
  });

  $('#share-close').addEventListener('click', closeShare);
  shareEl.addEventListener('click', (e) => { if (e.target === shareEl) closeShare(); });

  /* ------------------------------------------------------------------
     3. Reacting to the app
     ------------------------------------------------------------------ */

  app.on('state', ({ state }) => {
    if (state === 'result') {
      renderResult();
      app.overlay.open(resultEl); // no Escape here: leaving a result is a deliberate "New Ritual"
    } else {
      if (!shareEl.hidden) closeShare();
      app.overlay.close(resultEl);
    }
  });

  app.on('lang', () => {
    if (app.state !== 'result') return;
    renderResult();
    if (!shareEl.hidden) refreshShare();
  });
}
