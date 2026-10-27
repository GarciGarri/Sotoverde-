/*
 * Juego: vista cenital al estilo Golf Clash.
 *  1. Arrastra la diana para apuntar (cae ahí con potencia máxima).
 *  2. Toca la bola y tira hacia atrás para dar potencia; suelta.
 *  3. Para la aguja en el centro (toque o espacio) para un golpe perfecto.
 * En el green el putter no tiene aguja: solo dirección y potencia.
 */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const canvas = $('#game');
  const ctx = canvas.getContext('2d');
  const windCanvas = $('#wind');
  const wctx = windCanvas.getContext('2d');

  const params = new URLSearchParams(location.search);
  const holes = GC.resolveHoleList(params.get('hoyos'));
  const exitUrl = params.get('volver') || 'index.html';
  const teeKey = params.get('salida'); // barras: amarillas, rojas…

  const round = { index: 0, cards: [] };
  let W = 0;
  let H = 0;
  let DPR = 1;
  let view = { cx: 0, cy: 0 };
  let hole = null;
  let g = null; // estado del hoyo en curso
  let time = 0;

  // ---------- Inicio ----------

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    view = { cx: W / 2, cy: viewport().top + viewport().h / 2 };
  }

  // Zona útil de la pantalla (sin las barras de arriba y abajo).
  function viewport() {
    const top = 84;
    const bottom = H - 235; // deja sitio a la barra de precisión y a los palos
    return { left: 16, top, w: W - 32, h: Math.max(120, bottom - top) };
  }

  function startHole(i) {
    round.index = i;
    hole = GC.prepareHole(holes[i], teeKey);
    const wind = holes[i].wind || GC.randomWind();
    g = {
      ball: { ...hole.tee },
      prevBall: { ...hole.tee },
      strokes: 0,
      state: 'aim',
      club: null,
      spin: 0,
      target: null,
      power: 0,
      pull: null,
      needle: 0,
      needlePhase: 0,
      wind,
      windVec: GC.windVector(wind),
      shot: null,
      roll: null,
      height: 0,
      timer: 0,
      overview: false,
      cam: null,
      result: null,
    };
    $('#hud-number').textContent = hole.number;
    $('#hud-name').textContent = hole.name;
    document.title = `Hoyo ${hole.number} · ${hole.name}`;
    const bars = hole.teeKey ? ` · ${holes[i].tees[hole.teeKey].label || hole.teeKey}` : '';
    $('#hud-sub').textContent = `Par ${hole.par} · ${hole.length} m${bars}`;
    $('#hud-wind').textContent = `${wind.speed} km/h`;
    prepareShot();
    // empieza enseñando el hoyo entero y luego se acerca
    g.cam = cameraFor(GC.holeCorners(hole), 4, 0.1, 50);
    g.overview = true;
    setTimeout(() => {
      if (g && g.strokes === 0) g.overview = false;
    }, 1600);
    hint(`Hoyo ${hole.number}: arrastra la diana para apuntar y tira de la bola hacia atrás.`);
  }

  function lie() {
    return hole.surfaceAt(g.ball.x, g.ball.y);
  }

  function prepareShot() {
    const surface = lie();
    const dPin = GC.dist(g.ball, hole.pin);
    let club;
    if (surface === 'green') {
      club = GC.CLUBS.find((c) => c.putter);
    } else {
      const need = GC.playsLike(hole, g.ball, hole.pin);
      const usable = GC.CLUBS.filter((c) => !c.putter);
      club = usable.slice().reverse().find((c) => GC.clubRange(c, surface) >= need) || usable[0];
      if (club.id === 'driver' && surface !== 'tee') club = usable[1];
    }
    setClub(club, true);
    if (club.putter) g.target = { ...hole.pin };
    else g.target = clampTarget(dPin <= GC.clubRange(club, surface) ? { ...hole.pin } : towards(hole.pin, 1e6));
    g.state = 'aim';
    g.power = 0;
    updateHud();
  }

  function towards(p, dist) {
    const dx = p.x - g.ball.x;
    const dy = p.y - g.ball.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: g.ball.x + (dx / len) * dist, y: g.ball.y + (dy / len) * dist };
  }

  // La diana no puede quedar más lejos de lo que alcanza el palo (contando el desnivel).
  function clampTarget(t) {
    if (g.club.putter) return t;
    const range = GC.clubRange(g.club, lie());
    let lo = 0;
    let hi = GC.dist(g.ball, t);
    if (GC.playsLike(hole, g.ball, t) <= range) return t;
    for (let k = 0; k < 25; k++) {
      const mid = (lo + hi) / 2;
      if (GC.playsLike(hole, g.ball, towards(t, mid)) <= range) lo = mid;
      else hi = mid;
    }
    return towards(t, lo);
  }

  function setClub(club, silent) {
    g.club = club;
    document.querySelectorAll('#clubs button').forEach((b) => b.classList.toggle('on', b.dataset.id === club.id));
    $('#spin').classList.toggle('hidden', !!club.putter);
    if (g.target && !silent) g.target = club.putter ? towards(g.target, 5) : clampTarget(g.target);
  }

  function buildClubBar() {
    const bar = $('#clubs');
    bar.innerHTML = '';
    for (const c of GC.CLUBS) {
      const b = document.createElement('button');
      b.dataset.id = c.id;
      b.innerHTML = `<b>${c.name}</b><small>${c.putter ? 'green' : c.max + ' m'}</small>`;
      b.addEventListener('click', () => {
        if (g.state !== 'aim') return;
        setClub(c);
        updateHud();
      });
      bar.appendChild(b);
    }
    document.querySelectorAll('#spin button').forEach((b) =>
      b.addEventListener('click', () => {
        g.spin = Number(b.dataset.spin);
        document.querySelectorAll('#spin button').forEach((x) => x.classList.toggle('on', x === b));
      })
    );
  }

  // ---------- HUD ----------

  function updateHud() {
    $('#hud-stroke').textContent = g.strokes + 1;
    $('#hud-dist').textContent = `${Math.round(GC.dist(g.ball, hole.pin))} m`;
    $('#hud-lie').textContent = GC.SURFACES[lie()].name;
  }

  let toastTimer = null;
  function toast(text, kind) {
    const el = $('#toast');
    el.textContent = text;
    el.className = 'toast show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = 'toast'), 1400);
  }

  let hintTimer = null;
  function hint(text) {
    const el = $('#hint');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => el.classList.remove('show'), 4000);
  }

  function drawWind() {
    const s = 64;
    wctx.clearRect(0, 0, s, s);
    wctx.save();
    wctx.translate(s / 2, s / 2);
    wctx.fillStyle = 'rgba(0,0,0,0.35)';
    wctx.beginPath();
    wctx.arc(0, 0, 30, 0, Math.PI * 2);
    wctx.fill();
    // dirección del viento vista en pantalla (la cámara gira)
    const v = GC.compassVec(g.wind.angle);
    const rot = g.cam.rot;
    const sx = v.x * Math.cos(rot) - v.y * Math.sin(rot);
    const sy = v.x * Math.sin(rot) + v.y * Math.cos(rot);
    wctx.rotate(Math.atan2(sy, sx));
    const len = 8 + Math.min(g.wind.speed, 30) * 0.6;
    wctx.strokeStyle = '#fff';
    wctx.fillStyle = '#fff';
    wctx.lineWidth = 4;
    wctx.lineCap = 'round';
    wctx.beginPath();
    wctx.moveTo(-len, 0);
    wctx.lineTo(len - 6, 0);
    wctx.stroke();
    wctx.beginPath();
    wctx.moveTo(len + 4, 0);
    wctx.lineTo(len - 8, -9);
    wctx.lineTo(len - 8, 9);
    wctx.closePath();
    wctx.fill();
    wctx.restore();
  }

  // ---------- Cámara ----------

  function cameraFor(points, minSpan, minZoom, maxZoom) {
    const vp = viewport();
    const rect = { w: vp.w - 40, h: vp.h - 40 };
    return GC.fitCamera(points, GC.holeRotation(hole), rect, minSpan, minZoom, maxZoom);
  }

  function desiredCamera() {
    const fitAll = cameraFor(GC.holeCorners(hole), 4, 0.1, 50);
    if (g.overview) return fitAll;
    const minZoom = fitAll.zoom;
    if (g.state === 'flight' && g.shot) return cameraFor([g.shot.start, g.shot.landing], 30, minZoom, 9);
    if (g.state === 'roll' && g.roll) {
      const p = { x: g.roll.x, y: g.roll.y };
      return cameraFor([p, g.shot ? g.shot.landing || g.shot.start : p, ...(lie() === 'green' ? [hole.pin] : [])], 16, minZoom, 18);
    }
    if (g.club.putter) {
      return cameraFor([g.ball, hole.pin, g.target], 10, minZoom, 30);
    }
    return cameraFor([g.ball, g.target], 40, minZoom, 9);
  }

  function updateCamera(dt) {
    const d = desiredCamera();
    const k = 1 - Math.exp(-dt * 3.5);
    g.cam.x += (d.x - g.cam.x) * k;
    g.cam.y += (d.y - g.cam.y) * k;
    g.cam.zoom *= Math.pow(d.zoom / g.cam.zoom, k);
    g.cam.rot = d.rot;
  }

  const w2s = (p) => GC.worldToScreen(g.cam, view, p);
  const s2w = (p) => GC.screenToWorld(g.cam, view, p);

  // ---------- Entrada ----------

  function pointer(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  let dragTarget = false;

  canvas.addEventListener('pointerdown', (e) => {
    if (!g) return;
    const p = pointer(e);
    if (g.state === 'accuracy') {
      strike();
      return;
    }
    if (g.state !== 'aim') return;
    canvas.setPointerCapture(e.pointerId);
    g.overview = false;
    const b = w2s(g.ball);
    if (Math.hypot(p.x - b.x, p.y - b.y) < 46) {
      g.state = 'pulling';
      g.pull = { start: p, now: p };
      g.power = 0;
    } else {
      dragTarget = true;
      moveTarget(p);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!g) return;
    const p = pointer(e);
    if (g.state === 'pulling') {
      g.pull.now = p;
      const d = Math.hypot(p.x - g.pull.start.x, p.y - g.pull.start.y);
      g.power = GC.clamp(d / pullLength(), 0, 1);
    } else if (dragTarget && g.state === 'aim') {
      moveTarget(p);
    }
  });

  const endPointer = () => {
    if (!g) return;
    dragTarget = false;
    if (g.state !== 'pulling') return;
    if (g.power < 0.06) {
      g.state = 'aim';
      g.power = 0;
      return;
    }
    if (g.club.putter) {
      putt();
    } else {
      g.state = 'accuracy';
      g.needlePhase = -Math.PI / 2;
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  function moveTarget(p) {
    const t = s2w(p);
    g.target = g.club.putter ? t : clampTarget(t);
  }

  const pullLength = () => Math.min(H * 0.28, 210);

  window.addEventListener('keydown', (e) => {
    if (!g) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (g.state === 'accuracy') strike();
    } else if (e.key === 'v' || e.key === 'V') {
      g.overview = !g.overview;
    } else if (e.key === 'Escape' && g.state === 'pulling') {
      g.state = 'aim';
      g.power = 0;
    }
  });

  $('#btn-view').addEventListener('click', () => g && (g.overview = !g.overview));
  // volver atrás conserva la página de origen aunque no se llame index.html
  const exit = () => (params.get('volver') || history.length <= 1 ? (location.href = exitUrl) : history.back());
  $('#btn-exit').addEventListener('click', exit);

  // ---------- Golpes ----------

  function needleSpeed() {
    const scatter = GC.SURFACES[lie()].scatter;
    return (2.2 + 2.6 * g.power) * g.club.needle * (0.8 + 0.2 * scatter);
  }

  function strike() {
    g.needle = Math.sin(g.needlePhase);
    g.prevBall = { ...g.ball };
    g.strokes++;
    g.shot = GC.computeShot(hole, g.ball, g.target, g.club, g.power, g.needle, g.wind, g.spin);
    if (g.shot.perfect) toast('¡PERFECTO!', 'perfect');
    else if (Math.abs(g.needle) > 0.7) toast(g.needle < 0 ? 'Gancho' : 'Slice', 'bad');
    g.state = 'flight';
    g.timer = 0;
    updateHud();
  }

  function putt() {
    g.prevBall = { ...g.ball };
    g.strokes++;
    const dist = GC.puttDistance(g.power);
    const dx = g.target.x - g.ball.x;
    const dy = g.target.y - g.ball.y;
    const len = Math.hypot(dx, dy) || 1;
    const friction = GC.SURFACES[lie()].friction;
    g.shot = { start: { ...g.ball }, landing: null };
    g.roll = GC.startRoll(g.ball, { x: dx / len, y: dy / len }, GC.speedFor(dist, friction));
    g.state = 'roll';
    updateHud();
  }

  function land() {
    const s = g.shot;
    const p = s.landing;
    g.ball = { ...p };
    g.height = 0;

    const tree = hole.treeAt(p.x, p.y);
    if (tree) {
      // la bola toca las ramas y cae junto al tronco
      const a = Math.random() * Math.PI * 2;
      g.ball = { x: tree.x + Math.cos(a) * tree.r * 0.8, y: tree.y + Math.sin(a) * tree.r * 0.8 };
      toast('¡Árbol!', 'bad');
      return afterRoll(hole.surfaceAt(g.ball.x, g.ball.y) === 'water' ? 'water' : 'stopped');
    }

    const surf = hole.surfaceAt(p.x, p.y);
    if (surf === 'water' || surf === 'ob') return afterRoll(surf);
    if (surf === 'green' && GC.dist(p, hole.pin) < GC.CUP_RADIUS * 1.5) return afterRoll('holed');

    let dist = s.rollDistance * GC.SURFACES[surf].landRoll;
    let dir = s.dir;
    if (dist < 0) {
      dir = { x: -dir.x, y: -dir.y };
      dist = -dist;
    }
    if (surf === 'sand') toast('Búnker', 'bad');
    g.roll = GC.startRoll(p, dir, GC.speedFor(dist, GC.SURFACES[surf].friction));
    g.state = 'roll';
  }

  function afterRoll(result) {
    g.roll = null;
    if (result === 'holed') {
      g.ball = { ...hole.pin };
      g.state = 'holed';
      finishHole(false);
      return;
    }
    if (result === 'water' || result === 'ob') {
      toast(result === 'water' ? '¡Agua! +1' : 'Fuera de límites +1', 'bad');
      g.strokes++;
      g.state = 'penalty';
      g.timer = 0;
      return;
    }
    g.state = 'wait';
    g.timer = 0;
  }

  function nextShot() {
    if (g.strokes >= GC.MAX_STROKES) {
      finishHole(true);
      return;
    }
    prepareShot();
    if (lie() === 'green' && g.strokes > 0) hint('En el green: apunta y tira de la bola. Las flechas marcan la caída.');
  }

  // ---------- Fin de hoyo ----------

  function finishHole(pickedUp) {
    const name = pickedUp ? 'Bola levantada' : GC.scoreName(g.strokes, hole.par);
    round.cards[round.index] = { hole: hole.number, name: `${hole.number} · ${hole.name}`, par: hole.par, strokes: g.strokes };
    g.state = 'done';
    if (!pickedUp) toast(name, g.strokes < hole.par ? 'perfect' : '');
    setTimeout(() => showHoleCard(name), 1200);
  }

  function showHoleCard(name) {
    const last = round.index === holes.length - 1;
    const diff = g.strokes - hole.par;
    openModal(`
      <h2>${name}</h2>
      <p class="big">${g.strokes} golpes <span class="${diff < 0 ? 'under' : diff > 0 ? 'over' : ''}">(${diff === 0 ? 'E' : (diff > 0 ? '+' : '') + diff})</span></p>
      <p>Hoyo ${hole.number} · ${hole.name} · Par ${hole.par}</p>
      <div class="actions">
        <button id="m-again">Repetir hoyo</button>
        <button id="m-next" class="primary">${last ? 'Ver tarjeta' : 'Siguiente hoyo'}</button>
      </div>`);
    $('#m-again').onclick = () => {
      closeModal();
      startHole(round.index);
    };
    $('#m-next').onclick = () => {
      closeModal();
      if (last) showScorecard();
      else startHole(round.index + 1);
    };
  }

  function showScorecard() {
    const rows = round.cards.filter(Boolean);
    const par = rows.reduce((a, r) => a + r.par, 0);
    const total = rows.reduce((a, r) => a + r.strokes, 0);
    const diff = total - par;
    openModal(`
      <h2>Tarjeta</h2>
      <table class="scorecard">
        <tr><th>Hoyo</th><th>Par</th><th>Golpes</th></tr>
        ${rows.map((r) => `<tr><td>${r.name}</td><td>${r.par}</td><td class="${r.strokes < r.par ? 'under' : r.strokes > r.par ? 'over' : ''}">${r.strokes}</td></tr>`).join('')}
        <tr class="total"><td>Total</td><td>${par}</td><td>${total} (${diff === 0 ? 'E' : (diff > 0 ? '+' : '') + diff})</td></tr>
      </table>
      <div class="actions">
        <button id="m-menu">Menú</button>
        <button id="m-replay" class="primary">Jugar otra vez</button>
      </div>`);
    $('#m-menu').onclick = exit;
    $('#m-replay').onclick = () => {
      closeModal();
      round.cards = [];
      startHole(0);
    };
  }

  function openModal(html) {
    $('#modal-card').innerHTML = html;
    $('#modal').classList.remove('hidden');
  }

  function closeModal() {
    $('#modal').classList.add('hidden');
  }

  // ---------- Bucle ----------

  function update(dt) {
    time += dt;
    if (g.state === 'accuracy') {
      g.needlePhase += dt * needleSpeed();
    } else if (g.state === 'flight') {
      g.timer += dt / g.shot.duration;
      const t = Math.min(1, g.timer);
      const p = GC.flightPosition(g.shot, t);
      g.ball = { x: p.x, y: p.y };
      g.height = p.h;
      if (t >= 1) land();
    } else if (g.state === 'roll') {
      GC.stepRoll(hole, g.roll, dt * (g.club.putter ? 1 : 1.4));
      g.ball = { x: g.roll.x, y: g.roll.y };
      if (g.roll.result) afterRoll(g.roll.result);
    } else if (g.state === 'penalty') {
      g.timer += dt;
      if (g.timer > 1.3) {
        g.ball = { ...g.prevBall };
        nextShot();
      }
    } else if (g.state === 'wait') {
      g.timer += dt;
      if (g.timer > 0.5) nextShot();
    }
    updateCamera(dt);
    if (g.state !== 'flight') updateHud();
  }

  function render() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = GC.COLORS.forest;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    GC.applyCamera(ctx, g.cam, view);
    const showSlope = lie() === 'green' || g.club.putter || g.overview;
    GC.renderHole(ctx, hole, time, { showSlope });
    ctx.restore();

    if (['aim', 'pulling', 'accuracy'].includes(g.state)) drawAim();
    const pin = w2s(hole.pin);
    GC.drawFlag(ctx, pin.x, pin.y, GC.clamp(g.cam.zoom / 8, 0.55, 1.3), time, GC.CUP_RADIUS * g.cam.zoom);
    drawBall();
    if (g.state === 'pulling') drawPower();
    if (g.state === 'accuracy') drawNeedle();
    drawWind();
  }

  function drawAim() {
    const b = w2s(g.ball);
    const t = w2s(g.target);
    ctx.save();
    if (g.club.putter) {
      const dist = g.state === 'pulling' ? GC.puttDistance(g.power) : 0;
      const dir = { x: t.x - b.x, y: t.y - b.y };
      const len = Math.hypot(dir.x, dir.y) || 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.setLineDash([6, 8]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x + (dir.x / len) * 2000, b.y + (dir.y / len) * 2000);
      ctx.stroke();
      if (dist > 0) {
        const px = dist * g.cam.zoom;
        ctx.setLineDash([]);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x + (dir.x / len) * px, b.y + (dir.y / len) * px);
        ctx.stroke();
        label(`${dist.toFixed(1)} m`, b.x + (dir.x / len) * px, b.y + (dir.y / len) * px - 18);
      }
      ctx.restore();
      return;
    }
    // línea de tiro
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 8]);
    ctx.lineDashOffset = -time * 30;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(t.x, t.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // diana con anillos (sirven para contar cuánto corregir el viento)
    const dist = GC.dist(g.ball, g.target);
    const ringR = Math.max(3, dist * 0.035 * GC.SURFACES[lie()].scatter) * g.cam.zoom;
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.arc(t.x, t.y, ringR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1.2;
    for (const f of [1 / 3, 2 / 3]) {
      ctx.beginPath();
      ctx.arc(t.x, t.y, ringR * f, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(t.x, t.y, 2.5, 0, Math.PI * 2);
    ctx.fill();

    // dónde caería con la potencia actual
    if (g.state === 'pulling' && g.power < 0.995) {
      const p = w2s({ x: g.ball.x + (g.target.x - g.ball.x) * g.power, y: g.ball.y + (g.target.y - g.ball.y) * g.power });
      ctx.strokeStyle = '#ffd84a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.stroke();
    }

    const plays = GC.playsLike(hole, g.ball, g.target);
    const txt = Math.abs(plays - dist) >= 2 ? `${Math.round(dist)} m · juega ${Math.round(plays)}` : `${Math.round(dist)} m`;
    label(txt, t.x, t.y - ringR - 14);
    ctx.restore();
  }

  function label(text, x, y) {
    ctx.save();
    ctx.font = '600 13px system-ui, sans-serif';
    const w = ctx.measureText(text).width + 14;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(x - w / 2, y - 11, w, 22, 11);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawBall() {
    if (g.state === 'holed' || g.state === 'done') return;
    const p = w2s(g.ball);
    const hgt = g.height;
    const r = 5 * (1 + hgt / 22);
    const off = Math.min(hgt * 0.9, 60);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(p.x + off * 0.6, p.y + off, 5, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    const grd = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.35, r * 0.1, p.x, p.y, r);
    grd.addColorStop(0, '#ffffff');
    grd.addColorStop(1, '#cfd6dc');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (g.state === 'aim') {
      // pulso para indicar que se puede tirar de la bola
      const pulse = 12 + Math.sin(time * 4) * 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, pulse + 8, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function drawPower() {
    const b = w2s(g.ball);
    const n = g.pull.now;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(n.x, n.y);
    ctx.stroke();
    const R = 34;
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.arc(b.x, b.y, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = g.power > 0.98 ? '#ff5a3c' : g.power > 0.75 ? '#ffd84a' : '#7be04a';
    ctx.beginPath();
    ctx.arc(b.x, b.y, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * g.power);
    ctx.stroke();
    label(g.power > 0.98 ? 'MÁXIMA' : `${Math.round(g.power * 100)} %`, b.x, b.y + R + 20);
    ctx.restore();
  }

  function drawNeedle() {
    const w = Math.min(340, W - 60);
    const x0 = W / 2 - w / 2;
    const y = H - 200;
    const hgt = 26;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(x0 - 8, y - 34, w + 16, hgt + 46, 14);
    ctx.fill();
    const grd = ctx.createLinearGradient(x0, 0, x0 + w, 0);
    grd.addColorStop(0, '#e2412f');
    grd.addColorStop(0.25, '#f0a33a');
    grd.addColorStop(0.42, '#7fd04a');
    grd.addColorStop(0.5, '#a8f070');
    grd.addColorStop(0.58, '#7fd04a');
    grd.addColorStop(0.75, '#f0a33a');
    grd.addColorStop(1, '#e2412f');
    ctx.fillStyle = grd;
    roundRect(x0, y, w, hgt, 8);
    ctx.fill();
    const pz = (GC.PERFECT_ZONE * w) / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(W / 2 - pz, y - 3, pz * 2, hgt + 6);
    const nx = W / 2 + (Math.sin(g.needlePhase) * w) / 2;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(nx, y + hgt + 4);
    ctx.lineTo(nx - 8, y - 14);
    ctx.lineTo(nx + 8, y - 14);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '700 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('¡Toca para golpear!', W / 2, y - 18);
    ctx.restore();
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (g) {
      update(dt);
      render();
    }
    requestAnimationFrame(frame);
  }

  // ---------- Arranque ----------

  window.addEventListener('resize', resize);
  resize();
  buildClubBar();
  if (!holes.length) {
    openModal('<h2>No hay hoyos</h2><p>No se encontró ningún hoyo para jugar.</p><div class="actions"><button onclick="location.href=\'index.html\'" class="primary">Menú</button></div>');
  } else {
    startHole(0);
  }
  requestAnimationFrame(frame);

  // acceso para pruebas automáticas
  window.__game = { get state() { return g; }, get hole() { return hole; }, strike, w2s };
})();
