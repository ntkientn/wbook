/* ==========================================================================
   home.js — the Home screen: 11 intentions, the optional question (typed or
   spoken) and the "A Little Bit of Everything!" humor modal.

   Owns       #intentions, #ask (and its children), #modal
   Talks to   app.select(id) · app.question · app.overlay · app.on(...)
   Reacts to  'intention' · 'reset' · 'lang' · 'state' · 'needtopic' (pulses the section title)

   Rules from the UX Spec honoured here
   - The question is optional and collapsed by default; it never looks like a
     required form field (no label, no submit, no validation).
   - "A Little Bit of Everything!" looks like any other option but only opens a
     joke: it never changes the current selection and never activates the book.
   - Switching language re-renders copy only; selection, typed text and the
     open modal are preserved.
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);

export function initHome(app) {
  const homeEl = $('#home');
  const grid = $('#intentions');
  const askInvite = $('#ask-invite');
  const askField = $('#ask-field');
  const input = $('#question');
  const voiceBtn = $('#voice');
  const note = $('#ask-note');
  const modal = $('#modal');
  const jokeText = $('#joke-text');

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  /* ------------------------------------------------------------------
     1. Intentions
     ------------------------------------------------------------------ */

  // Each option belongs to a row (the two columns share a row); CSS reveals the rows one after another.
  let topicIndex = 0;
  const topicCount = app.ui.intentions.filter((i) => i.type === 'topic').length;
  const options = app.ui.intentions.map((item) => {
    const row = item.type === 'open' ? 0 : item.type === 'topic' ? 1 + Math.floor(topicIndex++ / 2) : 1 + Math.ceil(topicCount / 2);
    const el = document.createElement('button');
    el.type = 'button';
    // "What Awaits?" (first) and "…so many things" (last) span the full width of the list
    el.className = item.type === 'topic' ? 'intention' : `intention intention--wide intention--${item.type}`;
    el.dataset.id = item.id;
    el.style.setProperty('--row', row);
    if (item.type === 'fun') el.setAttribute('aria-haspopup', 'dialog');
    else el.setAttribute('aria-pressed', 'false');
    el.addEventListener('click', () => {
      if (item.type === 'fun') openJoke();
      else if (app.select(item.id)) app.sound?.bowl(0.05); // a faint note when the user chooses (never on page load)
    });
    grid.append(el);
    return { item, el };
  });

  function renderLabels() {
    for (const { item, el } of options) {
      el.replaceChildren(document.createTextNode(app.tr(item.label)));
      if (item.support) {
        const small = document.createElement('small');
        small.className = 'intention-support';
        small.textContent = app.tr(item.support);
        el.append(small);
      }
    }
  }

  function syncSelection() {
    grid.classList.toggle('has-selection', app.intention !== null); // CSS fades the other options
    for (const { item, el } of options) {
      if (item.type !== 'fun') el.setAttribute('aria-pressed', String(app.intention === item.id));
    }
  }

  /* ------------------------------------------------------------------
     2. Humor modal ("Rất nhiều thứ!"): shuffled bag, so no repeats until all seen
     ------------------------------------------------------------------ */

  const jokes = app.ui.jokes;
  let bag = [];
  let currentJoke = -1;

  function nextJoke() {
    if (!bag.length) {
      bag = [...jokes.keys()];
      for (let i = bag.length - 1; i > 0; i--) { // Fisher–Yates
        const j = Math.floor(Math.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    if (bag.length > 1 && bag[bag.length - 1] === currentJoke) {
      [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]]; // never the same joke twice in a row
    }
    currentJoke = bag.pop();
  }

  function renderJoke(animate) {
    jokeText.textContent = app.tr(jokes[currentJoke].text);
    if (animate && !reduceMotion.matches && jokeText.animate) {
      jokeText.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, easing: 'ease-out' });
    }
  }

  function openJoke() {
    nextJoke();
    renderJoke(false);
    app.overlay.open(modal, { onEscape: closeJoke });
  }

  function closeJoke() { app.overlay.close(modal); }

  $('#joke-close').addEventListener('click', closeJoke);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeJoke(); });

  /* ------------------------------------------------------------------
     3. Optional question
     ------------------------------------------------------------------ */

  function openAsk() {
    askInvite.hidden = true;
    askInvite.setAttribute('aria-expanded', 'true');
    askField.hidden = false;
    input.focus();
  }

  function closeAsk() {
    askField.hidden = true;
    askInvite.hidden = false;
    askInvite.setAttribute('aria-expanded', 'false');
  }

  function setQuestion(value) {
    input.value = value;
    app.question = value;
  }

  askInvite.addEventListener('click', openAsk);

  input.addEventListener('input', () => {
    if (listening) stopVoice(); // typing takes over from the microphone
    app.question = input.value;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); } // dismiss the keyboard so the book is reachable
  });

  /* --- inline note (microphone unavailable) --- */
  let noteTimer = 0;
  function showNote(key) {
    note.dataset.key = key;
    note.textContent = app.t(key);
    note.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(hideNote, 6000);
  }
  function hideNote() {
    clearTimeout(noteTimer);
    delete note.dataset.key;
    note.hidden = true;
  }

  /* --- voice input (Web Speech API; the button only appears where it can work) --- */
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const voiceSupported = Boolean(SpeechRecognition) && window.isSecureContext;
  voiceBtn.hidden = !voiceSupported;

  let recognition = null;
  let listening = false;
  let baseText = '';

  function setListening(on) {
    listening = on;
    voiceBtn.classList.toggle('is-listening', on);
    voiceBtn.setAttribute('aria-label', app.t(on ? 'question.voiceStop' : 'question.voiceStart'));
  }

  function startVoice() {
    hideNote();
    baseText = input.value.trim();
    recognition = new SpeechRecognition();
    recognition.lang = app.lang === 'vi' ? 'vi-VN' : 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (e) => {
      const spoken = Array.from(e.results).map((r) => r[0].transcript).join(' ').trim();
      setQuestion(baseText ? `${baseText} ${spoken}` : spoken);
    };
    recognition.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') showNote('question.voiceDenied');
    };
    recognition.onend = () => setListening(false);
    try {
      recognition.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  }

  function stopVoice() {
    try { if (recognition) recognition.stop(); } catch { /* already stopped */ }
    setListening(false);
  }

  voiceBtn.addEventListener('click', () => (listening ? stopVoice() : startVoice()));

  /* ------------------------------------------------------------------
     4. Reacting to the app
     ------------------------------------------------------------------ */

  app.on('intention', syncSelection);

  app.on('reset', () => {
    window.scrollTo({ top: 0, behavior: reduceMotion.matches ? 'auto' : 'smooth' }); // back to where the ritual begins
    playIntro();
    app.sound?.bowl(0.07); // the ritual begins again
    stopVoice();
    hideNote();
    setQuestion('');
    closeAsk();
    syncSelection();
  });

  app.on('lang', () => {
    stopVoice(); // recognition language is fixed per session
    splitPrompt();
    renderLabels();
    syncSelection();
    if (!modal.hidden) renderJoke(false);
    if (note.dataset.key) note.textContent = app.t(note.dataset.key);
  });

  app.on('state', ({ state }) => {
    homeEl.inert = state === 'ritual'; // while the book is being held, nothing above it reacts
    if (state === 'ritual') stopVoice();
  });

  /* The book was pressed too early: bring the section title into view and make it glow once */
  const kicker = $('#kicker');
  app.on('needtopic', () => {
    const r = kicker.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) {
      kicker.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'center' });
    }
    kicker.classList.remove('is-pulse');
    void kicker.offsetWidth; // restart the animation if it is already running
    kicker.classList.add('is-pulse');
  });
  kicker.addEventListener('animationend', () => kicker.classList.remove('is-pulse'));

  /* Opening the ritual: the question appears word by word, then the rest follows.
     Plays on load and again after "New Ritual"; not at all with reduced motion. */
  const prompt = $('.prompt');
  function splitPrompt() {
    let i = 0;
    prompt.querySelectorAll('[data-i18n]').forEach((part) => {
      part.replaceChildren(...app.t(part.dataset.i18n).split(/(\s+)/).filter(Boolean).map((chunk) => {
        if (/^\s+$/.test(chunk)) return document.createTextNode(chunk);
        const w = document.createElement('span');
        w.className = 'w';
        w.style.setProperty('--i', i++);
        w.textContent = chunk;
        return w;
      }));
    });
  }
  let introTimer = 0;
  function playIntro() {
    if (reduceMotion.matches) return;
    homeEl.classList.remove('is-intro');
    void homeEl.offsetWidth; // restart the animations
    homeEl.classList.add('is-intro');
    clearTimeout(introTimer);
    introTimer = setTimeout(() => homeEl.classList.remove('is-intro'), 12000);
  }
  // Any tap, click or key press shows everything at once (it still reaches whatever was tapped)
  function finishIntro() {
    if (!homeEl.classList.contains('is-intro')) return;
    clearTimeout(introTimer);
    homeEl.classList.remove('is-intro');
  }
  document.addEventListener('pointerdown', finishIntro, true);
  document.addEventListener('keydown', finishIntro, true);

  splitPrompt();
  playIntro();
  renderLabels();
  syncSelection();
}
