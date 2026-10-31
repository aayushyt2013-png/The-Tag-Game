/* TAG - game loop, input and physics.
 * Rendering is plain DOM + CSS (see style.css); level data and stats come from the Python backend. */
(() => {
  'use strict';

  // ---- tuning ---------------------------------------------------------
  const STEP = 1 / 120;          // fixed physics step (seconds)
  const GRAVITY = 1900;
  const JUMP = 700;              // jump launch speed (px/s)
  const JUMP_CUT = 260;          // releasing jump early caps upward speed here
  const PAD_LAUNCH = 1100;
  const SPEED = 270;
  const IT_SPEED = 1.08;         // the chaser is a little faster
  const MAX_FALL = 950;
  const COYOTE = 0.1;            // grace time to jump after leaving a ledge
  const JUMP_BUFFER = 0.12;      // grace time for pressing jump just before landing
  const TAG_LOCK = 1.0;          // nobody can be tagged right after a tag
  const PORTAL_COOLDOWN = 1.0;
  const COUNTDOWN = 3;
  const PORTAL_FIRST = 5;        // seconds before the first portal of a round
  const PORTAL_RELOCATE = 10;    // an unused portal vanishes and reappears elsewhere after this long
  const PORTAL_EXIT_LIFE = 3;    // the exit portal stays open this long
  const PORTAL_GAP = 6;          // pause before the next portal appears
  const ROUND_SECONDS = 120;     // fixed round length
  const HURRY_AT = 5;

  const PLAYER_COLORS = ['#ff5d73', '#4da3ff', '#52d681', '#ffb347'];
  const CONTROLS = [
    { left: 'KeyA',       right: 'KeyD',       jump: 'KeyW',    label: 'A / D / W' },
    { left: 'ArrowLeft',  right: 'ArrowRight', jump: 'ArrowUp', label: '← / → / ↑' },
    { left: 'KeyJ',       right: 'KeyL',       jump: 'KeyI',    label: 'J / L / I' },
    { left: 'Numpad4',    right: 'Numpad6',    jump: 'Numpad8', label: 'Num 4 / 6 / 8' },
  ];
  const SPAWN_SLOTS = { 2: [0, 3], 3: [0, 3, 1], 4: [0, 1, 2, 3] };

  // ---- state ----------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const el = {
    frame: $('#frame'), hud: $('#hud'), chips: $('#chips'), timer: $('#timer'),
    timerNum: $('#timer-num'), timerBar: $('#timer-bar i'), roundLabel: $('#round-label'),
    arena: $('#arena'), banner: $('#banner'), menu: $('#menu'), over: $('#over'),
    overTitle: $('#over-title'), overSub: $('#over-sub'), standings: $('#standings'),
    controls: $('#controls'), error: $('#error'),
  };

  const state = {
    level: null,            // payload from /api/maps
    mapId: 'playground',
    nPlayers: 2,
    seconds: ROUND_SECONDS,
    phase: 'menu',          // menu | countdown | play | over
    players: [],
    scores: [0, 0, 0, 0],
    round: 0,
    timeLeft: 0,
    countdown: 0,
    lock: 0,
    tags: 0,
    padEls: [],
  };
  const held = new Set();
  let bag = [];               // shuffled map rotation

  // ---- sound (synthesized with Web Audio, no audio files) -------------
  const sfx = (() => {
    let ctx = null, master = null, muted = false;
    try { muted = localStorage.getItem('tag-muted') === '1'; } catch {}
    function ensure() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain(); master.gain.value = 0.35; master.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function tone({ f = 440, f2 = 0, t = 0.15, type = 'square', vol = 0.3, delay = 0 }) {
      if (muted || !ensure()) return;
      const t0 = ctx.currentTime + delay, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t0);
      if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + t);
      g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + t);
      o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + t + 0.02);
    }
    function noise(t, vol, freq, type = 'lowpass') {
      if (muted || !ensure()) return;
      const n = Math.floor(ctx.sampleRate * t), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = buf; f.type = type; f.frequency.value = freq;
      g.gain.setValueAtTime(vol, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t);
      s.connect(f); f.connect(g); g.connect(master); s.start();
    }
    return {
      unlock: () => { ensure(); },
      sync() {
        const b = document.getElementById('mute');
        if (b) { b.textContent = muted ? '🔇' : '🔊'; b.setAttribute('aria-pressed', String(muted)); }
      },
      toggle() {
        muted = !muted;
        try { localStorage.setItem('tag-muted', muted ? '1' : '0'); } catch {}
        this.sync();
        if (!muted) this.ui();
      },
      ui:     () => tone({ f: 500, f2: 800, t: 0.1, vol: 0.18 }),
      jump:   () => tone({ f: 320, f2: 640, t: 0.14, type: 'sine', vol: 0.35 }),
      land:   (impact) => noise(0.09, Math.min(0.3, 0.12 + impact / 6000), 500),
      pad:    () => { tone({ f: 180, f2: 900, t: 0.28, vol: 0.22 }); tone({ f: 360, f2: 1200, t: 0.2, type: 'sine', vol: 0.2, delay: 0.03 }); },
      portal: () => { tone({ f: 900, f2: 250, t: 0.25, type: 'triangle', vol: 0.3 }); tone({ f: 250, f2: 900, t: 0.25, type: 'triangle', vol: 0.3, delay: 0.12 }); },
      tag:    () => { noise(0.12, 0.35, 2500, 'highpass'); tone({ f: 520, f2: 110, t: 0.28, type: 'sawtooth', vol: 0.3 }); tone({ f: 880, t: 0.08, vol: 0.2, delay: 0.02 }); },
      open:   () => tone({ f: 300, f2: 900, t: 0.2, type: 'sine', vol: 0.15 }),
      count:  () => tone({ f: 660, t: 0.14, vol: 0.22 }),
      go:     () => { tone({ f: 880, t: 0.12, vol: 0.25 }); tone({ f: 1320, t: 0.3, vol: 0.25, delay: 0.1 }); },
      tick:   () => tone({ f: 1000, t: 0.05, type: 'sine', vol: 0.25 }),
      end:    () => { [440, 330, 247].forEach((f, i) => tone({ f, t: 0.22, type: 'sawtooth', vol: 0.25, delay: i * 0.15 })); tone({ f: 165, t: 0.5, type: 'sawtooth', vol: 0.25, delay: 0.45 }); },
    };
  })();

  // ---- backend --------------------------------------------------------
  async function api(path, options) {
    const res = await fetch(path, options);
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return res.json();
  }

  function postResult(loser) {
    return api('/api/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        map: state.mapId, players: state.nPlayers, loser,
        seconds: state.seconds, tags: state.tags,
      }),
    }).catch(() => {});
  }

  // ---- start popup + map rotation -------------------------------------
  function renderControls() {
    el.controls.innerHTML = CONTROLS.map((c, i) =>
      `<button type="button" class="ctl ${i < state.nPlayers ? '' : 'off'}" style="--c:${PLAYER_COLORS[i]}" ` +
      `title="Play with ${Math.max(2, i + 1)} players"><b>P${i + 1}</b>${c.label}</button>`
    ).join('');
    el.controls.querySelectorAll('.ctl').forEach((b, i) => b.addEventListener('click', () => {
      b.blur();
      if (state.phase !== 'menu') return;
      state.nPlayers = Math.max(2, i + 1);
      sfx.ui();
      renderControls();
      showStage();
    }));
  }

  // every round gets a different map: shuffle them all, play through, reshuffle
  function drawMap() {
    if (!bag.length) {
      bag = [...state.level.order].sort(() => Math.random() - 0.5);
      if (bag.length > 1 && bag[0] === state.mapId) bag.push(bag.shift());
    }
    return bag.shift();
  }

  // live arena behind the popup
  function showStage() {
    const order = state.level.order;
    state.phase = 'menu';
    state.mapId = order[Math.floor(Math.random() * order.length)];
    state.timeLeft = state.seconds;
    state.lock = 0;
    const map = state.level.maps[state.mapId];
    buildArena(map);
    makePlayers(map);
    el.hud.hidden = false;
    el.roundLabel.textContent = map.name;
    renderHud();
    render();
  }

  // ---- particles ------------------------------------------------------
  function fx(cls, x, y, vars = {}, ttl = 700, text = '') {
    const d = document.createElement('i');
    d.className = 'fx ' + cls;
    d.style.left = x + 'px'; d.style.top = y + 'px';
    for (const k in vars) d.style.setProperty(k, vars[k]);
    if (text) d.textContent = text;
    el.arena.appendChild(d);
    setTimeout(() => d.remove(), ttl);   // timeout, not animationend: reduced-motion disables animations
  }
  function sparks(x, y, color, n, spread = 70, up = false) {
    for (let i = 0; i < n; i++) {
      const a = up ? -Math.PI * (0.15 + 0.7 * Math.random()) : Math.random() * Math.PI * 2;
      const s = spread * (0.5 + Math.random() * 0.8);
      fx('spark', x, y, { '--c': color, '--dx': Math.cos(a) * s + 'px', '--dy': Math.sin(a) * s + 'px' });
    }
  }
  const ring = (x, y, color) => fx('ring', x, y, { '--c': color });
  function dust(x, y, n = 4) {
    for (let i = 0; i < n; i++) fx('dust', x + (Math.random() - 0.5) * 18, y - 3, { '--dx': (Math.random() - 0.5) * 50 + 'px' }, 500);
  }
  function shake() {
    el.arena.classList.remove('shake'); void el.arena.offsetWidth; el.arena.classList.add('shake');
  }

  // ---- arena building -------------------------------------------------
  function place(node, r) {
    node.style.left = r.x + 'px'; node.style.top = r.y + 'px';
    node.style.width = r.w + 'px'; node.style.height = r.h + 'px';
  }

  function buildArena(map) {
    el.arena.innerHTML = '';
    state.portal = { mode: 'wait', t: PORTAL_FIRST, entry: null, exit: null };
    map.platforms.forEach((r, i) => {
      const d = document.createElement('div');
      d.className = 'platform ' + (r.solid ? 'solid' : 'oneway');
      d.style.setProperty('--i', i);
      place(d, r); el.arena.appendChild(d);
    });
    state.padEls = map.pads.map((r) => {
      const d = document.createElement('div');
      d.className = 'pad'; place(d, r); el.arena.appendChild(d); return d;
    });
    map.portals.forEach((r) => {
      const d = document.createElement('div');
      d.className = 'portal'; place(d, r); el.arena.appendChild(d);
    });
  }

  function makePlayers(map) {
    const size = state.level.arena.player;
    const slots = SPAWN_SLOTS[state.nPlayers];
    state.players = slots.map((slot, i) => {
      const [x, y] = map.spawns[slot];
      const node = document.createElement('div');
      node.className = 'player spawning';
      node.style.setProperty('--n', i);
      node.addEventListener('animationend', (e) => {
        if (e.animationName === 'spawn') node.classList.remove('spawning');
        if (e.animationName === 'pop') node.classList.remove('pop');
        if (e.animationName === 'land') node.classList.remove('land');
      });
      node.dataset.id = String(i + 1);
      node.dataset.face = i % 2 === 0 ? '1' : '-1';
      node.innerHTML = `<div class="body"><span class="eye"></span><span class="eye"></span><span class="tag-no">${i + 1}</span></div>`;
      el.arena.appendChild(node);
      return {
        id: i + 1, node, x, y, w: size, h: size, vx: 0, vy: 0,
        onGround: true, coyote: 0, jumpBuf: 0, jumpWasDown: false, padded: false,
        portalCd: 0, dustT: 0, face: i % 2 === 0 ? 1 : -1, it: false,
      };
    });
    const first = state.players[Math.floor(Math.random() * state.players.length)];
    first.it = true;
  }

  // ---- round flow -----------------------------------------------------
  function startMatch() {
    state.scores = [0, 0, 0, 0];
    state.round = 0;
    sfx.ui();
    startRound();
  }

  function startRound() {
    state.mapId = drawMap();
    const map = state.level.maps[state.mapId];
    state.round += 1;
    state.timeLeft = state.seconds;
    state.countdown = COUNTDOWN;
    state.lock = 0;
    state.tags = 0;
    buildArena(map);
    makePlayers(map);
    el.menu.hidden = true;
    el.over.hidden = true;
    el.hud.hidden = false;
    el.roundLabel.textContent = `Round ${state.round} · ${map.name}`;
    state.phase = 'countdown';
    renderHud();
    render();
  }

  function finishRound() {
    state.phase = 'over';
    el.banner.hidden = true;
    const loser = state.players.find((p) => p.it);
    state.players.forEach((p) => { if (p !== loser) state.scores[p.id - 1] += 1; });
    postResult(loser.id);
    sfx.end();

    el.overTitle.textContent = `P${loser.id} got caught!`;
    el.overTitle.style.color = PLAYER_COLORS[loser.id - 1];
    el.overSub.textContent = `Still "it" when time ran out • ${state.tags} tag${state.tags === 1 ? '' : 's'} this round`;
    el.standings.innerHTML = state.players.map((p, i) =>
      `<div class="stand ${p === loser ? 'lost' : ''}" style="--c:${PLAYER_COLORS[p.id - 1]};--i:${i}"><span>P${p.id}</span><b>${state.scores[p.id - 1]}</b></div>`
    ).join('');
    el.over.hidden = false;
    $('#again').focus({ preventScroll: true });
  }

  function toMenu() {
    state.phase = 'menu';
    el.over.hidden = true;
    el.hud.hidden = true;
    el.banner.hidden = true;
    el.menu.hidden = false;
    showStage();
  }

  // ---- physics --------------------------------------------------------
  const overlapX = (a, r) => a.x < r.x + r.w && a.x + a.w > r.x;
  const overlap = (a, r) => overlapX(a, r) && a.y < r.y + r.h && a.y + a.h > r.y;
  const approach = (v, target, delta) =>
    v < target ? Math.min(v + delta, target) : Math.max(v - delta, target);

  function movePlayer(p, map, dir, jumpDown, dt) {
    const arena = state.level.arena;
    if (dir) p.face = dir;

    // horizontal control (snappier on the ground)
    const top = SPEED * (p.it ? IT_SPEED : 1);
    p.vx = approach(p.vx, dir * top, (p.onGround ? 3600 : 2200) * dt);

    // jump: buffered press + coyote time
    p.coyote = p.onGround ? COYOTE : p.coyote - dt;
    p.jumpBuf -= dt;
    if (p.jumpBuf > 0 && p.coyote > 0) {
      if (p.onGround) dust(p.x + p.w / 2, p.y + p.h, 4);
      sfx.jump();
      p.vy = -JUMP; p.jumpBuf = 0; p.coyote = 0; p.onGround = false; p.padded = false;
    }
    if (!jumpDown && p.vy < -JUMP_CUT && !p.padded) p.vy = -JUMP_CUT; // short hop

    p.vy = Math.min(p.vy + GRAVITY * dt, MAX_FALL);

    // --- X axis against solid blocks
    p.x += p.vx * dt;
    if (p.x < 0) { p.x = 0; p.vx = 0; }
    if (p.x + p.w > arena.w) { p.x = arena.w - p.w; p.vx = 0; }
    for (const r of map.platforms) {
      if (!r.solid || !overlap(p, r)) continue;
      if (p.vx > 0) p.x = r.x - p.w; else if (p.vx < 0) p.x = r.x + r.w;
      p.vx = 0;
    }

    // --- Y axis
    const prevTop = p.y, prevBottom = p.y + p.h;
    const wasAir = !p.onGround, impact = p.vy;
    p.y += p.vy * dt;
    p.onGround = false;
    for (const r of map.platforms) {
      if (!overlapX(p, r)) continue;
      const crossedTop = prevBottom <= r.y + 0.01 && p.y + p.h > r.y;
      if (p.vy >= 0 && crossedTop) {                       // land on top (solid or one-way)
        p.y = r.y - p.h; p.vy = 0; p.onGround = true; p.padded = false;
      } else if (r.solid && p.vy < 0 && prevTop >= r.y + r.h - 0.01 && p.y < r.y + r.h) {
        p.y = r.y + r.h; p.vy = 0;                         // bonk head
      }
    }

    // landing squash + running dust
    if (wasAir && p.onGround && impact > 420) {
      dust(p.x + p.w / 2, p.y + p.h, 5);
      sfx.land(impact);
      p.node.classList.remove('land'); void p.node.offsetWidth; p.node.classList.add('land');
    }
    if (p.onGround && Math.abs(p.vx) > 120) {
      p.dustT -= dt;
      if (p.dustT <= 0) { p.dustT = 0.13; dust(p.x + p.w / 2 - p.face * 10, p.y + p.h, 1); }
    }

    // pads
    map.pads.forEach((r, i) => {
      if (p.vy >= 0 && overlap(p, r)) {
        p.vy = -PAD_LAUNCH; p.padded = true; p.onGround = false;
        ring(r.x + r.w / 2, r.y, '#ffd23f'); sparks(r.x + r.w / 2, r.y, '#ffd23f', 8, 90, true); sfx.pad();
        const d = state.padEls[i];
        d.classList.remove('boing'); void d.offsetWidth; d.classList.add('boing');
      }
    });

    // portals
    p.portalCd -= dt;
    if (p.portalCd <= 0) {
      for (const r of map.portals) {
        if (!overlap(p, r)) continue;
        const to = map.portals.find((q) => q.id === r.to);
        if (!to) break;
        p.x = to.x + to.w / 2 - p.w / 2;
        p.y = to.y + to.h - p.h;
        ring(r.x + r.w / 2, r.y + r.h / 2, '#c07bff');
        ring(to.x + to.w / 2, to.y + to.h / 2, '#c07bff');
        sparks(to.x + to.w / 2, to.y + to.h / 2, '#c07bff', 10, 80);
        sfx.portal();
        p.portalCd = PORTAL_COOLDOWN;
        break;
      }
    }
  }

  // ---- one-use portals ------------------------------------------------
  // wait -> entry portal appears -> a player steps in (it vanishes) -> exit portal
  // appears at another spot and the player arrives there -> exit closes -> wait.
  // An unused entry portal vanishes and reappears somewhere else after a while.
  function pickSpot(map, avoid, minDist) {
    const spots = map.portal_spots;
    const far = (s) => !avoid || (s !== avoid && Math.hypot(s[0] - avoid[0], s[1] - avoid[1]) >= minDist);
    const clear = (s) => state.players.every((p) => Math.hypot(p.x + p.w / 2 - s[0], p.y + p.h / 2 - (s[1] - 28)) > 90);
    let pool = spots.filter((s) => far(s) && clear(s));
    if (!pool.length) pool = spots.filter((s) => s !== avoid);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function openPortal(spot, kind) {
    const r = { x: spot[0] - 17, y: spot[1] - 56, w: 34, h: 56, spot };
    r.node = document.createElement('div');
    r.node.className = 'portal dyn ' + kind;
    place(r.node, r);
    el.arena.appendChild(r.node);
    ring(spot[0], spot[1] - 28, kind === 'exit' ? '#2effc0' : '#c07bff');
    sfx.open();
    return r;
  }

  function closePortal(r) {
    if (!r) return;
    r.node.classList.add('closing');
    setTimeout(() => r.node.remove(), 400);
  }

  function updatePortals(dt, map) {
    const P = state.portal;
    if (!P || !map.portal_spots || !map.portal_spots.length) return;
    P.t -= dt;
    if (P.mode === 'wait') {
      if (P.t <= 0) { P.entry = openPortal(pickSpot(map, null, 0), 'entry'); P.mode = 'entry'; P.t = PORTAL_RELOCATE; }
    } else if (P.mode === 'entry') {
      const p = state.players.find((q) => overlap(q, P.entry));
      if (p) {
        const from = P.entry;
        const dest = pickSpot(map, from.spot, 250);
        ring(from.x + from.w / 2, from.y + from.h / 2, '#c07bff');
        sparks(from.x + from.w / 2, from.y + from.h / 2, '#c07bff', 10, 80);
        closePortal(from); P.entry = null;
        P.exit = openPortal(dest, 'exit');
        p.x = P.exit.x + P.exit.w / 2 - p.w / 2;
        p.y = P.exit.y + P.exit.h - p.h;
        p.vy = 0;
        sparks(P.exit.x + P.exit.w / 2, P.exit.y + P.exit.h / 2, '#2effc0', 10, 80);
        sfx.portal();
        P.mode = 'exit'; P.t = PORTAL_EXIT_LIFE;
      } else if (P.t <= 0) {
        const old = P.entry;
        closePortal(old);
        P.entry = openPortal(pickSpot(map, old.spot, 150), 'entry');
        P.t = PORTAL_RELOCATE;
      } else {
        P.entry.node.classList.toggle('warn', P.t < 1.5);
      }
    } else if (P.mode === 'exit' && P.t <= 0) {
      closePortal(P.exit); P.exit = null;
      P.mode = 'wait'; P.t = PORTAL_GAP;
    }
  }

  function step(dt) {
    if (state.freeze > 0) { state.freeze -= dt; return; }
    const map = state.level.maps[state.mapId];

    for (const p of state.players) {
      const c = CONTROLS[p.id - 1];
      const dir = (held.has(c.right) ? 1 : 0) - (held.has(c.left) ? 1 : 0);
      movePlayer(p, map, dir, held.has(c.jump), dt);
    }
    updatePortals(dt, map);

    // tagging
    if (state.lock > 0) {
      state.lock -= dt;
    } else {
      const it = state.players.find((p) => p.it);
      const inset = 3; // forgiving hitbox
      const victim = state.players.find((q) => q !== it &&
        it.x + inset < q.x + q.w - inset && it.x + it.w - inset > q.x + inset &&
        it.y + inset < q.y + q.h - inset && it.y + it.h - inset > q.y + inset);
      if (victim) {
        it.it = false; victim.it = true;
        state.lock = TAG_LOCK; state.tags += 1;
        victim.node.classList.remove('pop'); void victim.node.offsetWidth; victim.node.classList.add('pop');
        const cx = victim.x + victim.w / 2, cy = victim.y + victim.h / 2;
        sparks(cx, cy, '#ffd23f', 14, 90);
        ring(cx, cy, PLAYER_COLORS[victim.id - 1]);
        fx('float', cx, victim.y - 8, { '--c': '#ffd23f' }, 900, 'TAG!');
        shake();
        sfx.tag();
        state.freeze = 0.06;   // tiny hit-stop so tags feel punchy
        renderHud();
      }
    }

    state.timeLeft -= dt;
    if (state.timeLeft <= 0) { state.timeLeft = 0; finishRound(); }
  }

  // ---- rendering ------------------------------------------------------
  function renderHud() {
    el.chips.innerHTML = state.players.map((p) =>
      `<div class="chip ${p.it ? 'it' : ''}" style="--c:${PLAYER_COLORS[p.id - 1]}"><i></i>P${p.id}<b>${state.scores[p.id - 1]}</b></div>`
    ).join('');
  }

  function render() {
    for (const p of state.players) {
      p.node.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
      p.node.dataset.face = String(p.face);
      p.node.classList.toggle('it', p.it);
      p.node.classList.toggle('locked', p.it && state.lock > 0);
      p.node.classList.toggle('air', !p.onGround);
      p.node.classList.toggle('run', p.onGround && Math.abs(p.vx) > 60);
    }
    const t = Math.ceil(state.timeLeft);
    const label = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    if (el.timerNum.textContent !== label) {
      el.timerNum.textContent = label;
      if (state.phase === 'play') { el.timerNum.classList.remove('tick'); void el.timerNum.offsetWidth; el.timerNum.classList.add('tick'); if (state.timeLeft <= HURRY_AT) sfx.tick(); }
    }
    el.timerBar.style.setProperty('--t', (state.timeLeft / state.seconds).toFixed(3));
    const hurry = state.phase === 'play' && state.timeLeft <= HURRY_AT;
    el.timer.classList.toggle('hurry', hurry);
    el.arena.classList.toggle('hurry', hurry);
  }

  // ---- main loop ------------------------------------------------------
  let last = 0, acc = 0;
  function frame(ts) {
    const dt = Math.min((ts - last) / 1000 || 0, 0.1);
    last = ts;

    if (state.phase === 'countdown') {
      const before = Math.ceil(state.countdown);
      state.countdown -= dt;
      const now = Math.ceil(state.countdown);
      if (state.countdown <= 0) {
        state.phase = 'play';
        state.players.forEach((p) => { p.jumpBuf = 0; }); // ignore presses made during the countdown
        showBanner('GO!'); sfx.go();
        setTimeout(() => { if (state.phase === 'play') el.banner.hidden = true; }, 600);
      } else if (now !== before || el.banner.hidden) {
        showBanner(String(now)); sfx.count();
      }
      render();
    } else if (state.phase === 'play') {
      acc += dt;
      while (acc >= STEP && state.phase === 'play') { step(STEP); acc -= STEP; }
      render();
    }
    requestAnimationFrame(frame);
  }

  function togglePause() {
    if (state.phase === 'play') { state.phase = 'paused'; held.clear(); showBanner('PAUSED'); }
    else if (state.phase === 'paused') { state.phase = 'play'; el.banner.hidden = true; }
  }

  function showBanner(text) {
    el.banner.hidden = true;
    void el.banner.offsetWidth;        // restart the CSS animation
    el.banner.textContent = text;
    el.banner.hidden = false;
  }

  // ---- input ----------------------------------------------------------
  const GAME_KEYS = new Set(CONTROLS.flatMap((c) => [c.left, c.right, c.jump]));

  addEventListener('keydown', (e) => {
    sfx.unlock();
    if (e.code === 'KeyM' && !e.repeat) sfx.toggle();
    const playing = state.phase === 'play' || state.phase === 'countdown';
    if (playing && GAME_KEYS.has(e.code)) e.preventDefault(); // no page scroll on arrows

    if (!e.repeat) {
      held.add(e.code);
      state.players.forEach((p) => { if (CONTROLS[p.id - 1].jump === e.code) p.jumpBuf = JUMP_BUFFER; });
    }

    if (e.code === 'KeyP' && !e.repeat) togglePause();
    if (state.phase === 'paused' && e.code === 'Escape') toMenu();
    if (state.phase === 'menu' && e.code === 'Space') { e.preventDefault(); startMatch(); }
    else if (state.phase === 'over' && e.code === 'Enter') { e.preventDefault(); startRound(); }
    else if (state.phase === 'over' && e.code === 'Escape') toMenu();
    else if (playing && e.code === 'Escape') toMenu();
  });
  addEventListener('keyup', (e) => held.delete(e.code));
  addEventListener('blur', () => { held.clear(); if (state.phase === 'play') togglePause(); }); // auto-pause when you tab away

  // ---- fit the 960x620 frame to any window ----------------------------
  function fit() {
    const s = Math.min(innerWidth / 960, innerHeight / 620);
    el.frame.style.transform = `scale(${s})`;
  }
  addEventListener('resize', fit);

  // ---- boot -----------------------------------------------------------
  // guards stop a focused button from double-firing together with the keyboard shortcut
  $('#start').addEventListener('click', () => { if (state.phase === 'menu') startMatch(); });
  $('#again').addEventListener('click', () => { if (state.phase === 'over') startRound(); });
  $('#to-menu').addEventListener('click', () => { if (state.phase === 'over') toMenu(); });

  $('#mute').addEventListener('click', (e) => { e.currentTarget.blur(); sfx.unlock(); sfx.toggle(); });
  addEventListener('pointerdown', () => sfx.unlock());

  sfx.sync();
  fit();
  api('/api/maps').then((level) => {
    state.level = level;
    renderControls();
    showStage();
    requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });
  }).catch(() => {
    el.error.hidden = false;
    el.error.textContent = 'Could not load maps. Start the backend with: python server.py';
  });

  // handy for debugging / automated tests
  window.__tag = state;
})();