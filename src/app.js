/* BloomByte: focus widget with notes and a butterfly journal.
   Vanilla JS: one state object, full re-render on actions, live-only DOM updates
   (time, stage, progress) on every tick so typing never loses focus. */
(() => {
  'use strict';

  const api = window.bloom || {
    // Browser fallback so the UI can be previewed outside Electron.
    load: async () => JSON.parse(localStorage.getItem('bb') || '{"sessions":[],"notes":[],"settings":{}}'),
    save: async (d) => { localStorage.setItem('bb', JSON.stringify(d)); return true; },
    setLayout: () => {}, minimize: () => {}, maximize: () => {}, close: () => {}, show: () => {}, quit: () => {},
    onLayout: () => {}, onMaximized: () => {}
  };

  const A = (n) => 'assets/' + n;
  const STAGES = [1, 2, 3, 4, 5, 6, 7].map((i) => A('stage' + i + '.png'));
  const STAGE_ALT = ['Caterpillar munching a leaf', 'Caterpillar hanging from a twig', 'Chrysalis starting to form', 'Chrysalis hanging still', 'Wings peeking out of the chrysalis', 'Butterfly almost out', 'Butterfly on a leaf'];
  const STAGE_NOTE = ['Your caterpillar is eating', 'Getting ready to rest', 'Spinning a chrysalis', 'Resting in the chrysalis', 'Something is moving inside…', 'Almost there, keep going!'];
  const LONG_BREAK = 15;
  const FLOW = ['setup', 'running', 'dump', 'confirm', 'done', 'break', 'breakOver', 'wrap'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DOWF = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONF = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  let data = { sessions: [], notes: [], settings: {} };
  const S = {
    view: 'splash', flowView: 'setup', layout: 'app', maximized: false, editingName: false, greetShown: '',
    cfg: { focus: 25, brk: 5, n: 4, custom: false },
    goal: '',
    run: null,          // { index, total, hatched }
    phase: null,        // { kind: 'focus'|'break'|'long', total, endAt, remaining, paused, startedAt }
    dump: [], draft: '',
    last: null,         // id of the session record just finished
    noteId: null, search: '', sort: 'recent', toast: null,
    jView: 'Day', jSel: null, jWk: 0, jMo: 0,
    refocus: null
  };

  const $app = document.getElementById('app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- persistence ---------- */
  let saveTimer = null;
  function persist(onSaved) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { api.save(data).then(() => onSaved && onSaved()); }, 300);
  }
  function saveSettings() {
    data.settings = { ...(data.settings || {}), focus: S.cfg.focus, brk: S.cfg.brk, n: S.cfg.n, lastGoal: S.goal };
    persist();
  }
  const record = (id) => data.sessions.find((s) => s.id === id);
  const note = (id) => data.notes.find((n) => n.id === id);

  /* ---------- date helpers ---------- */
  const now = () => Date.now();
  const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return dayStart(d.getTime()); };
  const sameDay = (a, b) => dayStart(a) === dayStart(b);
  const clock = (t) => { const d = new Date(t); let h = d.getHours(); const m = String(d.getMinutes()).padStart(2, '0'); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12; return h + ':' + m + ' ' + ap; };
  function ago(t) {
    const s = (now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (sameDay(t, now())) return Math.floor(s / 3600) + 'h ago';
    if (sameDay(t, addDays(now(), -1))) return 'yesterday';
    const d = new Date(t); return d.getDate() + ' ' + MON[d.getMonth()];
  }
  function durText(mins) { const h = Math.floor(mins / 60), m = Math.round(mins % 60); return (h ? h + 'h ' : '') + (m || !h ? m + 'm' : '').trim(); }
  const sessionsOn = (t) => data.sessions.filter((s) => sameDay(s.start, t)).sort((a, b) => a.start - b.start);
  const hatchedOn = (t) => sessionsOn(t).filter((s) => s.completed);
  const hatchedToday = () => hatchedOn(now()).length;
  const earliestDay = () => data.sessions.length ? dayStart(Math.min(...data.sessions.map((s) => s.start))) : dayStart(now());

  /* ---------- views + navigation ---------- */
  function go(view) {
    if (view !== 'onboard') S.editingName = false;
    if (FLOW.includes(view)) S.flowView = view;
    if (S.view === 'noteEdit' && view !== 'noteEdit') cleanupEmptyNote();
    S.view = view;
    render();
  }
  const sessionActive = () => !!S.run;
  // Advance the focus flow without yanking the person away from Home, Notes or the Journal.
  function flowGo(view) {
    S.flowView = view;
    if (FLOW.includes(S.view)) S.view = view;
    render();
  }

  /* ---------- timer engine ---------- */
  function remainingMs() { const p = S.phase; if (!p) return 0; return Math.max(0, p.paused ? p.remaining : p.endAt - now()); }
  function progress() { const p = S.phase; if (!p) return 0; return Math.min(1, 1 - remainingMs() / p.total); }
  function stage() { return Math.min(6, 1 + Math.floor(progress() * 6)); } // 7 only after completion
  function fmt(ms) { const s = Math.ceil(ms / 1000), m = Math.floor(s / 60), r = s % 60; return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0'); }
  function startPhase(kind, minutes) { const total = minutes * 60000; S.phase = { kind, total, endAt: now() + total, remaining: total, paused: false, startedAt: now() }; }

  function startSet() { S.run = { index: 1, total: S.cfg.n, hatched: 0 }; saveSettings(); startFocus(); }
  function startFocus() { S.dump = []; S.draft = ''; startPhase('focus', S.cfg.focus); go('running'); }
  function togglePause() {
    const p = S.phase; if (!p) return;
    if (p.paused) { p.endAt = now() + p.remaining; p.paused = false; } else { p.remaining = p.endAt - now(); p.paused = true; }
    render();
  }
  function focusComplete() {
    const p = S.phase;
    const rec = { id: 's' + now(), start: p.startedAt, end: now(), goal: S.goal.trim(), minutes: Math.round(p.total / 60000), completed: true, mood: 'Done', caption: '', brainDump: S.dump.slice(), keptDump: false, setIndex: S.run.index, setTotal: S.run.total };
    data.sessions.push(rec); persist();
    S.run.hatched++; S.last = rec.id; S.phase = null;
    celebrate('Your butterfly emerged!', 'Session ' + S.run.index + ' of ' + S.run.total + ' complete. Take a breather.');
    flowGo('done');
  }
  function endEarly() {
    const p = S.phase;
    data.sessions.push({ id: 's' + now(), start: p.startedAt, end: now(), goal: S.goal.trim(), minutes: Math.max(0, Math.round((now() - p.startedAt) / 60000)), plannedMinutes: Math.round(p.total / 60000), completed: false, brainDump: S.dump.slice(), setIndex: S.run.index, setTotal: S.run.total });
    persist();
    S.phase = null; S.run = null; go('setup');
  }
  function startBreak() { startPhase('break', S.cfg.brk); go('break'); }
  function startLongBreak() { startPhase('long', LONG_BREAK); go('break'); }
  function breakComplete() {
    const kind = S.phase.kind; S.phase = null;
    if (kind === 'long') { S.run = null; celebrate('Long break is over', 'Ready when you are.'); flowGo('setup'); }
    else { celebrate("Break's over", 'Session ' + (S.run.index + 1) + ' of ' + S.run.total + ' is ready.'); flowGo('breakOver'); }
  }
  function nextSession() { S.run.index++; startFocus(); }

  function tick() {
    const p = S.phase;
    if (p && !p.paused && now() >= p.endAt) {
      if (p.kind === 'focus') focusComplete(); else breakComplete();
      return;
    }
    if (S.toast && now() > S.toast.until) { S.toast = null; render(); return; }
    if (S.view === 'home' && S.layout !== 'mini' && S.greetShown && greeting() !== S.greetShown) { render(); return; }
    updateLive();
  }

  /* ---------- sound + notification ---------- */
  let audio = null;
  const soundOn = () => !(data.settings && data.settings.sound === false);
  // Short square-wave blips. Each entry: [frequency Hz, start offset s, length s].
  const SFX = {
    click: [[880, 0, 0.045], [1320, 0.035, 0.05]],
    tick:  [[1046, 0, 0.035]],
    go:    [[523, 0, 0.06], [659, 0.06, 0.06], [784, 0.12, 0.06], [1046, 0.18, 0.1]],
    up:    [[660, 0, 0.05], [990, 0.05, 0.07]],
    down:  [[990, 0, 0.05], [660, 0.05, 0.07]],
    low:   [[330, 0, 0.06], [220, 0.06, 0.1]],
    save:  [[784, 0, 0.05], [1046, 0.05, 0.05], [1568, 0.1, 0.09]]
  };
  function sfx(kind) {
    if (!soundOn() || !SFX[kind]) return;
    try {
      audio = audio || new AudioContext();
      if (audio.state === 'suspended') audio.resume();
      const t0 = audio.currentTime + 0.005;
      SFX[kind].forEach(([f, at, len]) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = 'square'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + at);
        g.gain.exponentialRampToValueAtTime(0.045, t0 + at + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
        o.connect(g).connect(audio.destination);
        o.start(t0 + at); o.stop(t0 + at + len + 0.02);
      });
    } catch (e) {}
  }
  const SFX_FOR = {
    start: 'go', quickStart: 'go', next: 'go', break: 'up', long: 'up', saveName: 'save', addDump: 'up', keepDump: 'save',
    newNote: 'up', mood: 'tick', focus: 'tick', brk: 'tick', custom: 'tick', dec: 'tick', inc: 'tick', jTab: 'tick', jPrev: 'tick', jNext: 'tick', jOpen: 'tick', sort: 'tick',
    delNote: 'low', endEarly: 'low', rmDump: 'low', undo: 'up', close: 'low'
  };
  function sfxFor(act) {
    if (act === 'pause') return S.phase && S.phase.paused ? 'up' : 'down';
    return SFX_FOR[act] || 'click';
  }
  function chime() {
    try {
      audio = audio || new AudioContext();
      const t0 = audio.currentTime;
      [659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = 'square'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + i * 0.12);
        g.gain.exponentialRampToValueAtTime(0.06, t0 + i * 0.12 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.12 + 0.18);
        o.connect(g).connect(audio.destination); o.start(t0 + i * 0.12); o.stop(t0 + i * 0.12 + 0.2);
      });
    } catch (e) {}
  }
  function celebrate(title, body) { chime(); try { new Notification(title, { body, icon: A('icon64.png'), silent: true }); } catch (e) {} }

  /* ---------- notes ---------- */
  function newNote(fields = {}) {
    const n = { id: 'n' + now() + Math.floor(Math.random() * 1000), title: '', body: '', created: now(), updated: now(), fromSession: false, ...fields };
    data.notes.push(n); persist();
    return n;
  }
  function openNote(id) { S.noteId = id; go('noteEdit'); }
  function cleanupEmptyNote() {
    const n = note(S.noteId);
    if (n && !n.title.trim() && !n.body.trim()) { data.notes = data.notes.filter((x) => x.id !== n.id); persist(); }
  }
  function deleteNote() {
    const n = note(S.noteId); if (!n) return;
    const idx = data.notes.indexOf(n);
    data.notes.splice(idx, 1); persist();
    S.noteId = null;
    S.toast = { text: '“' + (n.title.trim() || 'Untitled') + '” deleted', until: now() + 6000, undo: () => { data.notes.splice(idx, 0, n); persist(); } };
    S.view = 'notes'; render();
  }
  function keepDumpAsNote() {
    const r = record(S.last); if (!r || r.keptDump || !r.brainDump.length) return;
    newNote({ title: 'Brain dump · ' + (r.goal || 'focus session'), body: r.brainDump.map((t) => '• ' + t).join('\n'), fromSession: true, sessionId: r.id });
    r.keptDump = true; persist(); render();
  }
  const sortedNotes = () => {
    const q = S.search.trim().toLowerCase();
    let list = data.notes.filter((n) => !q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q));
    return S.sort === 'az' ? list.sort((a, b) => (a.title || 'Untitled').localeCompare(b.title || 'Untitled')) : list.sort((a, b) => b.updated - a.updated);
  };

  /* ---------- small view helpers ---------- */
  const ICON = {
    min: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="2" y="9" width="10" height="3" fill="currentColor"/></svg>',
    close: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8"/></svg>',
    expand: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M8 2h4v4M6 12H2V8M12 2L8 6M2 12l4-4"/></svg>',
    back: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
    chev: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    pause: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="3" y="2" width="3" height="10" fill="currentColor"/><rect x="8" y="2" width="3" height="10" fill="currentColor"/></svg>',
    play: '<svg width="14" height="14" viewBox="0 0 8 9" shape-rendering="crispEdges" aria-hidden="true"><rect x="1" y="0" width="2" height="9" fill="currentColor"/><rect x="3" y="1" width="2" height="7" fill="currentColor"/><rect x="5" y="2" width="2" height="5" fill="currentColor"/><rect x="7" y="3" width="1" height="3" fill="currentColor"/></svg>',
    skip: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l6 5-6 5z" fill="currentColor"/><rect x="9" y="2" width="3" height="10" fill="currentColor"/></svg>',
    plus: '<svg width="13" height="13" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true"><rect x="6" y="1" width="4" height="14" fill="currentColor"/><rect x="1" y="6" width="14" height="4" fill="currentColor"/></svg>',
    search: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#7E2B3E" stroke-width="2.6" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    trash: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
    widget: '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"/><rect x="8" y="8" width="5" height="5" fill="currentColor"/></svg>',
    appwin: '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" fill="none" stroke="currentColor" stroke-width="2"/><rect x="1.5" y="2.5" width="13" height="3" fill="currentColor"/></svg>',
    max: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    restore: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="3.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3.5 3.5V1.5h7v7h-2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    soundOn: '<svg width="15" height="15" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true"><path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor"/><rect x="11" y="5" width="2" height="6" fill="currentColor"/><rect x="14" y="3" width="1.6" height="10" fill="currentColor"/></svg>',
    soundOff: '<svg width="15" height="15" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true"><path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor"/><path d="M11 5.5l4 5M15 5.5l-4 5" stroke="currentColor" stroke-width="1.8"/></svg>',
    check: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>'
  };
  function bar(opts = {}) {
    const isApp = S.layout === 'app';
    const snd = `<button class="icon-btn" data-act="toggleSound" aria-pressed="${soundOn()}" aria-label="${soundOn() ? 'Turn sound effects off' : 'Turn sound effects on'}" title="${soundOn() ? 'Sound on' : 'Sound off'}">${soundOn() ? ICON.soundOn : ICON.soundOff}</button>`;
    const controls = snd + (isApp
      ? `<button class="icon-btn" data-act="toWidget" aria-label="Switch to widget" title="Switch to widget (floats on top)">${ICON.widget}</button>
         <span class="win-ctl"><button class="wbtn" data-act="minimize" aria-label="Minimize" title="Minimize">${ICON.min}</button><button class="wbtn" data-act="maximize" aria-label="${S.maximized ? 'Restore' : 'Maximize'}" title="${S.maximized ? 'Restore' : 'Maximize'}">${S.maximized ? ICON.restore : ICON.max}</button><button class="wbtn close" data-act="close" aria-label="Close" title="Close">${ICON.close}</button></span>`
      : `<button class="icon-btn" data-act="toMini" aria-label="Shrink to corner pill" title="Shrink to corner pill">${ICON.min}</button>
         <button class="icon-btn" data-act="toApp" aria-label="Open as app window" title="Open as app window">${ICON.appwin}</button>
         <button class="icon-btn" data-act="close" aria-label="Close" title="Close">${ICON.close}</button>`);
    return `<div class="bar${isApp ? ' appbar' : ''}">
      ${opts.back ? `<button class="icon-btn back" data-act="nav" data-v="${opts.back}" aria-label="Back">${ICON.back}</button>` : ''}
      <div class="brand"><img class="logo" src="${A('bloombytelogo.png')}" alt=""><img class="word" src="${A('wordmark.png')}" alt="BloomByte"></div>
      <div class="spacer grab" title="Drag to move" aria-hidden="true"></div>
      ${controls}
    </div>`;
  }
  const dots = () => S.run ? Array.from({ length: S.run.total }, (_, i) => `<span class="dot${i < S.run.index - 1 || (i === S.run.index - 1 && S.flowView === 'done') ? ' on' : ''}"></span>`).join('') : '';
  const segs = () => Array.from({ length: 7 }, (_, i) => `<span class="seg${i < stage() ? ' on' : ''}${i === 6 ? ' last' : ''}"></span>`).join('');
  const tabChip = (label, on, act) => `<button class="chip${on ? ' on' : ''}" data-act="${act}" data-v="${label}" aria-pressed="${on}">${label}</button>`;

  /* ---------- Splash + onboarding ---------- */
  function greeting(d = new Date()) {
    const h = d.getHours();
    if (h >= 5 && h < 12) return 'Good morning';
    if (h >= 12 && h < 17) return 'Good afternoon';
    if (h >= 17 && h < 21) return 'Good evening';
    return 'Good night';
  }
  function vSplash() {
    return `<div class="panel sky splash" role="status" aria-label="BloomByte is loading">
      <div class="splash-inner">
        <img class="splash-logo bob" src="${A('bloombytelogo.png')}" alt="">
        <img class="splash-word" src="${A('wordmark.png')}" alt="BloomByte">
        <p class="splash-tag">My very own productivity app &lt;3</p>
        <div class="loadbar" aria-hidden="true">${Array.from({ length: 12 }, (_, i) => `<span style="animation-delay:${i * 0.11}s"></span>`).join('')}</div>
      </div></div>`;
  }
  function vOnboard() {
    const editing = S.editingName;
    const cur = (data.settings && data.settings.name) || '';
    const val = editing ? cur : (S.pendingName || '');
    return `<div class="panel sky-raw onb-panel fade-in">${bar(editing ? { back: 'home' } : {})}
      <div class="body mid center onboard">
        <img class="onb-fly bob" src="${STAGES[6]}" alt="A pink butterfly resting on a leaf">
        <h1 class="onb-title">${editing ? 'Change your name' : 'Welcome to BloomByte!'}</h1>
        <label for="uname" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Your name</label>
        <input id="uname" class="onb-input" data-input="uname" maxlength="30" autocomplete="given-name" placeholder="Enter your name" value="${esc(val)}">
        <button class="onb-go" data-act="saveName" ${val.trim() ? '' : 'disabled'}>${editing ? 'Save' : 'Let’s grow'}</button>
      </div></div>`;
  }
  function saveName() {
    const el = document.getElementById('uname');
    const v = (el ? el.value : S.pendingName || '').trim().slice(0, 30);
    if (!v) return;
    data.settings = { ...(data.settings || {}), name: v, onboardedAt: (data.settings && data.settings.onboardedAt) || now() };
    persist();
    S.editingName = false; S.pendingName = '';
    go('home');
  }

  /* ---------- Home ---------- */
  function vHome() {
    const greet = greeting();
    S.greetShown = greet;
    const name = (data.settings && data.settings.name) || '';
    const d = new Date();
    const today = hatchedOn(now());
    const mins = today.reduce((a, s) => a + s.minutes, 0);
    const shown = today.slice(-4);
    const flies = shown.map(() => `<img src="${STAGES[6]}" alt="Butterfly">`).join('') + (today.length > 4 ? `<span class="more">+${today.length - 4}</span>` : '');
    const slot = S.phase && S.phase.kind === 'focus'
      ? `<div class="slot"><img data-live="stage" src="${STAGES[stage() - 1]}" alt="Growing now"></div>`
      : `<div class="slot"><img src="${STAGES[0]}" alt="Next caterpillar"></div>`;
    const notes = data.notes.slice().sort((a, b) => b.updated - a.updated);
    const lastNote = notes[0];
    let banner = '';
    if (sessionActive() && S.phase) {
      const isFocus = S.phase.kind === 'focus';
      banner = `<button class="live-banner" data-act="toFlow"><img data-live="${isFocus ? 'stage' : 'x'}" src="${isFocus ? STAGES[stage() - 1] : STAGES[6]}" alt=""><b data-live="time">${fmt(remainingMs())}</b><span>${isFocus ? 'Session ' + S.run.index + ' of ' + S.run.total + (S.phase.paused ? ' · paused' : ' · focusing') : 'On a break'}</span>${ICON.chev}</button>`;
    } else if (sessionActive()) {
      banner = `<button class="live-banner" data-act="toFlow"><img src="${STAGES[6]}" alt=""><span>${S.flowView === 'done' ? 'Your butterfly is waiting for a caption' : S.flowView === 'breakOver' ? 'Break is over, session ' + (S.run.index + 1) + ' is ready' : 'Back to your focus set'}</span>${ICON.chev}</button>`;
    }
    const focusSub = S.phase && S.phase.kind === 'focus' ? 'Session ' + S.run.index + ' of ' + S.run.total + ' running' : 'Grow butterfly #' + (hatchedToday() + 1);
    return `<div class="panel sky fade-in">${bar()}
      <div class="body" style="gap:10px">
        <div class="greet"><h1>${greet}${name ? `, <button class="namebtn" data-act="editName" title="Change your name">${esc(name)}</button>` : ''}</h1><p>${DOWF[d.getDay()]}, ${d.getDate()} ${MONF[d.getMonth()]}</p></div>
        ${banner}
        <button class="todaycard" data-act="nav" data-v="journal" aria-label="Today's butterflies, open your journal">
          <div class="top"><h2>Today's butterflies</h2><span>${today.length} session${today.length === 1 ? '' : 's'} · ${durText(mins)} ${ICON.chev}</span></div>
          <div class="hills">${flies}${slot}</div>
        </button>
        <div class="tiles">
          <button class="tile notes" data-act="nav" data-v="notes"><img src="${A('notebook.png')}" alt="" style="width:38px;height:48px"><span><b>Notes</b><small>${notes.length} note${notes.length === 1 ? '' : 's'}${lastNote ? ' · edited ' + ago(lastNote.updated) : ''}</small></span></button>
          <button class="tile focus" data-act="toFlow"><img src="${A('clock.png')}" alt="" style="width:46px;height:46px"><span><b>Focus</b><small>${focusSub}</small></span></button>
        </div>
        ${lastNote ? `<button class="cont" data-act="openNote" data-v="${lastNote.id}"><span style="min-width:0"><small>Continue writing</small><b>${esc(lastNote.title.trim() || 'Untitled')}</b></span><span style="color:var(--rose)">${ICON.chev}</span></button>` : ''}
      </div></div>`;
  }

  /* ---------- Notes ---------- */
  function vNotes() {
    const list = sortedNotes();
    const toast = S.toast ? `<div class="toast" role="status"><span>${esc(S.toast.text)}</span><button data-act="undo">Undo</button></div>` : '';
    let content;
    if (!data.notes.length) {
      content = `<div class="empty"><img src="${A('notebook.png')}" alt="" style="width:70px;height:89px"><h1 style="font-size:20px">No notes yet</h1><p class="muted" style="max-width:280px">Jot down ideas, a to-do list, or a quick brain dump before you start focusing.</p><button class="btn pink" data-act="newNote" style="margin-top:4px">${ICON.plus} Write your first note</button></div>`;
    } else if (!list.length) {
      content = `<div class="empty"><p class="px-font" style="font-size:17px;color:var(--rose)">No notes match “${esc(S.search)}”</p><button class="btn ghost" data-act="clearSearch">Clear search</button></div>`;
    } else {
      content = `<div class="ngrid">${list.map((n) => `<button class="ncard" data-act="openNote" data-v="${n.id}"><b>${esc(n.title.trim() || 'Untitled')}</b><p>${esc(n.body.trim().slice(0, 140) || 'Empty note')}</p><span class="meta">${n.fromSession ? `<img src="${A('bloombytelogo.png')}" alt="">From focus session · ` : ''}${ago(n.updated)}</span></button>`).join('')}</div>`;
    }
    return `<div class="panel paper pinkframe fade-in">${bar({ back: 'home' })}
      <div class="body" style="gap:10px">
        <div class="notes-head"><h1>Notes</h1><button class="btn pink" style="height:38px;font-size:15px" data-act="newNote">${ICON.plus} New note</button></div>
        ${data.notes.length ? `<div class="searchrow"><label class="search">${ICON.search}<span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Search notes</span><input id="search" type="search" data-input="search" placeholder="Search notes" value="${esc(S.search)}"></label><button class="sortbtn" data-act="sort">${S.sort === 'az' ? 'A–Z' : 'Recent'}</button></div>` : ''}
        ${content}
      </div>${toast}</div>`;
  }
  function vNoteEdit() {
    const n = note(S.noteId);
    if (!n) return vNotes();
    return `<div class="panel paper pinkframe fade-in">${bar({ back: 'notes' })}
      <div class="body" style="gap:8px">
        <div class="editor">
          <div class="ehead">
            <label for="ntitle" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Title</label>
            <input id="ntitle" class="etitle" data-input="ntitle" maxlength="80" placeholder="Untitled" value="${esc(n.title)}">
            <div class="emeta">${n.fromSession ? `<img src="${A('bloombytelogo.png')}" alt="">From a focus session · ` : ''}Edited ${ago(n.updated)}</div>
          </div>
          <label for="nbody" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Note</label>
          <textarea id="nbody" data-input="nbody" placeholder="Start writing…">${esc(n.body)}</textarea>
          <div class="efoot">
            <span class="saved" data-live="saved" role="status">${ICON.check} Saved</span>
            <span style="flex:1"></span>
            <button class="icon-btn" data-act="delNote" aria-label="Delete note" title="Delete note" style="width:36px;height:36px;border-color:var(--pink-line);color:var(--rose)">${ICON.trash}</button>
            <button class="btn olive" style="height:36px;font-size:14px;padding:0 12px" data-act="focusOnNote"><img src="${A('clock.png')}" alt="" style="width:16px;height:16px"> Focus on this</button>
          </div>
        </div>
      </div></div>`;
  }

  /* ---------- Focus flow ---------- */
  function vSetup() {
    const c = S.cfg;
    const chip = (v, on, act) => `<button class="chip${on ? ' on' : ''}" data-act="${act}" data-v="${v}" aria-pressed="${on}">${v}${act === 'focus' ? ' min' : 'm'}</button>`;
    const preset = [25, 50, 90].includes(c.focus) && !c.custom;
    const total = c.n * c.focus + (c.n - 1) * c.brk;
    const pips = Array.from({ length: c.n }, () => `<img src="${A('stage1.png')}" alt="">`).join('');
    return `<div class="panel sky fade-in">${bar({ back: 'home' })}
      <div class="body">
        <div class="row" style="align-items:center;gap:12px">
          <img src="${A('stage1.png')}" alt="A caterpillar on a leaf" style="width:74px;height:52px;flex:none">
          <div style="flex:1"><h1 class="olive">Grow a butterfly</h1><p class="muted">Finish a session and its caterpillar turns into a butterfly.</p></div>
        </div>
        <div><label class="label" for="goal">What will you focus on?</label>
          <input id="goal" class="input" data-input="goal" maxlength="80" placeholder="e.g. Finish chapter 3 outline" value="${esc(S.goal)}"></div>
        <div><span class="label">Focus length</span>
          <div class="chips" style="grid-template-columns:repeat(4,1fr)">
            ${[25, 50, 90].map((m) => chip(m, preset && c.focus === m, 'focus')).join('')}
            ${c.custom ? `<input class="custom-input" data-input="customFocus" type="number" min="5" max="180" value="${c.focus}" aria-label="Custom focus minutes">` : `<button class="chip" data-act="custom">Custom</button>`}
          </div></div>
        <div class="grid2">
          <div><span class="label">Break length</span><div class="chips" style="grid-template-columns:repeat(3,1fr)">${[5, 10, 15].map((m) => chip(m, c.brk === m, 'brk')).join('')}</div></div>
          <div><span class="label">Sessions</span><div class="stepper"><button data-act="dec" aria-label="Fewer sessions">−</button><span aria-live="polite">${c.n}</span><button data-act="inc" aria-label="More sessions">+</button></div></div>
        </div>
        <div class="summary"><span class="pips">${pips}</span><span>${c.n} ${c.n === 1 ? 'butterfly' : 'butterflies'} to grow · about ${durText(total)} with breaks</span></div>
        <button class="btn pink wide" data-act="start">${ICON.play} Start ${c.focus}:00 · session 1 of ${c.n}</button>
      </div></div>`;
  }
  function vRunning() {
    const s = stage(), p = S.phase;
    return `<div class="panel sky fade-in">${bar({ back: 'home' })}
      <div class="body center" style="gap:8px">
        <div class="row" style="align-self:stretch;align-items:center;flex:none">
          <span class="pill" style="flex:none">${dots()} Session ${S.run.index} of ${S.run.total}</span><span style="flex:1"></span>
          <button class="btn ghost" style="flex:none;height:32px;font-size:14px;padding:0 10px" data-act="nav" data-v="confirm">End session</button>
        </div>
        ${S.goal.trim() ? `<p class="goal">${esc(S.goal.trim())}</p>` : ''}
        <img class="hero" data-live="stage" src="${STAGES[s - 1]}" alt="${STAGE_ALT[s - 1]}">
        <p class="small" data-live="mode" style="color:#4D5230;letter-spacing:.08em;text-transform:uppercase">${p.paused ? 'Paused' : 'Focusing'}</p>
        <p class="timer" role="timer" data-live="time">${fmt(remainingMs())}</p>
        <div class="segs" data-live="segs" aria-hidden="true">${segs()}</div>
        <p class="small" data-live="note">Stage ${s} of 7 · ${STAGE_NOTE[s - 1]}</p>
        <div class="row" style="align-self:stretch;margin-top:4px">
          <button class="btn pink" data-act="pause">${p.paused ? ICON.play + ' Resume' : ICON.pause + ' Pause'}</button>
          <button class="btn olive" data-act="nav" data-v="dump"><img src="${A('notebook.png')}" alt="" style="width:16px;height:20px"> Brain dump</button>
        </div>
      </div></div>`;
  }
  function vDump() {
    const items = S.dump.map((t, i) => `<li><span class="sq"></span><span class="t">${esc(t)}</span><button class="x-btn" data-act="rmDump" data-i="${i}" aria-label="Remove: ${esc(t)}">${ICON.close}</button></li>`).join('');
    return `<div class="panel sky pinkframe fade-in">${bar({ back: 'running' })}
      <div class="body">
        <div class="card pink" style="flex:1;min-height:0;display:flex;flex-direction:column;padding:12px 12px 8px;gap:8px">
          <div class="row" style="align-items:center">
            <div style="flex:1"><h1>Brain dump</h1><p class="muted">Park stray thoughts. They stay with this session only.</p></div>
            <span class="pill" style="flex:none"><img data-live="stageSmall" src="${STAGES[stage() - 1]}" alt="" style="width:32px;height:23px"><span data-live="time" class="px-font" style="font-size:16px;color:var(--rose)">${fmt(remainingMs())}</span></span>
          </div>
          <div class="row" style="flex:none">
            <label for="thought" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">New thought</label>
            <input id="thought" class="input" data-input="draft" maxlength="140" placeholder="Type a thought, press Enter" value="${esc(S.draft)}" style="flex:1">
            <button class="btn pink" style="flex:none;height:40px" data-act="addDump">Add</button>
          </div>
          <ul class="dump-list">${items || '<li><span class="t" style="color:#8A7378">Nothing parked yet.</span></li>'}</ul>
        </div>
        <button class="btn olive wide" data-act="nav" data-v="running"><img src="${A('clock.png')}" alt="" style="width:18px;height:18px"> Back to focus</button>
      </div></div>`;
  }
  function vConfirm() {
    const mins = Math.max(1, Math.round((S.phase.total - remainingMs()) / 60000));
    const s = stage();
    return `<div class="panel dusk pinkframe fade-in"><div class="overlay-pink"></div>
      <div style="position:relative;display:flex;flex-direction:column;flex:1">${bar({ back: 'running' })}
      <div class="body" style="justify-content:center">
        <div class="card pink center" role="dialog" aria-labelledby="endt" style="display:flex;flex-direction:column;gap:8px;padding:16px 18px 18px;box-shadow:5px 5px 0 #C77486">
          <img class="hero sm" src="${STAGES[s - 1]}" alt="${STAGE_ALT[s - 1]}">
          <h1 id="endt">End this session?</h1>
          <p class="muted" style="max-width:340px">You're ${mins} minute${mins === 1 ? '' : 's'} in. Butterflies only come out when a session is finished, so this one won't hatch if you stop now.</p>
          <button class="btn pink wide" data-act="nav" data-v="running" style="margin-top:6px">Keep focusing</button>
          <button class="btn ghost wide" data-act="endEarly">End anyway</button>
        </div>
      </div></div></div>`;
  }
  function vDone() {
    const rec = record(S.last) || {};
    const last = S.run.index >= S.run.total;
    const mood = (m) => `<button class="chip pinkchip${rec.mood === m ? ' on' : ''}" data-act="mood" data-v="${m}" aria-pressed="${rec.mood === m}">${m}</button>`;
    const n = (rec.brainDump || []).length;
    const dumpRow = n ? `<div class="row" style="align-self:stretch;align-items:center;gap:8px;padding:5px 6px 5px 10px;background:var(--pink-light);border:3px solid #F3CBD2">
        <p class="small" style="flex:1;text-align:left;color:var(--ink)">${rec.keptDump ? n + ' brain-dump thought' + (n === 1 ? '' : 's') + ' saved to Notes' : n + ' thought' + (n === 1 ? '' : 's') + ' in this session’s brain dump'}</p>
        ${rec.keptDump ? `<span class="small" style="flex:none;color:var(--rose)">${ICON.check} Saved</span>` : `<button class="btn pink" style="flex:none;height:32px;font-size:14px;padding:0 10px" data-act="keepDump">Keep as note</button>`}</div>` : '';
    return `<div class="panel sky pinkframe fade-in">${bar({ back: 'home' })}
      <div class="body center" style="gap:7px">
        <img class="hero sm bob" src="${STAGES[6]}" alt="A pink butterfly resting on a leaf">
        <h1>Your butterfly emerged!</h1>
        <p class="muted">Session ${S.run.index} of ${S.run.total} · ${rec.minutes} min${rec.goal ? ' on “' + esc(rec.goal) + '”' : ''}</p>
        <div style="align-self:stretch;text-align:left"><span class="label">How did it go?</span><div class="chips" style="grid-template-columns:repeat(3,1fr)">${mood('Done')}${mood('Partly')}${mood('Not quite')}</div></div>
        <div style="align-self:stretch;text-align:left"><label class="label" for="cap">Caption for this butterfly (saved in your journal)</label>
          <input id="cap" class="input" data-input="caption" maxlength="120" placeholder="e.g. Outline done, start drafting tomorrow" value="${esc(rec.caption)}"></div>
        ${dumpRow}
        <div class="row" style="align-self:stretch;margin-top:2px">
          ${last ? `<button class="btn pink" data-act="wrap">Wrap up the set</button>` : `<button class="btn pink" data-act="break">Start ${S.cfg.brk} min break</button><button class="btn ghost" style="flex:none" data-act="next">Skip break</button>`}
        </div>
      </div></div>`;
  }
  function vBreak() {
    const long = S.phase.kind === 'long';
    return `<div class="panel dusk pinkframe fade-in">${bar({ back: 'home' })}
      <div class="body center" style="justify-content:center;gap:10px">
        <img class="hero bob" src="${STAGES[6]}" alt="Your butterfly resting">
        <h1>${long ? 'Long break' : 'Break time'}</h1>
        <p class="timer" role="timer" data-live="time">${fmt(remainingMs())}</p>
        <p class="muted" style="max-width:320px">Stand up, stretch, refill your water. The butterfly is resting too.</p>
        <button class="btn ghost" data-act="${long ? 'endLong' : 'next'}" style="margin-top:4px">${ICON.skip} ${long ? 'End break' : 'Skip to session ' + (S.run.index + 1)}</button>
      </div></div>`;
  }
  function vBreakOver() {
    return `<div class="panel sky fade-in">${bar({ back: 'home' })}
      <div class="body center" style="justify-content:center;gap:10px">
        <img class="hero" src="${STAGES[0]}" alt="A fresh caterpillar">
        <h1 class="olive">Break's over</h1>
        <p class="muted">A new caterpillar is ready for session ${S.run.index + 1} of ${S.run.total}.</p>
        <button class="btn pink" data-act="next" style="margin-top:4px">${ICON.play} Start session ${S.run.index + 1}</button>
        <button class="btn ghost" data-act="wrap">Stop for now</button>
      </div></div>`;
  }
  function vWrap() {
    const c = S.run ? S.run.hatched : 0, t = hatchedToday();
    const flies = Array.from({ length: c }, () => `<img src="${STAGES[6]}" alt="Butterfly">`).join('');
    return `<div class="panel sky pinkframe fade-in">${bar({ back: 'home' })}
      <div class="body center" style="justify-content:center;gap:10px">
        <h1>${c} ${c === 1 ? 'butterfly' : 'butterflies'} this set</h1>
        <div class="card center" style="padding:14px;align-self:stretch"><div class="flies">${flies || `<img src="${STAGES[3]}" alt="Chrysalis" style="width:90px;height:64px">`}</div></div>
        <p class="muted">${t} grown today. <button data-act="nav" data-v="journal" style="border:0;background:none;padding:0;color:var(--rose);font-weight:700;text-decoration:underline">See them in your journal</button></p>
        <div class="row" style="align-self:stretch;margin-top:4px">
          <button class="btn olive" data-act="long">Take a ${LONG_BREAK} min break</button>
          <button class="btn pink" data-act="newSet">Start a new set</button>
        </div>
      </div></div>`;
  }

  /* ---------- Journal ---------- */
  function vJournal() {
    const T = dayStart(now());
    if (S.jSel === null) S.jSel = T;
    const tabs = ['Day', 'Week', 'Month'].map((l) => tabChip(l, S.jView === l, 'jTab')).join('');
    let content = '';
    if (S.jView === 'Day') {
      const sel = S.jSel;
      const list = sessionsOn(sel);
      const hatched = list.filter((s) => s.completed);
      const mins = hatched.reduce((a, s) => a + s.minutes, 0);
      const d = new Date(sel);
      const entries = list.map((s) => `<article class="jentry${s.completed ? '' : ' nohatch'}">
          <img src="${s.completed ? STAGES[6] : STAGES[3]}" alt="${s.completed ? 'Butterfly' : 'Chrysalis that didn’t hatch'}">
          <div style="flex:1;min-width:0"><div class="h"><b>${esc(s.goal || 'Focus session')}</b><span class="tm">${clock(s.start)}</span></div>
            <p class="m">${s.completed ? s.minutes + ' min · ' + esc(s.mood || 'Done') + (s.brainDump && s.brainDump.length ? ' · ' + s.brainDump.length + ' brain-dump thought' + (s.brainDump.length === 1 ? '' : 's') : '') : 'Ended at ' + s.minutes + ' min · didn’t hatch'}</p>
            ${s.caption ? `<p class="c">“${esc(s.caption)}”</p>` : ''}</div></article>`).join('');
      content = `<div class="jnav"><button data-act="jPrev" aria-label="Previous day"${sel <= Math.min(earliestDay(), addDays(T, -60)) ? ' disabled' : ''}>‹</button><span>${sameDay(sel, T) ? 'Today · ' : ''}${DOW[d.getDay()]}, ${d.getDate()} ${MON[d.getMonth()]}</span><button data-act="jNext" aria-label="Next day"${sel >= T ? ' disabled' : ''}>›</button></div>
        ${list.length ? `<p class="small" style="color:var(--olive-text)">${hatched.length} butterfl${hatched.length === 1 ? 'y' : 'ies'} · ${durText(mins)} focused${list.length > hatched.length ? ' · ' + (list.length - hatched.length) + ' didn’t hatch' : ''}</p><div class="jlist">${entries}</div>`
          : `<div class="empty" style="border-color:var(--olive)"><img src="${STAGES[0]}" alt="" style="width:100px;height:71px"><p class="px-font" style="font-size:17px;color:var(--olive-text)">No butterflies this day</p><p class="muted">${sameDay(sel, T) ? 'Start a session to grow your first one.' : 'Your caterpillar took a rest day.'}</p></div>`}`;
    } else if (S.jView === 'Week') {
      const ref = addDays(T, S.jWk * 7);
      const monday = addDays(ref, -((new Date(ref).getDay() + 6) % 7));
      let total = 0, mins = 0;
      const days = Array.from({ length: 7 }, (_, i) => {
        const t = addDays(monday, i), fut = t > T, h = hatchedOn(t);
        total += h.length; mins += h.reduce((a, s) => a + s.minutes, 0);
        const dd = new Date(t);
        return `<button class="wday${t === T ? ' today' : ''}${fut ? ' future' : ''}" ${fut ? 'disabled' : `data-act="jOpen" data-v="${t}"`} aria-label="${DOWF[dd.getDay()]} ${dd.getDate()} ${MON[dd.getMonth()]}${fut ? ', upcoming' : ': ' + h.length + ' butterflies'}">
          <span class="dw">${DOW[dd.getDay()]}</span><span class="dn">${dd.getDate()}</span>
          <span class="stack">${h.slice(0, 6).map(() => `<img src="${STAGES[6]}" alt="">`).join('')}</span>
          <span class="wm">${fut ? '' : h.length ? durText(h.reduce((a, s) => a + s.minutes, 0)) : 'rest'}</span></button>`;
      }).join('');
      const sun = new Date(addDays(monday, 6)), mon = new Date(monday);
      content = `<div class="jnav"><button data-act="jPrev" aria-label="Previous week"${monday <= addDays(earliestDay(), -7) ? ' disabled' : ''}>‹</button><span>${mon.getDate()} ${MON[mon.getMonth()]} – ${sun.getDate()} ${MON[sun.getMonth()]}</span><button data-act="jNext" aria-label="Next week"${S.jWk >= 0 ? ' disabled' : ''}>›</button></div>
        <div class="week">${days}</div>
        <p class="jsum">${total} butterfl${total === 1 ? 'y' : 'ies'} · ${durText(mins)} focused this week</p>`;
    } else {
      const base = new Date(T); base.setDate(1); base.setMonth(base.getMonth() + S.jMo);
      const y = base.getFullYear(), m = base.getMonth();
      const lead = (new Date(y, m, 1).getDay() + 6) % 7, dim = new Date(y, m + 1, 0).getDate();
      let total = 0, best = null;
      const cells = Array.from({ length: lead }, () => `<span class="mcell blank"></span>`);
      for (let d = 1; d <= dim; d++) {
        const t = new Date(y, m, d).getTime(), fut = t > T, n = hatchedOn(t).length;
        total += n; if (n && (!best || n > best.n)) best = { d, n };
        cells.push(`<button class="mcell${t === T ? ' today' : ''}${fut ? ' future' : ''}" ${fut ? 'disabled' : `data-act="jOpen" data-v="${t}"`} aria-label="${d} ${MONF[m]}${fut ? ', upcoming' : ': ' + n + ' butterflies'}"><span class="d">${d}</span>${n ? `<span class="fly"><img src="${STAGES[6]}" alt=""><em>${n}</em></span>` : ''}</button>`);
      }
      const earliest = new Date(earliestDay());
      const canPrev = y > earliest.getFullYear() || (y === earliest.getFullYear() && m > earliest.getMonth());
      content = `<div class="jnav"><button data-act="jPrev" aria-label="Previous month"${canPrev ? '' : ' disabled'}>‹</button><span>${MONF[m]} ${y}</span><button data-act="jNext" aria-label="Next month"${S.jMo >= 0 ? ' disabled' : ''}>›</button></div>
        <div class="dows" aria-hidden="true"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div>
        <div class="month">${cells.join('')}</div>
        <p class="jsum">${total} butterfl${total === 1 ? 'y' : 'ies'} in ${MONF[m]}${best ? ' · best day: ' + best.d + ' ' + MON[m] + ' with ' + best.n : ''}</p>`;
    }
    return `<div class="panel paper notebook pinkframe fade-in">${bar({ back: 'home' })}
      <div class="body" style="gap:8px">
        <div class="row" style="align-items:center"><h1 style="flex:1">Butterfly journal</h1><img src="${A('bloombytelogo.png')}" alt="" style="width:24px;height:24px;flex:none"></div>
        <div class="tabs" role="tablist">${tabs}</div>
        ${content}
      </div></div>`;
  }

  /* ---------- mini widget ---------- */
  function vMini() {
    const v = sessionActive() ? S.flowView : 'idle';
    let left, main, ctl;
    const expandBtn = `<button class="icon-btn" data-act="expand" aria-label="Expand widget" title="Expand">${ICON.expand}</button>`;
    if ((v === 'running' || v === 'dump' || v === 'confirm') && S.phase) {
      const s = stage(), p = S.phase;
      left = `<img class="stage" data-live="stage" src="${STAGES[s - 1]}" alt="${STAGE_ALT[s - 1]}">`;
      main = `<div style="min-width:0"><div class="t" data-live="time">${fmt(remainingMs())}</div><div class="sub" data-live="miniSub">Session ${S.run.index}/${S.run.total} · ${p.paused ? 'Paused' : 'Stage ' + s + ' of 7'}</div></div>`;
      ctl = `<button class="icon-btn play" data-act="pause" aria-label="${p.paused ? 'Resume' : 'Pause'}">${p.paused ? ICON.play : ICON.pause}</button>${expandBtn}`;
    } else if (v === 'break' && S.phase) {
      left = `<img class="stage bob" src="${STAGES[6]}" alt="Butterfly resting">`;
      main = `<div style="min-width:0"><div class="t" data-live="time">${fmt(remainingMs())}</div><div class="sub">${S.phase.kind === 'long' ? 'Long break' : 'Break · next is ' + (S.run.index + 1) + '/' + S.run.total}</div></div>`;
      ctl = `<button class="icon-btn" data-act="${S.phase.kind === 'long' ? 'endLong' : 'next'}" aria-label="Skip break" title="Skip break">${ICON.skip}</button>${expandBtn}`;
    } else if (v === 'done') {
      left = `<img class="stage bob" src="${STAGES[6]}" alt="Butterfly">`;
      main = `<div style="min-width:0"><div class="title">It hatched!</div><div class="sub">Tap to log your butterfly</div></div>`;
      ctl = expandBtn;
    } else if (v === 'breakOver') {
      left = `<img class="stage" src="${STAGES[0]}" alt="Caterpillar">`;
      main = `<div style="min-width:0"><div class="title">Break's over</div><div class="sub">Session ${S.run.index + 1} of ${S.run.total} is ready</div></div>`;
      ctl = `<button class="icon-btn play" data-act="next" aria-label="Start next session">${ICON.play}</button>${expandBtn}`;
    } else if (v === 'wrap') {
      left = `<img class="stage" src="${STAGES[6]}" alt="Butterfly">`;
      main = `<div style="min-width:0"><div class="title">${hatchedToday()} today</div><div class="sub">Set complete, nice work</div></div>`;
      ctl = expandBtn;
    } else {
      left = `<img class="logo" src="${A('bloombytelogo.png')}" alt="">`;
      main = `<div style="min-width:0"><div class="title">Ready to focus</div><div class="sub">${S.cfg.focus} min · ${S.cfg.n} session${S.cfg.n === 1 ? '' : 's'} · ${hatchedToday()} today</div></div>`;
      ctl = `<button class="icon-btn play" data-act="quickStart" aria-label="Start focusing" title="Start">${ICON.play}</button>${expandBtn}`;
    }
    const tint = v === 'break' || v === 'confirm' ? 'dusk pinkframe' : (v === 'done' || v === 'wrap' ? 'sky pinkframe' : 'sky');
    return `<div class="panel mini ${tint}"><div class="grip" title="Drag to move" aria-hidden="true"><span></span></div>
      <div class="mini-row"><button class="open" data-act="expand" aria-label="Open BloomByte widget">${left}${main}</button><div class="ctl">${ctl}</div></div></div>`;
  }

  /* ---------- render ---------- */
  let lastMode = null;
  const VIEWS = { splash: vSplash, onboard: vOnboard, home: vHome, notes: vNotes, noteEdit: vNoteEdit, journal: vJournal, setup: vSetup, running: vRunning, dump: vDump, confirm: vConfirm, done: vDone, break: vBreak, breakOver: vBreakOver, wrap: vWrap };
  function render() {
    // Guard against flow views without the state they need.
    if (['running', 'dump', 'confirm'].includes(S.view) && !(S.phase && S.phase.kind === 'focus')) S.view = sessionActive() ? S.flowView : 'home';
    if (S.view === 'break' && !S.phase) S.view = 'home';
    if (['done', 'breakOver', 'wrap'].includes(S.view) && !S.run) S.view = 'home';
    if (S.layout !== lastMode) { if (lastMode !== null) api.setLayout(S.layout); lastMode = S.layout; }
    document.body.dataset.layout = S.layout;
    $app.innerHTML = S.layout === 'mini' ? vMini() : (VIEWS[S.view] || vHome)();
    if (S.layout === 'mini') return;
    if (FLOW.includes(S.view)) { const bd = $app.querySelector('.body'); if (bd) bd.classList.add('mid'); }
    if (S.refocus) {
      const el = document.querySelector(S.refocus);
      if (el) { el.focus(); if (el.setSelectionRange && el.type !== 'number') { const l = el.value.length; try { el.setSelectionRange(l, l); } catch (e) {} } }
      S.refocus = null;
    } else if (S.view === 'dump') { const el = document.getElementById('thought'); if (el) el.focus(); }
    else if (S.view === 'onboard') { const el = document.getElementById('uname'); if (el) { el.focus(); const l = el.value.length; el.setSelectionRange(l, l); } }
  }
  function updateLive() {
    if (!S.phase) return;
    const t = fmt(remainingMs());
    document.querySelectorAll('[data-live="time"]').forEach((el) => { if (el.textContent !== t) el.textContent = t; });
    if (S.phase.kind !== 'focus') return;
    const s = stage(), src = STAGES[s - 1];
    document.querySelectorAll('[data-live="stage"],[data-live="stageSmall"]').forEach((el) => { if (!el.src.endsWith(src)) { el.src = src; el.alt = STAGE_ALT[s - 1]; } });
    const sg = document.querySelector('[data-live="segs"]'); if (sg) { const h = segs(); if (sg.innerHTML !== h) sg.innerHTML = h; }
    const note = document.querySelector('[data-live="note"]'); if (note) note.textContent = 'Stage ' + s + ' of 7 · ' + STAGE_NOTE[s - 1];
    const ms = document.querySelector('[data-live="miniSub"]'); if (ms) ms.textContent = 'Session ' + S.run.index + '/' + S.run.total + ' · ' + (S.phase.paused ? 'Paused' : 'Stage ' + s + ' of 7');
  }
  function markSaving() {
    const el = document.querySelector('[data-live="saved"]');
    if (el) el.innerHTML = 'Saving…';
    persist(() => { const e2 = document.querySelector('[data-live="saved"]'); if (e2) e2.innerHTML = ICON.check + ' Saved'; });
  }

  /* ---------- events ---------- */
  function addDump() { const t = S.draft.trim(); if (!t) return; S.dump.push(t); S.draft = ''; render(); }
  const actions = {
    saveName: () => saveName(),
    toggleSound: () => { const on = !soundOn(); data.settings = { ...(data.settings || {}), sound: on }; persist(); if (on) sfx('tick'); render(); },
    editName: () => { S.editingName = true; go('onboard'); },
    expand: () => { S.layout = 'widget'; render(); },
    toMini: () => { S.layout = 'mini'; render(); },
    toWidget: () => { S.layout = 'widget'; render(); },
    toApp: () => { S.layout = 'app'; render(); },
    minimize: () => api.minimize(),
    maximize: () => api.maximize(),
    close: () => api.close(!!S.phase),
    nav: (el) => go(el.dataset.v),
    toFlow: () => go(sessionActive() ? S.flowView : 'setup'),
    focus: (el) => { S.cfg.focus = +el.dataset.v; S.cfg.custom = false; saveSettings(); render(); },
    custom: () => { S.cfg.custom = true; S.refocus = '[data-input="customFocus"]'; render(); const i = document.querySelector('[data-input="customFocus"]'); if (i) i.select(); },
    brk: (el) => { S.cfg.brk = +el.dataset.v; saveSettings(); render(); },
    dec: () => { S.cfg.n = Math.max(1, S.cfg.n - 1); saveSettings(); render(); },
    inc: () => { S.cfg.n = Math.min(8, S.cfg.n + 1); saveSettings(); render(); },
    start: () => startSet(),
    quickStart: () => startSet(),
    pause: () => togglePause(),
    addDump,
    rmDump: (el) => { S.dump.splice(+el.dataset.i, 1); render(); },
    endEarly: () => endEarly(),
    mood: (el) => { const r = record(S.last); if (r) { r.mood = el.dataset.v; persist(); } render(); },
    keepDump: () => keepDumpAsNote(),
    break: () => startBreak(),
    next: () => nextSession(),
    endLong: () => { S.phase = null; S.run = null; flowGo('setup'); },
    wrap: () => { S.phase = null; go('wrap'); },
    long: () => startLongBreak(),
    newSet: () => { S.run = null; go('setup'); },
    newNote: () => { const n = newNote(); S.noteId = n.id; S.refocus = '#ntitle'; S.toast = null; go('noteEdit'); },
    openNote: (el) => openNote(el.dataset.v),
    delNote: () => deleteNote(),
    undo: () => { if (S.toast && S.toast.undo) S.toast.undo(); S.toast = null; render(); },
    sort: () => { S.sort = S.sort === 'recent' ? 'az' : 'recent'; render(); },
    clearSearch: () => { S.search = ''; render(); },
    focusOnNote: () => { const n = note(S.noteId); if (n && n.title.trim()) S.goal = n.title.trim(); saveSettings(); go(sessionActive() ? S.flowView : 'setup'); },
    jTab: (el) => { S.jView = el.dataset.v; render(); },
    jOpen: (el) => { S.jSel = +el.dataset.v; S.jView = 'Day'; render(); },
    jPrev: () => { if (S.jView === 'Day') S.jSel = addDays(S.jSel, -1); else if (S.jView === 'Week') S.jWk--; else S.jMo--; render(); },
    jNext: () => { if (S.jView === 'Day') S.jSel = Math.min(dayStart(now()), addDays(S.jSel, 1)); else if (S.jView === 'Week') S.jWk = Math.min(0, S.jWk + 1); else S.jMo = Math.min(0, S.jMo + 1); render(); }
  };
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.act];
    if (fn) { e.preventDefault(); sfx(sfxFor(el.dataset.act)); fn(el); }
  });
  document.addEventListener('input', (e) => {
    const k = e.target.dataset && e.target.dataset.input; if (!k) return;
    const v = e.target.value;
    if (k === 'goal') { S.goal = v; saveSettings(); }
    else if (k === 'draft') S.draft = v;
    else if (k === 'caption') { const r = record(S.last); if (r) { r.caption = v; persist(); } }
    else if (k === 'customFocus') { const n = Math.round(+v); if (n >= 1 && n <= 180) { S.cfg.focus = n; saveSettings(); } }
    else if (k === 'uname') { S.pendingName = v; const b = document.querySelector('.onb-go'); if (b) b.disabled = !v.trim(); }
    else if (k === 'search') { S.search = v; S.refocus = '#search'; render(); }
    else if (k === 'ntitle' || k === 'nbody') { const n = note(S.noteId); if (n) { n[k === 'ntitle' ? 'title' : 'body'] = v; n.updated = now(); markSaving(); } }
  });
  document.addEventListener('change', (e) => {
    if (e.target.dataset && e.target.dataset.input === 'customFocus') { S.cfg.focus = Math.min(180, Math.max(5, Math.round(+e.target.value) || 25)); saveSettings(); render(); }
  });
  document.addEventListener('keydown', (e) => {
    const k = e.target.dataset && e.target.dataset.input;
    if (e.key === 'Enter' && k === 'draft') { e.preventDefault(); if (S.draft.trim()) sfx('up'); addDump(); }
    if (e.key === 'Enter' && k === 'uname') { e.preventDefault(); if (e.target.value.trim()) sfx('save'); saveName(); }
    if (e.key === 'Enter' && k === 'customFocus') e.target.blur();
    if (e.key === 'Enter' && k === 'ntitle') { e.preventDefault(); const b = document.getElementById('nbody'); if (b) b.focus(); }
  });

  /* ---------- boot ---------- */
  api.load().then((d) => {
    data = { sessions: [], notes: [], settings: {}, ...(d || {}) };
    data.sessions = data.sessions || []; data.notes = data.notes || [];
    const st = data.settings || {};
    if (st.focus) { S.cfg.focus = st.focus; S.cfg.custom = ![25, 50, 90].includes(st.focus); }
    if (st.brk) S.cfg.brk = st.brk;
    if (st.n) S.cfg.n = st.n;
    if (st.lastGoal) S.goal = st.lastGoal;
    api.onLayout((l) => { S.layout = l; lastMode = l; render(); });
    api.onMaximized((m) => { S.maximized = m; render(); });
    const bootStarted = now();
    render();
    setInterval(tick, 250);
    // Keep the splash up briefly, then onboarding on first run, otherwise home.
    setTimeout(() => { go(data.settings && data.settings.name ? 'home' : 'onboard'); }, Math.max(0, 1900 - (now() - bootStarted)));
  });

  window.__bb = { S, render, actions, go, greeting: (d) => greeting(d), get data() { return data; }, set data(v) { data = v; } };
})();
