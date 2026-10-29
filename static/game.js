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
    maps: $('#maps'), controls: $('#controls'), stats: $('#stats'), error: $('#error'),
    segHumans: $('#seg-humans'), segBots: $('#seg-bots'), segSkill: $('#seg-skill'),
    grpSkill: $('#grp-skill'), segSeconds: $('#seg-seconds'),
  };

  const state = {
    level: null,            // payload from /api/maps
    mapId: 'playground',
    humans: 2,              // keyboard players (0-4)
    bots: 0,                // computer players (0-4); humans + bots must be 2-4
    botLevel: 'normal',     // easy | normal | hard
    seconds: 30,
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

  // ---- backend --------------------------------------------------------
  async function api(path, options) {
    const res = await fetch(path, options);
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return res.json();
  }

  async function loadStats() {
    try { renderStats(await api('/api/stats')); } catch { el.stats.textContent = ''; }
  }

  function renderStats(s) {
    if (!s.rounds) { el.stats.innerHTML = 'No rounds recorded yet. Go get tagged!'; return; }
    const worst = Object.entries(s.players).sort((a, b) => b[1].caught - a[1].caught)[0];
    el.stats.innerHTML =
      `<b>${s.rounds}</b> round${s.rounds === 1 ? '' : 's'} played on this server<br>` +
      (worst[1].caught ? `Most caught: <b>P${worst[0]}</b> (${worst[1].caught}×)` : '');
  }

  function postResult(loser) {
    return api('/api/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        map: state.mapId, players: total(), loser,
        seconds: state.seconds, tags: state.tags,
      }),
    }).then(renderStats).catch(() => {});
  }

  // ---- menu -----------------------------------------------------------
  function segment(container, values, current, label, onPick) {
    container.innerHTML = '';
    values.forEach((v) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(v === current));
      b.textContent = label(v);
      b.addEventListener('click', () => { onPick(v); });
      container.appendChild(b);
    });
  }

  function previewHTML(map, arena) {
    const sx = 100 / arena.w, sy = 100 / arena.h;
    const box = (r, cls) =>
      `<i class="${cls}" style="left:${r.x * sx}%;top:${r.y * sy}%;width:${r.w * sx}%;height:${Math.max(r.h * sy, 2.5)}%"></i>`;
    return map.platforms.map((p) => box(p, p.solid ? 's' : '')).join('') +
      map.pads.map((p) => box(p, 'pad')).join('') +
      map.portals.map((p) => box(p, 'portal')).join('');
  }

  function renderMenu() {
    // humans + bots is always kept between 2 and 4; the *other* box adjusts when you break that
    segment(el.segHumans, [0, 1, 2, 3, 4], state.humans, String, (h) => {
      state.humans = h;
      if (h + state.bots > 4) state.bots = 4 - h;
      if (h + state.bots < 2) state.bots = 2 - h;
      renderMenu();
    });
    segment(el.segBots, [0, 1, 2, 3, 4], state.bots, String, (b) => {
      state.bots = b;
      if (state.humans + b > 4) state.humans = 4 - b;
      if (state.humans + b < 2) state.humans = 2 - b;
      renderMenu();
    });
    segment(el.segSkill, Object.keys(BOT_LEVELS), state.botLevel,
      (k) => k[0].toUpperCase() + k.slice(1), (k) => { state.botLevel = k; renderMenu(); });
    el.grpSkill.classList.toggle('dim', state.bots === 0);
    segment(el.segSeconds, [20, 30, 45, 60], state.seconds, (s) => `${s}s`, (s) => { state.seconds = s; renderMenu(); });
    savePrefs();

    el.maps.innerHTML = '';
    state.level.order.forEach((id) => {
      const m = state.level.maps[id];
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'map-card';
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', String(id === state.mapId));
      card.innerHTML = `<div class="preview">${previewHTML(m, state.level.arena)}</div><b></b><small></small>`;
      card.querySelector('b').textContent = m.name;
      card.querySelector('small').textContent = m.blurb;
      card.addEventListener('click', () => { state.mapId = id; renderMenu(); });
      el.maps.appendChild(card);
    });

    el.controls.innerHTML = CONTROLS.map((c, i) => {
      const isHuman = i < state.humans, isBot = !isHuman && i < total();
      const head = `P${i + 1}${isBot ? ' · BOT' : ''}`;
      const body = isBot ? state.botLevel[0].toUpperCase() + state.botLevel.slice(1) : c.label;
      return `<div class="ctl ${isHuman || isBot ? '' : 'off'}" style="--c:${PLAYER_COLORS[i]}"><b>${head}</b>${body}</div>`;
    }).join('');
  }

  // ---- arena building -------------------------------------------------
  function place(node, r) {
    node.style.left = r.x + 'px'; node.style.top = r.y + 'px';
    node.style.width = r.w + 'px'; node.style.height = r.h + 'px';
  }

  function buildArena(map) {
    el.arena.innerHTML = '';
    map.platforms.forEach((r) => {
      const d = document.createElement('div');
      d.className = 'platform ' + (r.solid ? 'solid' : 'oneway');
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
    const slots = SPAWN_SLOTS[total()];
    state.players = slots.map((slot, i) => {
      const [x, y] = map.spawns[slot];
      const node = document.createElement('div');
      node.className = 'player';
      node.dataset.id = String(i + 1);
      node.dataset.face = i % 2 === 0 ? '1' : '-1';
      node.innerHTML = `<div class="body"><span class="eye"></span><span class="eye"></span><span class="tag-no">${i + 1}</span></div>`;
      el.arena.appendChild(node);
      return {
        id: i + 1, node, x, y, w: size, h: size, vx: 0, vy: 0,
        onGround: true, coyote: 0, jumpBuf: 0, jumpWasDown: false, padded: false,
        portalCd: 0, face: i % 2 === 0 ? 1 : -1, it: false,
        bot: i >= state.humans, ai: null, speedMul: 1, groundY: y + size,
      };
    });
    state.players.filter((p) => p.bot).forEach((p) => {
      p.ai = newBrain();
      p.speedMul = BOT_LEVELS[state.botLevel].speed;
      p.node.classList.add('bot');
    });
    const first = state.players[Math.floor(Math.random() * state.players.length)];
    first.it = true;
  }

  // ---- round flow -----------------------------------------------------
  function startMatch() {
    state.scores = [0, 0, 0, 0];
    state.round = 0;
    startRound();
  }

  function startRound() {
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
    el.roundLabel.textContent = `Round ${state.round}`;
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

    el.overTitle.textContent = `P${loser.id} got caught!`;
    el.overTitle.style.color = PLAYER_COLORS[loser.id - 1];
    el.overSub.textContent = `Still "it" when time ran out • ${state.tags} tag${state.tags === 1 ? '' : 's'} this round`;
    el.standings.innerHTML = state.players.map((p) =>
      `<div class="stand ${p === loser ? 'lost' : ''}" style="--c:${PLAYER_COLORS[p.id - 1]}"><span>P${p.id}</span><b>${state.scores[p.id - 1]}</b></div>`
    ).join('');
    el.over.hidden = false;
    $('#again').focus({ preventScroll: true });
  }

  function toMenu() {
    state.phase = 'menu';
    el.over.hidden = true;
    el.hud.hidden = true;
    el.banner.hidden = true;
    el.arena.innerHTML = '';
    el.menu.hidden = false;
    loadStats();
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
    const top = SPEED * (p.it ? IT_SPEED : 1) * p.speedMul;
    p.vx = approach(p.vx, dir * top, (p.onGround ? 3600 : 2200) * dt);

    // jump: buffered press + coyote time
    p.coyote = p.onGround ? COYOTE : p.coyote - dt;
    p.jumpBuf -= dt;
    if (p.jumpBuf > 0 && p.coyote > 0) {
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
    p.y += p.vy * dt;
    p.onGround = false;
    for (const r of map.platforms) {
      if (!overlapX(p, r)) continue;
      const crossedTop = prevBottom <= r.y + 0.01 && p.y + p.h > r.y;
      if (p.vy >= 0 && crossedTop) {                       // land on top (solid or one-way)
        p.y = r.y - p.h; p.vy = 0; p.onGround = true; p.padded = false; p.groundY = r.y;
      } else if (r.solid && p.vy < 0 && prevTop >= r.y + r.h - 0.01 && p.y < r.y + r.h) {
        p.y = r.y + r.h; p.vy = 0;                         // bonk head
      }
    }

    // pads
    map.pads.forEach((r, i) => {
      if (p.vy >= 0 && overlap(p, r)) {
        p.vy = -PAD_LAUNCH; p.padded = true; p.onGround = false;
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
        p.portalCd = PORTAL_COOLDOWN;
        break;
      }
    }
  }

  function step(dt) {
    const map = state.level.maps[state.mapId];

    for (const p of state.players) {
      if (p.bot) {
        const b = botControl(p, map, dt);
        movePlayer(p, map, b.dir, b.jumpDown, dt);
      } else {
        const c = CONTROLS[p.id - 1];
        const dir = (held.has(c.right) ? 1 : 0) - (held.has(c.left) ? 1 : 0);
        movePlayer(p, map, dir, held.has(c.jump), dt);
      }
    }

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
        renderHud();
      }
    }

    state.timeLeft -= dt;
    if (state.timeLeft <= 0) { state.timeLeft = 0; finishRound(); }
  }

  // ---- bots -----------------------------------------------------------
  // Bots press the same virtual keys a human would (left / right / jump), so they obey the same
  // physics. Every `think` seconds a bot picks a goal point: the nearest victim when it is "it",
  // a far-away safe spot when it isn't. Getting there is a tiny ledge-hopping pathfinder.
  const BOT_LEVELS = {
    easy:   { think: 0.34, speed: 0.80, lead: 0,    err: 70, dodge: 0.10 },
    normal: { think: 0.20, speed: 0.92, lead: 0.12, err: 28, dodge: 0.35 },
    hard:   { think: 0.10, speed: 1.00, lead: 0.28, err: 6,  dodge: 0.70 },
  };
  const REACH_UP = 115;    // highest ledge a bot will jump for (a full jump is ~126px)
  const REACH_SIDE = 150;  // sideways distance it can cover during a jump
  const HOLD_JUMP = 0.45;  // seconds the bot holds jump so it gets full height

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const cxOf = (p) => p.x + p.w / 2;

  function newBrain() {
    return { timer: Math.random() * 0.2, jumpHold: 0, goalX: null, climbing: false,
             flee: null, fleeT: 0, lastX: 0, stuckT: 0 };
  }

  function requestJump(p) { p.jumpBuf = JUMP_BUFFER; p.ai.jumpHold = HOLD_JUMP; }

  function standingOn(p, map) {
    return map.platforms.find((r) => overlapX(p, r) && Math.abs(p.y + p.h - r.y) < 1.5) || null;
  }

  function wallAhead(p, map, dir) {
    const probe = { x: dir > 0 ? p.x + p.w : p.x - 10, y: p.y + 4, w: 10, h: p.h - 8 };
    return map.platforms.some((r) => r.solid && overlap(probe, r));
  }

  // how good is ledge `r` as a stepping stone toward `goal` (lower = closer)
  function ledgeScore(r, goal) {
    return Math.abs(clamp(goal.x, r.x, r.x + r.w) - goal.x) + 2 * Math.abs(r.y - goal.y);
  }

  // Where to walk (x) and whether to jump now, to get from here to `goal` ({x, y = feet height}).
  function navigate(p, map, goal) {
    const cx = cxOf(p), feet = p.y + p.h, dy = goal.y - feet, stand = standingOn(p, map);

    if (dy < -30) {                                   // goal is higher: hop up via ledges
      let best = null, bestScore = Infinity;
      const here = stand ? ledgeScore(stand, goal) : Infinity;
      for (const r of map.platforms) {
        const rise = feet - r.y;
        if (r === stand || rise < 8 || rise > REACH_UP) continue;
        if (Math.abs(clamp(cx, r.x, r.x + r.w) - cx) > REACH_SIDE) continue;
        const s = ledgeScore(r, goal);
        if (s < bestScore) { bestScore = s; best = r; }
      }
      if (best && bestScore < here - 5) {
        const wx = clamp(cx, best.x + 14, best.x + best.w - 14);
        return { x: wx, jump: Math.abs(wx - cx) < 70 && p.onGround, climbing: true };
      }
      return { x: goal.x, jump: false, climbing: false, lost: true };  // nothing helpful in reach
    }

    if (dy > 30 && stand && goal.x > stand.x - 4 && goal.x < stand.x + stand.w + 4) {
      // goal is below us but our own platform is in the way: walk off the nearer end
      const left = goal.x - stand.x < stand.x + stand.w - goal.x;
      return { x: left ? stand.x - 40 : stand.x + stand.w + 40, jump: false, climbing: false };
    }
    return { x: goal.x, jump: false, climbing: false };
  }

  function pickFleeSpot(p, it, map) {
    const cx = cxOf(p), feet = p.y + p.h, ix = cxOf(it), iy = it.groundY;
    let best = null, bestScore = -Infinity;
    for (const r of map.platforms) {
      const spots = [{ x: r.x + r.w / 2, y: r.y }];
      if (r.w > 120) spots.push({ x: r.x + 20, y: r.y }, { x: r.x + r.w - 20, y: r.y });
      for (const s of spots) {
        const farFromIt = Math.hypot(s.x - ix, (s.y - iy) * 1.5);
        const costToGo = Math.hypot(s.x - cx, (s.y - feet) * 1.5);
        const score = farFromIt - 0.45 * costToGo + Math.random() * 60;
        if (score > bestScore) { bestScore = score; best = s; }
      }
    }
    return best;
  }

  function think(p, map, lv) {
    const ai = p.ai, cx = cxOf(p);
    const others = state.players.filter((q) => q !== p);
    let goal;

    if (p.it) {
      // chase whoever is closest (height counts extra: climbing takes time)
      const cost = (q) => Math.abs(cxOf(q) - cx) + 1.5 * Math.abs(q.groundY - p.groundY);
      const t = others.reduce((a, b) => (cost(a) <= cost(b) ? a : b));
      goal = { x: cxOf(t) + t.vx * lv.lead + (Math.random() * 2 - 1) * lv.err, y: t.groundY };
      // a victim right overhead: leap for it
      if (p.onGround && Math.abs(cxOf(t) - cx) < 40 && t.y < p.y - 20 && t.y > p.y - 125) requestJump(p);
    } else {
      const it = state.players.find((q) => q.it);
      const near = Math.hypot(cxOf(it) - cx, it.y - p.y) < 150;
      if (!ai.flee || ai.fleeT <= 0 || (near && Math.random() < 0.5)) {
        ai.flee = pickFleeSpot(p, it, map);
        ai.fleeT = 0.8 + Math.random() * 0.8;
      }
      goal = ai.flee;
      // dodge: hop when the chaser is almost on top of us
      if (p.onGround && Math.abs(cxOf(it) - cx) < 80 && Math.abs(it.y - p.y) < 50 && Math.random() < lv.dodge) {
        requestJump(p);
      }
    }

    const nav = navigate(p, map, goal);
    ai.goalX = nav.x;
    ai.climbing = nav.climbing;
    if (nav.jump) requestJump(p);
    else if (nav.lost && p.onGround && Math.random() < 0.35) requestJump(p);
  }

  function botControl(p, map, dt) {
    const ai = p.ai, lv = BOT_LEVELS[state.botLevel];
    ai.timer -= dt;
    ai.jumpHold -= dt;
    ai.fleeT -= dt;

    // mid-jump toward a ledge: keep that plan until we land
    if (ai.timer <= 0 && !(ai.climbing && !p.onGround)) {
      ai.timer = lv.think * (0.8 + Math.random() * 0.4);
      think(p, map, lv);
    }

    let dir = 0;
    if (ai.goalX != null) {
      const d = ai.goalX - cxOf(p);
      dir = Math.abs(d) < 8 ? 0 : Math.sign(d);
    }
    if (dir && p.onGround && wallAhead(p, map, dir)) requestJump(p);   // hop pillars

    ai.stuckT += dt;                                                   // not moving? hop
    if (ai.stuckT > 0.5) {
      if (dir && p.onGround && Math.abs(p.x - ai.lastX) < 3) requestJump(p);
      ai.lastX = p.x;
      ai.stuckT = 0;
    }
    return { dir, jumpDown: ai.jumpHold > 0 };
  }

  // ---- menu preferences (remembered in this browser) -------------------
  const PREF_KEY = 'tag.prefs.v1';
  const total = () => state.humans + state.bots;

  function savePrefs() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({
        humans: state.humans, bots: state.bots, botLevel: state.botLevel,
        seconds: state.seconds, mapId: state.mapId,
      }));
    } catch { /* storage can be blocked; the game works without it */ }
  }

  function loadPrefs() {
    try {
      const o = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      const ok = Number.isInteger(o.humans) && Number.isInteger(o.bots) &&
        o.humans >= 0 && o.bots >= 0 && o.humans + o.bots >= 2 && o.humans + o.bots <= 4;
      if (ok) { state.humans = o.humans; state.bots = o.bots; }
      if (o.botLevel in BOT_LEVELS) state.botLevel = o.botLevel;
      if ([20, 30, 45, 60].includes(o.seconds)) state.seconds = o.seconds;
      if (o.mapId in state.level.maps) state.mapId = o.mapId;
    } catch { /* ignore corrupt prefs */ }
  }

  // ---- rendering ------------------------------------------------------
  function renderHud() {
    el.chips.innerHTML = state.players.map((p) =>
      `<div class="chip ${p.it ? 'it' : ''}" style="--c:${PLAYER_COLORS[p.id - 1]}"><i></i>P${p.id}${p.bot ? '<em>BOT</em>' : ''}<b>${state.scores[p.id - 1]}</b></div>`
    ).join('');
  }

  function render() {
    for (const p of state.players) {
      p.node.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
      p.node.dataset.face = String(p.face);
      p.node.classList.toggle('it', p.it);
      p.node.classList.toggle('locked', p.it && state.lock > 0);
      p.node.classList.toggle('air', !p.onGround);
    }
    const t = Math.ceil(state.timeLeft);
    if (el.timerNum.textContent !== String(t)) el.timerNum.textContent = t;
    el.timerBar.style.setProperty('--t', (state.timeLeft / state.seconds).toFixed(3));
    el.timer.classList.toggle('hurry', state.phase === 'play' && state.timeLeft <= HURRY_AT);
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
        showBanner('GO!');
        setTimeout(() => { if (state.phase === 'play') el.banner.hidden = true; }, 600);
      } else if (now !== before || el.banner.hidden) {
        showBanner(String(now));
      }
      render();
    } else if (state.phase === 'play') {
      acc += dt;
      while (acc >= STEP && state.phase === 'play') { step(STEP); acc -= STEP; }
      render();
    }
    requestAnimationFrame(frame);
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
    const playing = state.phase === 'play' || state.phase === 'countdown';
    if (playing && GAME_KEYS.has(e.code)) e.preventDefault(); // no page scroll on arrows

    if (!e.repeat) {
      held.add(e.code);
      state.players.forEach((p) => { if (!p.bot && CONTROLS[p.id - 1].jump === e.code) p.jumpBuf = JUMP_BUFFER; });
    }

    if (state.phase === 'menu' && e.code === 'Space') { e.preventDefault(); startMatch(); }
    else if (state.phase === 'over' && e.code === 'Enter') { e.preventDefault(); startRound(); }
    else if (state.phase === 'over' && e.code === 'Escape') toMenu();
    else if (playing && e.code === 'Escape') toMenu();
  });
  addEventListener('keyup', (e) => held.delete(e.code));
  addEventListener('blur', () => held.clear());

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

  fit();
  api('/api/maps').then((level) => {
    state.level = level;
    loadPrefs();
    renderMenu();
    loadStats();
    requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });
  }).catch(() => {
    el.error.hidden = false;
    el.error.textContent = 'Could not load maps. Start the backend with: python server.py';
  });

  // handy for debugging / automated tests
  window.__tag = state;
})();
