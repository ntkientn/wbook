/* ==========================================================================
   book.js — the ritual: build the 3D book, open it, flip pages, hand over.

   Owns       #book-scene, #motes, the stage classes is-active / is-open
   Talks to   app.beginRitual() · app.finishRitual() · app.state · app.on(...)
   Reacts to  'reset' (close the book for a new ritual) · 'state' (stand up / lie down) · 'needtopic'
   Styles     css/book.css defines every class created here.

   BEFORE A TOPIC IS CHOSEN the book lies flat and says nothing. Pressing it
   anyway calls app.needTopic(): the book wiggles and a short line appears
   ("Please choose a topic first"); home.js pulses the section title.
   Choosing a topic makes the book stand up and the hint appear.

   INPUT (one button, pointer or keyboard)
     press and hold      pages flip while held; release → pages slow down and settle
     tap (< 300 ms)      pages keep flipping until the next tap / press
     Enter / Space       behave like a tap (a native click with detail 0)
     released before the cover finished opening → the book simply closes again

   ONE RITUAL, ONE RESULT
     app.beginRitual() locks the result the moment the first page lifts.
     app.finishRitual() runs 450 ms after the last page has landed.
     How long the user holds never influences WHICH result appears.

   REDUCED MOTION   no 3D: the cover fades, pages dissolve one by one, no motes.
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);

/* ---------- Tuning ---------- */
const LEAF_COUNT = 12;
const TAP_MS = 300;          // shorter press = tap → continuous flipping
const OPEN_SEC = 1.1;        // cover opening
const CLOSE_SEC = 0.9;       // cover closing
const START_SPEED = 0.8;     // pages per second at the first flip
const MAX_SPEED = 5.2;
const ACCEL = 2.4;           // pages/s gained per second of holding
const DECAY = 0.1;           // speed multiplier per second after release
const STOP_BELOW = 0.7;      // below this speed, no new page starts
const FINISH_DELAY = 450;    // ms between the last page landing and the result
const LYING_TILT = 68;       // degrees: the book resting flat while no topic is chosen
const NEED_MS = 3200;        // how long "choose a topic first" stays visible

const WORDS = ('lumen stellarum nox caelum aether via tempus luna sol cor ventus mare silentium umbra ' +
  'ignis vox somnium orbis fatum spes terra aurora quies lux anima iter nubes fons aeternum ordo ' +
  'mundus vita pax').split(' ');

const EMBLEM_SVG = `<svg class="emblem" viewBox="0 0 100 100" aria-hidden="true">
  <g fill="none" stroke="currentColor" stroke-width=".7">
    <circle cx="50" cy="50" r="38"/><circle cx="50" cy="50" r="33" stroke-dasharray=".7 2.4"/>
    <circle cx="50" cy="50" r="15"/><path d="M50 8L56 44L92 50L56 56L50 92L44 56L8 50L44 44Z"/>
    <path d="M22 22L78 78M78 22L22 78" stroke-opacity=".35"/>
  </g><circle cx="50" cy="50" r="2.2" fill="currentColor"/></svg>`;

/* ---------- Small helpers ---------- */
const smooth = (x) => x * x * (3 - 2 * x);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const between = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const word = () => WORDS[Math.floor(Math.random() * WORDS.length)];
const phrase = (n) => Array.from({ length: n }, word).join(' ');
const cap = (s) => s[0].toUpperCase() + s.slice(1);

function el(cls, text) {
  const n = document.createElement('span'); // spans only: valid inside the <button>
  n.className = cls;
  if (text) n.textContent = text;
  return n;
}

/** Few Latin words shaped like a result (message / meaning / guidance). CSS blurs them. */
function fillPageText(container) {
  container.replaceChildren(
    el('pt-message', cap(phrase(between(2, 3)))),
    el('pt-rule'),
    el('pt-meaning', `${cap(phrase(between(7, 9)))}.`),
    el('pt-guidance', `${cap(phrase(between(6, 8)))}.`),
  );
}

/* ========================================================================== */

export function initBook(app) {
  const stage = $('#stage');
  const button = $('#book');
  const scene = $('#book-scene');
  const motesCanvas = $('#motes');
  const needEl = $('#hint-need');
  const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = reduceMQ.matches;

  /* ------------------------------------------------------------------
     1. Build the scene (structure documented in css/book.css)
     ------------------------------------------------------------------ */
  const textBlocks = [];
  const pageText = () => { const t = el('page-text'); textBlocks.push(t); return t; };

  const boardRight = el('board board--right');
  const boardLeft = el('board board--left');
  const pagesLeft = el('pages pages--left');
  const pagesRight = el('pages pages--right');
  pagesLeft.append(pageText());
  pagesRight.append(pageText());

  const leavesEl = el('leaves');
  const leaves = Array.from({ length: LEAF_COUNT }, () => {
    const node = el('leaf');
    const front = el('leaf-side leaf-side--front');
    const back = el('leaf-side leaf-side--back');
    front.append(pageText());
    back.append(pageText());
    node.append(front, back);
    leavesEl.append(node);
    return { node, state: 'wait', t: 0, dur: 1, age: 0, seq: 0 };
  });

  const gutter = el('gutter');
  const pageLight = el('page-light');
  const cover = el('cover');
  const coverFront = el('cover-front');
  coverFront.innerHTML = EMBLEM_SVG;
  cover.append(coverFront, el('cover-back'));

  scene.replaceChildren(boardRight, boardLeft, pagesLeft, pagesRight, leavesEl, gutter, pageLight, cover);
  scene.classList.toggle('is-reduced', reduced);
  textBlocks.forEach(fillPageText);

  /* ------------------------------------------------------------------
     2. Ritual state
     ------------------------------------------------------------------ */
  let openP = 0;              // 0 closed … 1 open
  let speed = 0;              // pages per second
  let acc = 0;                // fractional pages accumulated
  let seq = 0;                // landing order of leaves
  let flipping = false;       // the user wants pages to flip (held or toggled)
  let toggled = false;        // continuous mode after a tap
  let begun = false;          // app.beginRitual() has been called
  let closing = false;        // closing after a reset
  let leavesRecycled = false;
  let finishTimer = 0;
  let waiting = [];           // indexes of leaves resting on the right stack (top = last)
  let tilt = reduced ? 0 : app.state === 'home' ? LYING_TILT : 33; // starts lying down until a topic is chosen
  let light = 0;
  let flyingCount = 0;
  let raf = 0, last = 0;

  function resetLeaves() {
    waiting = leaves.map((_, i) => i);
    leaves.forEach((l) => { l.state = 'wait'; l.t = 0; l.age = 0; });
    textBlocks.forEach(fillPageText); // next ritual shows different pages
    seq = 0;
    leavesRecycled = true;
  }

  const canRitual = () => app.state === 'ready' || app.state === 'ritual';

  function spawn() {
    if (!waiting.length) return;
    const l = leaves[waiting.pop()];
    l.state = 'fly';
    l.t = 0;
    l.dur = Math.max(0.2, 0.95 - 0.15 * speed); // faster riffle as speed rises
  }

  function update(dt) {
    if (flipping && !canRitual()) { flipping = false; toggled = false; }

    if (flipping) {
      clearTimeout(finishTimer); finishTimer = 0;
      openP = Math.min(1, openP + dt / (reduced ? 0.3 : OPEN_SEC));
      if (openP >= 1) {
        if (!begun) {
          begun = app.beginRitual();
          if (!begun) { flipping = false; toggled = false; return; }
        }
        speed = Math.min(Math.max(speed, START_SPEED) + dt * ACCEL, MAX_SPEED);
      }
    } else {
      speed *= Math.pow(DECAY, dt);
      if (speed < STOP_BELOW) speed = 0;
      if (!begun && !closing) openP = Math.max(0, openP - dt / CLOSE_SEC); // released too early: close again
    }

    if (closing) {
      openP = Math.max(0, openP - dt / CLOSE_SEC);
      if (openP < 0.45 && !leavesRecycled) resetLeaves(); // hidden behind the cover by now
      if (openP === 0) closing = false;
    }

    acc += speed * dt;
    while (acc >= 1) { acc -= 1; spawn(); }

    // advance leaves
    flyingCount = 0;
    leaves.forEach((l, i) => {
      if (l.state === 'fly') {
        flyingCount += 1;
        l.t += dt / l.dur;
        if (l.t >= 1) {
          l.t = 1;
          if (reduced) { l.state = 'wait'; waiting.unshift(i); } // dissolved: back to the bottom of the stack
          else { l.state = 'land'; l.age = 0; l.seq = ++seq; }
        }
      } else if (l.state === 'land') {
        l.age += dt;
        if (l.age > 2.1) { l.state = 'wait'; waiting.unshift(i); }
      }
    });

    // all pages landed and the user let go → hand over to the Result Screen
    if (begun && !flipping && speed === 0 && flyingCount === 0 && app.state === 'ritual' && !finishTimer) {
      finishTimer = setTimeout(() => {
        finishTimer = 0;
        if (!flipping && app.state === 'ritual') { app.finishRitual(); wake(); }
      }, FINISH_DELAY);
    }
  }

  /* ------------------------------------------------------------------
     3. Render (writes the inline styles listed in css/book.css)
     ------------------------------------------------------------------ */
  function render(dt) {
    const o = smooth(openP);
    const active = flipping || speed > 0 || flyingCount > 0;

    let minSeq = Infinity;
    leaves.forEach((l) => { if (l.state === 'land') minSeq = Math.min(minSeq, l.seq); });

    leaves.forEach((l, i) => {
      let transform, opacity = 1, shade = 0;
      if (l.state === 'fly') {
        const e = easeInOut(l.t), s = Math.sin(Math.PI * l.t);
        if (reduced) { transform = 'translateZ(6px)'; opacity = 1 - e; }
        else { transform = `translateZ(6px) rotateY(${-180 * e}deg) skewY(${-s * 5}deg)`; shade = 0.5 * s; }
      } else if (l.state === 'land') {
        if (l.age > 1.6) opacity = Math.max(0, 1 - (l.age - 1.6) / 0.5);
        transform = `translateZ(${2 + (l.seq - minSeq) * 0.1}px) rotateY(-180deg)`;
      } else {
        transform = `translateZ(${1 + waiting.indexOf(i) * 0.12}px)`;
      }
      l.node.style.transform = transform;
      l.node.style.opacity = String(opacity);
      l.node.style.setProperty('--sh', String(shade));
    });

    // cover, tilt and position
    if (reduced) {
      cover.style.transform = 'translateZ(14px)';
      cover.style.opacity = String(1 - o);
    } else {
      cover.style.transform = `translateZ(${14 - 26 * o}px) rotateY(${-180 * o}deg)`;
      cover.style.opacity = '';
    }
    const lying = app.state === 'home' && !reduced;   // no topic yet: rest flat
    const tiltTarget = reduced ? 0 : lying ? LYING_TILT : active ? 29 : 33;
    tilt += (tiltTarget - tilt) * Math.min(1, dt * 4); // ~0.8 s to stand up or lie down
    render.tiltTarget = tiltTarget;
    const rest = Math.max(0, Math.min(1, (tilt - 33) / (LYING_TILT - 33))); // 0 standing … 1 lying
    const shift = reduced ? -25 : -25 * (1 - o);
    scene.style.transform =
      `translateY(${rest * 14}%) rotateX(${tilt}deg) translateX(${shift}%) scale(${1 - 0.08 * rest})`;

    // left half appears as the cover swings over
    const left = reduced ? 0 : Math.max(0, (o - 0.5) * 2);
    boardLeft.style.opacity = String(left);
    pagesLeft.style.opacity = String(left);
    gutter.style.opacity = String(left);

    const lightTarget = o > 0.5 ? (active ? 1 : 0.45) : 0;
    light += (lightTarget - light) * Math.min(1, dt * 5);
    pageLight.style.opacity = String(light);

    stage.classList.toggle('is-open', o > 0.6);
    stage.classList.toggle('is-active', active);
    render.lastActive = active;
    render.lastOpen = o > 0.6;
  }

  /* ------------------------------------------------------------------
     4. Rising golden motes
     ------------------------------------------------------------------ */
  const mctx = motesCanvas.getContext('2d');
  let mw = 0, mh = 0;
  let motes = [];

  function sizeMotes() {
    const r = motesCanvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    mw = r.width; mh = r.height;
    motesCanvas.width = Math.round(mw * dpr);
    motesCanvas.height = Math.round(mh * dpr);
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(sizeMotes).observe(motesCanvas);
  sizeMotes();

  function drawMotes(dt) {
    const f = dt * 60; // the tuning below is per 60 fps frame
    const emitting = render.lastOpen && app.state !== 'result' && !closing && !reduced; // no new motes while the book closes
    const rate = emitting ? (render.lastActive ? 0.4 + speed * 0.5 : 0.12) : 0;
    if (Math.random() < rate * f) {
      motes.push({
        x: mw / 2 + (Math.random() - 0.5) * Math.min(mw * 0.4, 170),
        y: mh - 150,
        vx: (Math.random() - 0.5) * 0.3,
        vy: -(0.5 + Math.random() * 1.1) * (1 + speed * 0.4),
        r: Math.random() * 1.5 + 0.4,
        life: 1,
      });
    }
    mctx.clearRect(0, 0, mw, mh);
    mctx.shadowBlur = 6;
    mctx.shadowColor = 'rgba(230, 201, 138, 0.8)';
    motes = motes.filter((p) => {
      p.x += (p.vx + Math.sin(p.y / 22) * 0.15) * f;
      p.y += p.vy * f;
      p.life -= 0.007 * f;
      if (p.life <= 0) return false;
      mctx.fillStyle = `rgba(255, 230, 170, ${p.life * 0.8})`;
      mctx.beginPath();
      mctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      mctx.fill();
      return true;
    });
  }

  /* ------------------------------------------------------------------
     5. Loop: runs only while something is moving
     ------------------------------------------------------------------ */
  function busy() {
    return flipping || closing || speed > 0 || flyingCount > 0 || motes.length > 0 ||
      (openP > 0 && openP < 1) || leaves.some((l) => l.state === 'land') ||
      Math.abs(light - (render.lastOpen ? (render.lastActive ? 1 : 0.45) : 0)) > 0.01 ||
      Math.abs(tilt - (render.tiltTarget ?? tilt)) > 0.05;
  }

  function frame(now) {
    raf = 0;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    update(dt);
    render(dt);
    drawMotes(dt);
    if (busy()) raf = requestAnimationFrame(frame);
  }

  function wake() {
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------------
     6. Input
     ------------------------------------------------------------------ */
  let pressing = false;
  let swallowUp = false;   // the pointer-up that ends a "tap to stop" must not start anything
  let pointerId = null;
  let downAt = 0;

  button.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!canRitual()) { if (app.state === 'home') app.needTopic(); return; }
    e.preventDefault();
    try { button.setPointerCapture(e.pointerId); } catch { /* not critical */ }
    pointerId = e.pointerId;
    downAt = performance.now();
    if (toggled) { toggled = false; flipping = false; swallowUp = true; }
    else { pressing = true; flipping = true; }
    wake();
  });

  button.addEventListener('pointerup', (e) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    if (swallowUp) { swallowUp = false; return; }
    if (!pressing) return;
    pressing = false;
    if (performance.now() - downAt < TAP_MS) toggled = true; // tap: keep flipping
    else flipping = false;                                    // hold released: settle
    wake();
  });

  button.addEventListener('pointercancel', () => {
    pressing = false; swallowUp = false; pointerId = null;
    flipping = false; toggled = false;
    wake();
  });

  button.addEventListener('contextmenu', (e) => e.preventDefault()); // long-press menu on touch devices

  // Keyboard and assistive tech arrive as a native click with detail 0; pointer clicks are handled above.
  button.addEventListener('click', (e) => {
    if (e.detail !== 0) return;
    if (app.state === 'home') { app.needTopic(); return; }
    if (!canRitual()) return;
    if (flipping) { flipping = false; toggled = false; }
    else { flipping = true; toggled = true; }
    wake();
  });

  const releaseAll = () => {
    pressing = false; swallowUp = false; flipping = false; toggled = false;
    wake();
  };
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

  /* ------------------------------------------------------------------
     7. Reacting to the app
     ------------------------------------------------------------------ */
  app.on('reset', () => {
    clearTimeout(finishTimer); finishTimer = 0;
    pressing = false; swallowUp = false; flipping = false; toggled = false;
    begun = false; speed = 0; acc = 0;
    closing = true; leavesRecycled = false;
    wake();
  });

  /* "Choose a topic first": wiggle + a short line, then it fades away */
  let needTimer = 0, clearTimer = 0;
  function showNeed() {
    clearTimeout(clearTimer);
    needEl.textContent = app.t('book.needTopic');
    needEl.classList.add('is-shown');
    clearTimeout(needTimer);
    needTimer = setTimeout(hideNeed, NEED_MS);
    if (!reduced && button.animate) {
      button.animate([
        { transform: 'translateX(0)' }, { transform: 'translateX(-6px) rotate(-1deg)' },
        { transform: 'translateX(5px) rotate(1deg)' }, { transform: 'translateX(-3px)' },
        { transform: 'translateX(0)' },
      ], { duration: 520, easing: 'ease-in-out' });
    }
  }
  function hideNeed() {
    needEl.classList.remove('is-shown');
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => { needEl.textContent = ''; }, 700); // empty again so the next message is announced
  }
  app.on('needtopic', showNeed);
  app.on('state', ({ state }) => { if (state !== 'home') hideNeed(); wake(); }); // stand up / lie down
  app.on('lang', () => { if (needEl.classList.contains('is-shown')) needEl.textContent = app.t('book.needTopic'); });

  reduceMQ.addEventListener('change', () => {
    reduced = reduceMQ.matches;
    scene.classList.toggle('is-reduced', reduced);
    wake();
  });

  resetLeaves();
  render(0);
}
