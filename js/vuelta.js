/*
 * Mis vueltas: apuntar los golpes de una vuelta real en Sotoverde.
 * Cada golpe es el punto del mapa donde quedó la bola, con el palo y el lie.
 * Las vueltas se guardan en la base de datos privada de cada persona (capability db)
 * o, si no hay, en este navegador.
 */
(function () {
  'use strict';

  const app = document.getElementById('app');
  const COURSE = (GC.COURSE_HOLES || []).slice().sort((a, b) => a.number - b.number);
  const byNumber = Object.fromEntries(COURSE.map((h) => [h.number, h]));

  const CLUBS = [
    { id: 'dr', name: 'Driver', typical: 200 },
    { id: 'm3', name: 'Madera 3', typical: 180 },
    { id: 'm5', name: 'Madera 5', typical: 165 },
    { id: 'hi', name: 'Híbrido', typical: 160 },
    { id: 'h4', name: 'Hierro 4', typical: 150 },
    { id: 'h5', name: 'Hierro 5', typical: 140 },
    { id: 'h6', name: 'Hierro 6', typical: 130 },
    { id: 'h7', name: 'Hierro 7', typical: 120 },
    { id: 'h8', name: 'Hierro 8', typical: 110 },
    { id: 'h9', name: 'Hierro 9', typical: 100 },
    { id: 'pw', name: 'PW', typical: 90 },
    { id: 'gw', name: 'GW', typical: 75 },
    { id: 'sw', name: 'SW', typical: 60 },
    { id: 'lw', name: 'LW', typical: 45 },
  ];
  const clubName = (id) => (CLUBS.find((c) => c.id === id) || { name: '—' }).name;

  // ---------- mi bolsa ----------
  const SHAPES = [['recto', 'Recto'], ['draw', 'Draw'], ['fade', 'Fade'], ['gancho', 'Gancho'], ['slice', 'Slice']];
  const HEIGHTS = [['baja', 'Baja'], ['media', 'Media'], ['alta', 'Alta']];
  const MISSES = [['ninguno', 'Ninguno'], ['izquierda', 'Izquierda'], ['derecha', 'Derecha'], ['corto', 'Corto'], ['largo', 'Largo']];
  const DEFAULT_ON = ['dr', 'm3', 'hi', 'h5', 'h6', 'h7', 'h8', 'h9', 'pw', 'gw', 'sw'];
  const WIND_DIRS = [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SO', 225], ['O', 270], ['NO', 315]];
  const dirName = (deg) => (WIND_DIRS.find((d) => d[1] === ((Math.round(deg / 45) * 45) % 360)) || ['N'])[0];

  function defaultBag() {
    return {
      v: 1,
      tref: 20,
      clubs: Object.fromEntries(CLUBS.map((c) => [c.id, {
        on: DEFAULT_ON.includes(c.id), dist: c.typical, shape: 'recto', height: 'media', miss: 'ninguno',
      }])),
    };
  }
  let bag = defaultBag();
  const bagClub = (id) => bag.clubs[id] || defaultBag().clubs[id];

  /*
   * Distancia que "juega" un golpe, en metros. Reglas de campo habituales:
   * - desnivel: 1 m de subida = 1 m más;
   * - viento: +0,62 % por km/h de cara y −0,31 % por km/h a favor (bola alta ×1,3, baja ×0,7);
   * - temperatura: −0,2 % por grado por encima de la de referencia de la bolsa.
   * El viento cruzado desplaza la bola ≈ 0,0027 m por km/h y metro de golpe.
   */
  function shotModel(h, from, to, cond, height) {
    const D = GC.dist(from, to);
    const elev = h.heightAt(to.x, to.y) - h.heightAt(from.x, from.y);
    const hm = { baja: 0.7, media: 1, alta: 1.3 }[height] || 1;
    const w = windComponents(from, to, cond);
    const windPct = w.head > 0 ? w.head * 0.0062 * hm : w.head * 0.0031 * hm;
    const tempPct = -0.002 * ((cond.temp == null ? bag.tref : cond.temp) - bag.tref);
    const base = D + elev;
    return {
      D, elev, wind: base * windPct, temp: base * tempPct, total: base * (1 + windPct + tempPct),
      head: w.head, right: w.right, drift: w.right * D * 0.0027 * hm,
    };
  }

  // Viento en componentes respecto al golpe: head > 0 = de cara; right > 0 = empuja a la derecha.
  function windComponents(from, to, cond) {
    const W = cond.wind || 0;
    if (!W) return { head: 0, right: 0 };
    const toBearing = (((cond.from || 0) + 180) * Math.PI) / 180;
    const v = { x: Math.sin(toBearing) * W, y: -Math.cos(toBearing) * W }; // x este, y sur
    const L = GC.dist(from, to) || 1;
    const u = { x: (to.x - from.x) / L, y: (to.y - from.y) / L };
    const r = { x: -u.y, y: u.x };
    return { head: -(v.x * u.x + v.y * u.y), right: v.x * r.x + v.y * r.y };
  }

  const SHAPE_CURVE = { recto: 0, draw: -0.03, fade: 0.03, gancho: -0.07, slice: 0.07 }; // fracción del golpe hacia la derecha

  function recommend(n) {
    const st = holeStats(n);
    if (st.lie === 'green' || holeScore(n).done) return null;
    const h = holeData(n);
    const pos = positions(n);
    const from = pos[pos.length - 1];
    const to = ui.target || h.pin;
    const cond = round.cond || { temp: bag.tref, wind: 0, from: 0 };
    const clubs = CLUBS.filter((c) => bagClub(c.id).on).sort((a, b) => bagClub(a.id).dist - bagClub(b.id).dist);
    if (!clubs.length) return null;
    const pick = (P) => clubs.find((c) => bagClub(c.id).dist >= P - 3) || clubs[clubs.length - 1];
    let m = shotModel(h, from, to, cond, 'media');
    let club = pick(m.total);
    m = shotModel(h, from, to, cond, bagClub(club.id).height);
    club = pick(m.total);
    const cfg = bagClub(club.id);
    const i = clubs.indexOf(club);
    const shorter = clubs[i - 1];
    // alternativa: el palo corto si queda a 5 m o menos de lo que juega el golpe
    let alt = null;
    if (shorter && m.total - bagClub(shorter.id).dist <= 5) alt = `${shorter.name} a fondo (${bagClub(shorter.id).dist} m)`;
    else if (cfg.dist - m.total > 10 && i > 0) alt = `${club.name} suave`;
    const partial = i === 0 && m.total < cfg.dist * 0.8;
    // punto de mira: corrige viento cruzado y curva habitual
    const curve = (SHAPE_CURVE[cfg.shape] || 0) * m.D;
    const aimRight = -(m.drift + curve);
    const L = m.D || 1;
    const u = { x: (to.x - from.x) / L, y: (to.y - from.y) / L };
    const r = { x: -u.y, y: u.x };
    const aim = { x: to.x + r.x * aimRight, y: to.y + r.y * aimRight };
    // ¿el fallo habitual acaba en un obstáculo?
    let warn = null;
    const off = { izquierda: [-12, 0], derecha: [12, 0], corto: [0, -15], largo: [0, 15] }[cfg.miss];
    if (off) {
      const pt = { x: to.x + r.x * off[0] + u.x * off[1], y: to.y + r.y * off[0] + u.y * off[1] };
      const s = h.surfaceAt(pt.x, pt.y);
      if (s === 'water' || s === 'ob' || s === 'sand') {
        warn = `tu fallo habitual (${cfg.miss}) acaba en ${s === 'water' ? 'agua' : s === 'ob' ? 'fuera de límites' : 'búnker'}`;
      }
    }
    return { club, cfg, model: m, alt, partial, aimRight, aim, curve, warn, from, to };
  }

  const LIES = [
    ['fairway', 'Calle'], ['rough', 'Rough'], ['sand', 'Búnker'], ['green', 'Green'],
    ['water', 'Agua'], ['ob', 'Fuera'], ['tee', 'Tee'],
  ];
  const lieName = (l) => (LIES.find((x) => x[0] === l) || [l, l])[1];

  const TEES = [
    ['amarillas', 'Amarillas', '#f2cf3c'],
    ['rojas', 'Rojas', '#d6342c'],
  ];
  const ROUTES = [
    ['18', '18 hoyos', [1, 18]],
    ['ida', 'Ida (1-9)', [1, 9]],
    ['vuelta', 'Vuelta (10-18)', [10, 18]],
  ];

  const fmtDate = (iso) =>
    new Date(iso).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const signed = (d) => (d === 0 ? 'E' : (d > 0 ? '+' : '') + d);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // ---------- almacenamiento ----------

  const LOCAL_KEY = 'sotoverde-vueltas';
  const Store = {
    mode: 'local',
    db: null,
    uid: null,
    readOnly: false,
    timers: {},
    writing: {},
    dirty: {},

    async init() {
      try {
        if (window.claude && window.claude.use) {
          const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
          const uid = user ? await user.id() : null;
          if (db && uid) {
            this.db = db;
            this.uid = uid;
            this.mode = 'db';
          }
        }
      } catch (e) {
        this.mode = 'local';
      }
    },
    col() {
      return this.db.collection('data/users/' + this.uid);
    },
    async list() {
      if (this.mode === 'db') {
        try {
          const snap = await this.col().get();
          return snap.docs.filter((d) => d.exists).map((d) => JSON.parse(JSON.stringify(d.data()))).filter(isRound);
        } catch (e) {
          toast('No se pudieron cargar tus vueltas. Vuelve a abrir la página en un momento.');
          return [];
        }
      }
      try {
        return (JSON.parse(localStorage.getItem(LOCAL_KEY)) || []).filter(isRound);
      } catch (e) {
        return [];
      }
    },
    // Guarda con una pausa corta y nunca dos escrituras a la vez sobre la misma vuelta.
    save(round) {
      round.updatedAt = new Date().toISOString();
      clearTimeout(this.timers[round.id]);
      this.timers[round.id] = setTimeout(() => this.flush(round), 600);
    },
    async flush(round) {
      if (this.mode !== 'db') {
        try {
          const all = (JSON.parse(localStorage.getItem(LOCAL_KEY)) || []).filter((r) => r.id !== round.id);
          all.push(round);
          localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
        } catch (e) {
          toast('No se pudo guardar en este navegador.');
        }
        return;
      }
      if (this.readOnly) return;
      if (this.writing[round.id]) {
        this.dirty[round.id] = true;
        return;
      }
      this.writing[round.id] = true;
      try {
        await this.col().doc(round.id).set(JSON.parse(JSON.stringify(round)));
      } catch (e) {
        if (e && e.code === 'invalid_argument') {
          this.readOnly = true;
          toast('No tienes permiso para guardar vueltas en esta página.');
        } else if (e && e.code === 'quota_exceeded') {
          toast('El espacio para vueltas está lleno: borra alguna vuelta antigua.');
        } else {
          toast('No se pudo guardar; se reintentará con el próximo cambio.');
        }
      } finally {
        this.writing[round.id] = false;
        if (this.dirty[round.id]) {
          this.dirty[round.id] = false;
          this.flush(round);
        }
      }
    },
    async loadBag() {
      try {
        if (this.mode === 'db') {
          const d = await this.col().doc('bolsa').get();
          return d.exists ? JSON.parse(JSON.stringify(d.data())) : null;
        }
        return JSON.parse(localStorage.getItem(LOCAL_KEY + '-bolsa'));
      } catch (e) {
        return null;
      }
    },
    saveBag(b) {
      clearTimeout(this.timers.bolsa);
      this.timers.bolsa = setTimeout(async () => {
        if (this.mode !== 'db') {
          try {
            localStorage.setItem(LOCAL_KEY + '-bolsa', JSON.stringify(b));
          } catch (e) {
            toast('No se pudo guardar la bolsa en este navegador.');
          }
          return;
        }
        if (this.readOnly || this.writing.bolsa) {
          this.dirty.bolsa = true;
          return;
        }
        this.writing.bolsa = true;
        try {
          await this.col().doc('bolsa').set(JSON.parse(JSON.stringify(b)));
        } catch (e) {
          toast('No se pudo guardar la bolsa.');
        } finally {
          this.writing.bolsa = false;
          if (this.dirty.bolsa) {
            this.dirty.bolsa = false;
            this.saveBag(b);
          }
        }
      }, 600);
    },
    async remove(id) {
      if (this.mode === 'db') {
        try {
          await this.col().doc(id).delete();
        } catch (e) {
          toast('No se pudo borrar la vuelta.');
        }
        return;
      }
      try {
        const all = (JSON.parse(localStorage.getItem(LOCAL_KEY)) || []).filter((r) => r.id !== id);
        localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
      } catch (e) {
        /* nada que hacer */
      }
    },
  };

  // Solo documentos con forma de vuelta (la colección podría tener otros).
  function isRound(r) {
    return r && r.id !== 'bolsa' && typeof r.id === 'string' && typeof r.date === 'string' && Array.isArray(r.holes) && r.scores && typeof r.scores === 'object';
  }

  // ---------- modelo ----------

  let rounds = [];
  let round = null;
  let view = 'home';
  const ui = {
    selectedClub: null, clubManual: false, editIndex: null, moveIndex: null, pendingDrop: false, showAll: false,
    target: null, pickTarget: false, condOpen: false,
  };

  const prepared = {};
  function holeData(n) {
    const key = n + ':' + round.tees;
    if (!prepared[key]) prepared[key] = GC.prepareHole(byNumber[n], round.tees);
    return prepared[key];
  }

  function holeScore(n) {
    if (!round.scores[n]) round.scores[n] = { entries: [], putts: 0, done: false };
    return round.scores[n];
  }

  // Posiciones de la bola tras cada anotación: [tee, tras 1ª, tras 2ª…]
  function positions(n) {
    const h = holeData(n);
    const hs = holeScore(n);
    const pos = [{ x: h.tee.x, y: h.tee.y }];
    for (const e of hs.entries) {
      const prev = pos[pos.length - 1];
      pos.push(e.x != null ? { x: e.x, y: e.y } : prev);
    }
    return pos;
  }

  function holeStats(n) {
    const raw = byNumber[n];
    const h = holeData(n);
    const hs = holeScore(n);
    const pos = positions(n);
    const strokes = hs.entries.length + hs.putts;
    const shots = [];
    let firstGreen = null;
    hs.entries.forEach((e, i) => {
      if (e.t === 's') {
        shots.push({ club: e.c, lie: e.l, dist: GC.dist(pos[i], pos[i + 1]) });
        if (e.l === 'green' && firstGreen == null) firstGreen = i + 1;
      }
    });
    const firstShot = hs.entries.find((e) => e.t === 's');
    const fairway = raw.par >= 4 && firstShot ? firstShot.l === 'fairway' : null;
    const holedAt = hs.done ? strokes : null;
    const gir = hs.done || firstGreen
      ? (firstGreen != null && firstGreen <= raw.par - 2) || (holedAt != null && hs.putts === 0 && holedAt <= raw.par - 2)
      : null;
    const pens = hs.entries.filter((e) => e.t === 'p').length;
    const cur = pos[pos.length - 1];
    return {
      par: raw.par, strokes, putts: hs.putts, done: hs.done, fairway, gir, pens, shots,
      toPin: GC.dist(cur, h.pin), lie: lastLie(n), started: hs.entries.length + hs.putts > 0,
    };
  }

  function lastLie(n) {
    const hs = holeScore(n);
    for (let i = hs.entries.length - 1; i >= 0; i--) if (hs.entries[i].t === 's') return hs.entries[i].l;
    return 'tee';
  }

  // Golpes de todos los hoyos empezados; el resultado al par solo con los terminados.
  function totals(r = round) {
    let strokes = 0;
    let doneStrokes = 0;
    let par = 0;
    let played = 0;
    for (const n of r.holes) {
      const hs = r.scores[n];
      if (!hs || !(hs.entries.length + hs.putts)) continue;
      strokes += hs.entries.length + hs.putts;
      played++;
      if (hs.done) {
        doneStrokes += hs.entries.length + hs.putts;
        par += byNumber[n].par;
      }
    }
    return { strokes, par, played, diff: doneStrokes - par };
  }

  // Medias por palo con todas las vueltas guardadas (para sugerir palo y para la tarjeta).
  function clubAverages(list) {
    const acc = {};
    for (const r of list) {
      for (const n of r.holes) {
        const hs = r.scores && r.scores[n];
        if (!hs || !byNumber[n]) continue;
        const saved = round;
        round = r;
        const pos = positions(n);
        hs.entries.forEach((e, i) => {
          if (e.t !== 's' || !e.c || e.l === 'water' || e.l === 'ob') return;
          const d = GC.dist(pos[i], pos[i + 1]);
          if (d < 5) return;
          (acc[e.c] = acc[e.c] || []).push(d);
        });
        round = saved;
      }
    }
    return acc;
  }

  function suggestClub(n) {
    const rec = recommend(n);
    return rec ? rec.club.id : null;
  }

  function newRound(tees, routeKey) {
    const [, , [a, b]] = ROUTES.find((r) => r[0] === routeKey);
    const holes = COURSE.map((h) => h.number).filter((n) => n >= a && n <= b);
    const now = new Date().toISOString();
    return {
      id: 'v' + Date.now().toString(36),
      v: 1,
      course: 'sotoverde',
      date: now,
      tees,
      route: routeKey,
      holes,
      cur: 0,
      finished: false,
      scores: {},
      cond: { temp: form.temp, wind: form.wind, from: form.from },
      createdAt: now,
      updatedAt: now,
    };
  }

  // ---------- inicio ----------

  const form = { tees: 'amarillas', route: '18', temp: 20, wind: 0, from: 270 };

  // Controles de condiciones (temperatura y viento), reutilizados al empezar y durante la vuelta.
  function condControls(c, prefix) {
    return `<div class="field"><label>Temperatura</label>
        <span class="stepper"><button data-c="${prefix}temp-" aria-label="Menos grados">−</button><span class="val">${c.temp}°</span><button data-c="${prefix}temp+" aria-label="Más grados">+</button></span></div>
      <div class="field"><label>Viento</label>
        <span class="stepper"><button data-c="${prefix}wind-" aria-label="Menos viento">−</button><span class="val">${c.wind}</span><button data-c="${prefix}wind+" aria-label="Más viento">+</button></span>
        <span class="stepper-label">km/h</span></div>
      <div class="field"><label>Viento del… (de dónde sopla)</label>
        <div class="seg">${WIND_DIRS.map(([k, d]) => `<button data-c="${prefix}from" data-d="${d}" aria-pressed="${c.from === d}">${k}</button>`).join('')}</div></div>`;
  }

  function bindCond(root, c, prefix, onChange) {
    root.querySelectorAll(`[data-c^="${prefix}"]`).forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.c.slice(prefix.length);
        if (k === 'temp-') c.temp = Math.max(-10, c.temp - 1);
        if (k === 'temp+') c.temp = Math.min(45, c.temp + 1);
        if (k === 'wind-') c.wind = Math.max(0, c.wind - 2);
        if (k === 'wind+') c.wind = Math.min(80, c.wind + 2);
        if (k === 'from') c.from = Number(b.dataset.d);
        onChange();
      };
    });
  }

  function renderHome() {
    view = 'home';
    teardownMap();
    const storage = Store.mode === 'db'
      ? 'Tus vueltas se guardan en tu cuenta y solo las ves tú.'
      : 'Sin conexión a tu cuenta: las vueltas se guardan solo en este navegador.';
    app.className = 'wrap';
    app.innerHTML = `
      <header class="brand">
        <h1>Mis vueltas</h1><span>Golf Sotoverde · par 60</span>
      </header>
      <p class="storage-note">${storage}</p>

      <h2 class="section-title">Nueva vuelta</h2>
      <div class="panel stack">
        <div class="field"><label>Barras de salida</label>
          <div class="seg" id="f-tees">${TEES.map(([k, l, c]) =>
            `<button type="button" data-k="${k}" aria-pressed="${form.tees === k}"><span class="dot" style="background:${c}"></span>${l}</button>`).join('')}</div>
        </div>
        <div class="field"><label>Recorrido</label>
          <div class="seg" id="f-route">${ROUTES.map(([k, l]) =>
            `<button type="button" data-k="${k}" aria-pressed="${form.route === k}">${l}</button>`).join('')}</div>
        </div>
        ${condControls(form, 'f-')}
        <div><button class="btn primary" id="start" ${listLoaded ? '' : 'disabled'}>Empezar vuelta</button></div>
      </div>

      <h2 class="section-title">Mi bolsa</h2>
      <div class="panel stack">
        <p class="bag-summary">${CLUBS.filter((c) => bagClub(c.id).on).map((c) => `<span><b>${c.name}</b> <span class="num">${bagClub(c.id).dist}</span></span>`).join('') || '<span class="muted">Sin palos.</span>'}</p>
        <div><button class="btn" id="bag">Editar mi bolsa</button></div>
      </div>

      <h2 class="section-title">Vueltas</h2>
      <div class="rounds" id="list"><p class="empty">Cargando tus vueltas…</p></div>

      <p class="foot"><a href="jugar.html">Modo juego (estilo Golf Clash)</a>
        <span>Mapas: ortofoto y MDT © IGN · contorno © OpenStreetMap</span></p>`;
    app.querySelectorAll('#f-tees button').forEach((b) => (b.onclick = () => { form.tees = b.dataset.k; renderHome(); }));
    app.querySelectorAll('#f-route button').forEach((b) => (b.onclick = () => { form.route = b.dataset.k; renderHome(); }));
    bindCond(app, form, 'f-', renderHome);
    app.querySelector('#bag').onclick = renderBag;
    app.querySelector('#start').onclick = () => {
      round = newRound(form.tees, form.route);
      rounds.unshift(round);
      Store.save(round);
      openHole(0);
    };
    renderList();
  }

  function renderList() {
    const box = app.querySelector('#list');
    if (!box) return;
    if (!listLoaded) return;
    if (!rounds.length) {
      box.innerHTML = '<p class="empty">Aún no hay vueltas. Elige barras y recorrido y pulsa «Empezar vuelta»: en cada hoyo tocas en el mapa dónde quedó la bola.</p>';
      return;
    }
    const sorted = rounds.slice().sort((a, b) => b.date.localeCompare(a.date));
    box.innerHTML = sorted.map((r) => {
      const t = totals(r);
      const route = ROUTES.find((x) => x[0] === r.route);
      const tee = TEES.find((x) => x[0] === r.tees);
      return `<div class="round-row" data-id="${esc(r.id)}">
        <div class="title">${esc(fmtDate(r.date))}${r.finished ? '' : '<span class="pill">En curso</span>'}</div>
        <div class="meta">${route ? route[1] : ''} · ${tee ? tee[1] : r.tees} · ${t.played} hoyo${t.played === 1 ? '' : 's'} jugados</div>
        <div class="score num">${t.played ? t.strokes : '–'}<small>${t.played ? signed(t.diff) + ' al par' : 'sin golpes'}</small></div>
        <div class="actions">
          <button class="btn small primary" data-act="open">${r.finished ? 'Ver tarjeta' : 'Continuar'}</button>
          ${r.finished ? '<button class="btn small" data-act="edit">Editar golpes</button>' : '<button class="btn small" data-act="card">Tarjeta</button>'}
          <button class="btn small danger" data-act="del">Borrar</button>
        </div></div>`;
    }).join('');
    box.querySelectorAll('.round-row').forEach((row) => {
      const r = rounds.find((x) => x.id === row.dataset.id);
      row.querySelectorAll('button').forEach((b) => {
        b.onclick = async () => {
          const act = b.dataset.act;
          if (act === 'del') {
            if (!b.dataset.armed) {
              b.dataset.armed = '1';
              b.textContent = '¿Borrar? Toca otra vez';
              return;
            }
            rounds = rounds.filter((x) => x !== r);
            await Store.remove(r.id);
            renderList();
            return;
          }
          round = r;
          if (act === 'open' && r.finished) renderCard();
          else if (act === 'card') renderCard();
          else openHole(Math.min(r.cur || 0, r.holes.length - 1));
        };
      });
    });
  }

  // ---------- hoyo ----------

  let canvas = null;
  let ctx = null;
  let cam = null;
  let mapView = { cx: 0, cy: 0 };
  let resizeObs = null;

  function teardownMap() {
    if (resizeObs) resizeObs.disconnect();
    resizeObs = null;
    canvas = null;
  }

  function openHole(idx) {
    round.cur = idx;
    ui.editIndex = null;
    ui.moveIndex = null;
    ui.pendingDrop = false;
    ui.showAll = false;
    const n = round.holes[idx];
    ui.selectedClub = suggestClub(n);
    view = 'hole';
    app.className = 'hole-view';
    app.innerHTML = `
      <div class="hole-bar">
        <button class="nav" id="prev" aria-label="Hoyo anterior">‹</button>
        <div class="hole-id" id="hole-id"></div>
        <div class="total" id="total"></div>
        <button class="nav" id="next" aria-label="Hoyo siguiente">›</button>
      </div>
      <div class="map-wrap" id="map">
        <canvas></canvas>
        <div class="map-tools">
          <button id="zoom" aria-label="Ver el hoyo entero o acercar">Todo</button>
          <button id="gps" aria-label="Usar mi posición">GPS</button>
        </div>
        <div class="map-hint" id="hint"></div>
      </div>
      <div class="sheet" id="sheet"></div>`;
    canvas = app.querySelector('canvas');
    ctx = canvas.getContext('2d');
    app.querySelector('#prev').onclick = () => idx > 0 && openHole(idx - 1);
    app.querySelector('#next').onclick = () => (idx < round.holes.length - 1 ? openHole(idx + 1) : renderCard());
    app.querySelector('#zoom').onclick = () => {
      ui.showAll = !ui.showAll;
      drawMap();
    };
    app.querySelector('#gps').onclick = useGps;
    if (!('geolocation' in navigator)) app.querySelector('#gps').hidden = true;
    bindMap();
    const wrap = app.querySelector('#map');
    resizeObs = new ResizeObserver(() => sizeCanvas());
    resizeObs.observe(wrap);
    sizeCanvas();
    renderHoleUi();
    Store.save(round);
  }

  function sizeCanvas() {
    if (!canvas) return;
    const r = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    canvas.dataset.dpr = dpr;
    mapView = { cx: r.width / 2, cy: r.height / 2 - 22, w: r.width, h: r.height };
    drawMap();
  }

  function currentN() {
    return round.holes[round.cur];
  }

  function fitCamera() {
    const n = currentN();
    const h = holeData(n);
    const rot = GC.holeRotation(h);
    const rect = { w: mapView.w - 40, h: mapView.h - 110 }; // deja libre la franja del aviso inferior
    const all = GC.fitCamera(GC.holeCorners(h), rot, rect, 10, 0.05, 60);
    if (ui.showAll) return all;
    const pos = positions(n);
    const pts = pos.concat([h.pin]);
    return GC.fitCamera(pts, rot, rect, 30, all.zoom, 14);
  }

  function drawMap() {
    if (!canvas || view !== 'hole') return;
    const n = currentN();
    const h = holeData(n);
    const dpr = Number(canvas.dataset.dpr) || 1;
    cam = fitCamera();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = GC.COLORS.forest;
    ctx.fillRect(0, 0, mapView.w, mapView.h);
    ctx.save();
    GC.applyCamera(ctx, cam, mapView);
    GC.renderHole(ctx, h, 0, { showSlope: false });
    ctx.restore();

    const w2s = (p) => GC.worldToScreen(cam, mapView, p);
    const pin = w2s(h.pin);
    GC.drawFlag(ctx, pin.x, pin.y, GC.clamp(cam.zoom / 7, 0.5, 1.1), 0, 2);

    const hs = holeScore(n);
    const pos = positions(n);
    // trayectoria
    ctx.save();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.setLineDash([]);
    for (let i = 1; i < pos.length; i++) {
      const a = w2s(pos[i - 1]);
      const b = w2s(pos[i]);
      if (a.x === b.x && a.y === b.y) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      const d = GC.dist(pos[i - 1], pos[i]);
      if (d >= 8) pill(`${Math.round(d)} m`, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    ctx.restore();
    // tee
    const t = w2s(pos[0]);
    dot(t.x, t.y, '#f2cf3c', 'T', false);
    // golpes
    hs.entries.forEach((e, i) => {
      if (e.x == null) return;
      const p = w2s(e);
      const sel = ui.editIndex === i;
      dot(p.x, p.y, e.t === 'p' ? '#d6342c' : '#ffffff', String(i + 1), sel);
    });
    // distancia a bandera desde la posición actual
    const cur = pos[pos.length - 1];
    if (hs.entries.length && !hs.done) {
      const c = w2s(cur);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,216,74,0.9)';
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(pin.x, pin.y);
      ctx.stroke();
      ctx.restore();
    }
    const rec = recommend(n);
    if (rec) {
      const a = w2s(rec.aim);
      const f = w2s(rec.from);
      ctx.save();
      ctx.strokeStyle = 'rgba(120,200,255,0.95)';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(f.x, f.y);
      ctx.lineTo(a.x, a.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(a.x, a.y, 9, 0, Math.PI * 2);
      ctx.moveTo(a.x - 14, a.y);
      ctx.lineTo(a.x + 14, a.y);
      ctx.moveTo(a.x, a.y - 14);
      ctx.lineTo(a.x, a.y + 14);
      ctx.stroke();
      if (ui.target) {
        const t = w2s(ui.target);
        ctx.fillStyle = 'rgba(120,200,255,0.35)';
        ctx.beginPath();
        ctx.arc(t.x, t.y, 6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    drawWind();
    app.querySelector('#zoom').textContent = ui.showAll ? 'Cerca' : 'Todo';
  }

  // Flecha del viento, girada como el mapa (el green queda arriba).
  function drawWind() {
    const c = round.cond;
    if (!c || !c.wind) return;
    const b = (((c.from + 180) % 360) * Math.PI) / 180;
    const v = { x: Math.sin(b), y: -Math.cos(b) };
    const sx = v.x * Math.cos(cam.rot) - v.y * Math.sin(cam.rot);
    const sy = v.x * Math.sin(cam.rot) + v.y * Math.cos(cam.rot);
    ctx.save();
    ctx.translate(34, 34);
    ctx.fillStyle = 'rgba(10,25,14,0.72)';
    ctx.beginPath();
    ctx.arc(0, 0, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(Math.atan2(sy, sx));
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-13, 0);
    ctx.lineTo(8, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(15, 0);
    ctx.lineTo(5, -6);
    ctx.lineTo(5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${c.wind} km/h`, 34, 72);
    ctx.restore();
  }

  function dot(x, y, fill, label, selected) {
    ctx.save();
    if (selected) {
      ctx.strokeStyle = '#ffd84a';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(x, y, 15, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = fill;
    ctx.strokeStyle = '#13201a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = fill === '#ffffff' || fill === '#f2cf3c' ? '#13201a' : '#ffffff';
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y + 0.5);
    ctx.restore();
  }

  function pill(text, x, y) {
    ctx.save();
    ctx.font = '600 11px system-ui, sans-serif';
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = 'rgba(10,25,14,0.78)';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x - w / 2, y - 9, w, 18, 9) : ctx.rect(x - w / 2, y - 9, w, 18);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function bindMap() {
    let down = null;
    canvas.addEventListener('pointerdown', (e) => {
      const r = canvas.getBoundingClientRect();
      down = { x: e.clientX - r.left, y: e.clientY - r.top };
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!down) return;
      const r = canvas.getBoundingClientRect();
      const p = { x: e.clientX - r.left, y: e.clientY - r.top };
      const moved = Math.hypot(p.x - down.x, p.y - down.y);
      down = null;
      if (moved < 10) tapMap(p);
    });
  }

  function tapMap(p) {
    const n = currentN();
    const hs = holeScore(n);
    const h = holeData(n);
    if (ui.pickTarget) {
      ui.target = GC.screenToWorld(cam, mapView, p);
      ui.pickTarget = false;
      if (!ui.clubManual) ui.selectedClub = suggestClub(n);
      drawMap();
      renderHoleUi();
      return;
    }
    // ¿toca un golpe ya apuntado? -> editarlo
    if (ui.moveIndex == null && !ui.pendingDrop) {
      for (let i = hs.entries.length - 1; i >= 0; i--) {
        const e = hs.entries[i];
        if (e.x == null) continue;
        const s = GC.worldToScreen(cam, mapView, e);
        if (Math.hypot(s.x - p.x, s.y - p.y) < 18) {
          ui.editIndex = ui.editIndex === i ? null : i;
          drawMap();
          renderHoleUi();
          return;
        }
      }
    }
    const w = GC.screenToWorld(cam, mapView, p);
    placeAt(w, h, hs);
  }

  function placeAt(w, h, hs) {
    const x = Math.round(w.x * 10) / 10;
    const y = Math.round(w.y * 10) / 10;
    if (hs.done) {
      toast('Este hoyo está terminado. Toca «Reabrir» para seguir apuntando.');
      return;
    }
    if (ui.moveIndex != null) {
      const e = hs.entries[ui.moveIndex];
      e.x = x;
      e.y = y;
      if (e.t === 's') e.l = detectLie(h, x, y);
      ui.moveIndex = null;
    } else if (ui.pendingDrop) {
      const e = hs.entries[hs.entries.length - 1];
      e.x = x;
      e.y = y;
      ui.pendingDrop = false;
    } else {
      if (!ui.selectedClub) {
        toast('Elige primero el palo del golpe.');
        return;
      }
      hs.entries.push({ t: 's', x, y, c: ui.selectedClub, l: detectLie(h, x, y) });
      ui.editIndex = null;
      ui.target = null;
      ui.clubManual = false;
      const last = hs.entries[hs.entries.length - 1];
      if (last.l === 'water' || last.l === 'ob') {
        toast(last.l === 'water' ? 'Bola al agua: añade la penalización si dropas.' : 'Fuera de límites: añade la penalización.');
      }
    }
    ui.selectedClub = suggestClub(currentN());
    afterChange();
  }

  function detectLie(h, x, y) {
    const s = h.surfaceAt(x, y);
    return s === 'tee' && GC.dist({ x, y }, h.tee) > 12 ? 'fairway' : s;
  }

  function afterChange() {
    Store.save(round);
    drawMap();
    renderHoleUi();
  }

  function renderHoleUi() {
    const n = currentN();
    const raw = byNumber[n];
    const h = holeData(n);
    const hs = holeScore(n);
    const st = holeStats(n);
    const idx = round.cur;
    const tee = (raw.tees && raw.tees[round.tees]) ? round.tees : 'amarillas';
    app.querySelector('#hole-id').innerHTML = `
      <div class="hole-num num">${n}</div>
      <div class="hole-meta"><b>Par ${raw.par}</b> · ${h.length} m<br>${tee === round.tees ? '' : 'sin rojas · '}${idx + 1}/${round.holes.length}</div>`;
    const t = totals();
    app.querySelector('#total').innerHTML = `<span class="num">${t.played ? signed(t.diff) : 'E'}</span><small>${t.strokes} golpes</small>`;
    app.querySelector('#prev').disabled = idx === 0;

    let hint;
    if (hs.done) hint = `Hoyo terminado en ${st.strokes}. Toca › para el siguiente.`;
    else if (ui.pickTarget) hint = 'Toca en el mapa el punto al que quieres jugar.';
    else if (ui.moveIndex != null) hint = `Toca la nueva posición del golpe ${ui.moveIndex + 1}.`;
    else if (ui.pendingDrop) hint = 'Toca dónde dropas la bola.';
    else if (hs.putts > 0) hint = 'Putts apuntados: pulsa «Terminar hoyo» al embocar.';
    else if (st.lie === 'green') hint = 'En el green: apunta los putts abajo.';
    else hint = `Toca dónde quedó la bola · golpe ${hs.entries.length + 1}${ui.selectedClub ? ' con ' + clubName(ui.selectedClub) : ''}`;
    app.querySelector('#hint').textContent = hint;

    const sheet = app.querySelector('#sheet');
    const status = `<div class="status"><span>Golpe <b class="num">${st.strokes + 1}</b> · desde <b>${lieName(st.lie)}</b></span>
      <span>A bandera <b class="num">${Math.round(st.toPin)} m</b></span></div>`;

    const chips = hs.entries.map((e, i) => {
      const pos = positions(n);
      const d = e.t === 's' ? Math.round(GC.dist(pos[i], pos[i + 1])) : null;
      const label = e.t === 'p' ? 'Penalización' : `${clubName(e.c)} · ${d} m · ${lieName(e.l)}`;
      return `<button class="shot-chip${e.t === 'p' ? ' pen' : ''}" data-i="${i}" aria-pressed="${ui.editIndex === i}"><span class="n">${i + 1}</span>${esc(label)}</button>`;
    }).join('');

    let editor = '';
    if (ui.editIndex != null && hs.entries[ui.editIndex]) {
      const e = hs.entries[ui.editIndex];
      editor = `<div class="editor">
        ${e.t === 's' ? `<div class="seg" id="e-club">${CLUBS.map((c) => `<button data-k="${c.id}" aria-pressed="${e.c === c.id}">${c.name}</button>`).join('')}</div>
        <div class="seg" id="e-lie">${LIES.map(([k, l]) => `<button data-k="${k}" aria-pressed="${e.l === k}">${l}</button>`).join('')}</div>` : '<span class="muted">Golpe de penalización.</span>'}
        <div class="row"><button class="btn small" id="e-move">${e.t === 's' ? 'Mover en el mapa' : 'Marcar el drop'}</button>
        <button class="btn small danger" id="e-del">Borrar</button><span class="grow"></span><button class="btn small" id="e-close">Listo</button></div>
      </div>`;
    }

    const c = round.cond || (round.cond = { temp: bag.tref, wind: 0, from: 270 });
    const condLine = `<div class="row cond"><span class="muted">${c.temp}° · ${c.wind ? `viento ${c.wind} km/h del ${dirName(c.from)}` : 'sin viento'}</span>
      <span class="grow"></span>
      <button class="btn small" id="cond-btn" aria-expanded="${ui.condOpen}">${ui.condOpen ? 'Listo' : 'Condiciones'}</button>
      ${hs.done ? '' : `<button class="btn small" id="target-btn">${ui.pickTarget ? 'Toca el objetivo…' : ui.target ? 'Objetivo: punto ✕' : 'Objetivo: bandera'}</button>`}</div>
      ${ui.condOpen ? `<div class="editor">${condControls(c, 'h-')}</div>` : ''}`;
    const rec = recommend(n);
    const term = (v, label) => (Math.abs(v) < 0.5 ? '' : ` ${v > 0 ? '+' : '−'} ${Math.round(Math.abs(v))} ${label}`);
    let recHtml = '';
    if (rec) {
      const m = rec.model;
      const parts = [];
      if (Math.abs(m.drift) >= 0.5) parts.push(`viento cruzado ${Math.round(Math.abs(m.drift))} m`);
      if (Math.abs(rec.curve) >= 0.5) parts.push(`tu ${rec.cfg.shape} ${Math.round(Math.abs(rec.curve))} m`);
      recHtml = `<div class="rec">
        <div class="rec-main"><span class="rec-k">Recomendado</span><b>${rec.club.name}</b>
          <span class="muted">${rec.partial ? 'golpe corto, a media distancia' : `${rec.cfg.dist} m habitual${rec.alt ? ' · o ' + rec.alt : ''}`}</span>
          <span class="grow"></span>${ui.selectedClub === rec.club.id ? '' : '<button class="btn small" id="use-rec">Usar</button>'}</div>
        <div class="rec-calc">Juega <b class="num">${Math.round(m.total)} m</b> = ${Math.round(m.D)} m${term(m.elev, 'de desnivel')}${term(m.wind, m.head > 0 ? 'de viento en contra' : 'de viento a favor')}${term(m.temp, 'por temperatura')}</div>
        ${Math.abs(rec.aimRight) >= 1 ? `<div class="rec-aim">Apunta ${Math.round(Math.abs(rec.aimRight))} m a la ${rec.aimRight < 0 ? 'izquierda' : 'derecha'} (${parts.join(', ')})</div>` : ''}
        ${rec.warn ? `<div class="rec-warn">Cuidado: ${rec.warn}.</div>` : ''}
      </div>`;
    }

    sheet.innerHTML = `${status}
      ${condLine}
      ${recHtml}
      ${hs.done ? '' : `<div class="clubs" id="clubs">${CLUBS.filter((x) => bagClub(x.id).on || x.id === ui.selectedClub).map((x) => `<button data-k="${x.id}" aria-pressed="${ui.selectedClub === x.id}">${x.name}</button>`).join('')}</div>`}
      ${chips ? `<div class="shots" id="shots">${chips}</div>` : ''}
      ${editor}
      <div class="row">
        <span class="stepper-label">Putts</span>
        <span class="stepper"><button id="p-minus" aria-label="Quitar putt">−</button><span class="val" id="p-val">${hs.putts}</span><button id="p-plus" aria-label="Añadir putt">+</button></span>
        <span class="grow"></span>
        ${hs.done ? '' : '<button class="btn small" id="pen">+1 penalización</button>'}
        <button class="btn small" id="undo" ${hs.entries.length ? '' : 'disabled'}>Deshacer</button>
      </div>
      <div class="row">
        <button class="btn" id="to-card">Tarjeta</button>
        <span class="grow"></span>
        ${hs.done ? '<button class="btn" id="reopen">Reabrir hoyo</button>' : `<button class="btn primary" id="finish" ${st.strokes ? '' : 'disabled'}>Terminar hoyo · ${st.strokes}</button>`}
      </div>`;

    sheet.querySelectorAll('#clubs button').forEach((b) => (b.onclick = () => { ui.selectedClub = b.dataset.k; ui.clubManual = true; renderHoleUi(); }));
    sheet.querySelector('#cond-btn').onclick = () => { ui.condOpen = !ui.condOpen; renderHoleUi(); };
    bindCond(sheet, c, 'h-', () => {
      if (!ui.clubManual) ui.selectedClub = suggestClub(n);
      Store.save(round);
      drawMap();
      renderHoleUi();
    });
    const tb = sheet.querySelector('#target-btn');
    if (tb) tb.onclick = () => {
      if (ui.target || ui.pickTarget) {
        ui.target = null;
        ui.pickTarget = false;
        if (!ui.clubManual) ui.selectedClub = suggestClub(n);
        drawMap();
      } else {
        ui.pickTarget = true;
      }
      renderHoleUi();
    };
    const ur = sheet.querySelector('#use-rec');
    if (ur) ur.onclick = () => { ui.selectedClub = rec.club.id; ui.clubManual = false; renderHoleUi(); };
    const sel = sheet.querySelector('#clubs button[aria-pressed="true"]');
    if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'center' });
    sheet.querySelectorAll('#shots .shot-chip').forEach((b) => (b.onclick = () => {
      const i = Number(b.dataset.i);
      ui.editIndex = ui.editIndex === i ? null : i;
      drawMap();
      renderHoleUi();
    }));
    if (editor) {
      const e = hs.entries[ui.editIndex];
      sheet.querySelectorAll('#e-club button').forEach((b) => (b.onclick = () => { e.c = b.dataset.k; afterChange(); }));
      sheet.querySelectorAll('#e-lie button').forEach((b) => (b.onclick = () => { e.l = b.dataset.k; afterChange(); }));
      sheet.querySelector('#e-move').onclick = () => {
        if (hs.done) hs.done = false;
        ui.moveIndex = ui.editIndex;
        renderHoleUi();
      };
      sheet.querySelector('#e-del').onclick = () => {
        hs.entries.splice(ui.editIndex, 1);
        ui.editIndex = null;
        afterChange();
      };
      sheet.querySelector('#e-close').onclick = () => { ui.editIndex = null; drawMap(); renderHoleUi(); };
    }
    sheet.querySelector('#p-minus').onclick = () => { hs.putts = Math.max(0, hs.putts - 1); afterChange(); };
    sheet.querySelector('#p-plus').onclick = () => { hs.putts += 1; afterChange(); };
    const pen = sheet.querySelector('#pen');
    if (pen) pen.onclick = () => {
      hs.entries.push({ t: 'p' });
      ui.pendingDrop = true;
      afterChange();
    };
    sheet.querySelector('#undo').onclick = () => {
      hs.entries.pop();
      ui.editIndex = null;
      ui.pendingDrop = false;
      ui.moveIndex = null;
      afterChange();
    };
    sheet.querySelector('#to-card').onclick = renderCard;
    const fin = sheet.querySelector('#finish');
    if (fin) fin.onclick = () => {
      hs.done = true;
      ui.pendingDrop = false;
      const nextIdx = round.holes.findIndex((m, i) => i > round.cur && !(round.scores[m] && round.scores[m].done));
      if (round.holes.every((m) => round.scores[m] && round.scores[m].done)) {
        round.finished = true;
        Store.save(round);
        renderCard();
        return;
      }
      Store.save(round);
      toast(`${GC.scoreName(st.strokes, st.par)} en el ${n}`);
      openHole(nextIdx >= 0 ? nextIdx : Math.min(round.cur + 1, round.holes.length - 1));
    };
    const reopen = sheet.querySelector('#reopen');
    if (reopen) reopen.onclick = () => {
      hs.done = false;
      round.finished = false;
      ui.selectedClub = suggestClub(n);
      afterChange();
    };
  }

  // GPS: solo funciona donde el navegador lo permite (no dentro de la página publicada en claude.ai).
  function useGps() {
    if (!navigator.geolocation) return;
    toast('Buscando tu posición…');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const n = currentN();
        const raw = byNumber[n];
        const u = toUtm30(p.coords.latitude, p.coords.longitude);
        const w = { x: u.x - raw.geo.origin[0], y: raw.geo.origin[1] - u.y };
        const h = holeData(n);
        if (w.x < -30 || w.y < -30 || w.x > h.width + 30 || w.y > h.height + 30) {
          toast('Tu posición queda fuera de este hoyo.');
          return;
        }
        toast(`Posición con precisión de ±${Math.round(p.coords.accuracy)} m`);
        placeAt(w, h, holeScore(n));
      },
      () => toast('La ubicación no está disponible aquí: toca en el mapa.'),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 }
    );
  }

  // WGS84 → UTM huso 30 norte (ETRS89 coincide con WGS84 a efectos prácticos).
  function toUtm30(lat, lon) {
    const a = 6378137;
    const f = 1 / 298.257223563;
    const k0 = 0.9996;
    const e2 = f * (2 - f);
    const ep2 = e2 / (1 - e2);
    const phi = (lat * Math.PI) / 180;
    const lam = (lon * Math.PI) / 180;
    const lam0 = (-3 * Math.PI) / 180;
    const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    const T = Math.tan(phi) ** 2;
    const C = ep2 * Math.cos(phi) ** 2;
    const A = Math.cos(phi) * (lam - lam0);
    const M = a * ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256) * phi
      - ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi)
      + ((15 * e2 * e2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi)
      - ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
    const x = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
    const y = k0 * (M + N * Math.tan(phi) * ((A * A) / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24
      + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
    return { x, y };
  }

  // ---------- mi bolsa: vista ----------

  function renderBag() {
    view = 'bag';
    teardownMap();
    app.className = 'wrap';
    const avg = clubAverages(rounds);
    const count = CLUBS.filter((c) => bagClub(c.id).on).length + 1;
    app.innerHTML = `
      <div class="card-head"><div><h2>Mi bolsa</h2><div class="muted" id="bag-count">${count}/14 palos contando el putter</div></div></div>
      <div class="row" style="margin:14px 0"><button class="btn" id="home">‹ Vueltas</button></div>
      <div class="panel stack">
        <div class="field"><label>Temperatura a la que das esas distancias</label>
          <span class="stepper"><button id="tref-minus" aria-label="Menos grados">−</button><span class="val">${bag.tref}°</span><button id="tref-plus" aria-label="Más grados">+</button></span></div>
        <p class="note">Distancia habitual: dónde suele quedar la bola con un golpe normal, sin viento y a esa temperatura.
          Con el vuelo, la altura y el fallo, el recomendador corrige el punto de mira y te avisa si tu fallo acaba en un obstáculo.</p>
      </div>
      <div class="bag-list">${CLUBS.map((c) => clubCard(c, avg[c.id])).join('')}</div>
      <p class="foot"><a href="jugar.html">Modo juego</a></p>`;
    app.querySelector('#home').onclick = renderHome;
    app.querySelector('#tref-minus').onclick = () => { bag.tref = Math.max(-5, bag.tref - 1); Store.saveBag(bag); renderBag(); };
    app.querySelector('#tref-plus').onclick = () => { bag.tref = Math.min(40, bag.tref + 1); Store.saveBag(bag); renderBag(); };
    CLUBS.forEach((c) => bindClubCard(c, avg[c.id]));
  }

  function clubCard(c, measured) {
    const cfg = bagClub(c.id);
    const m = measured && measured.length ? Math.round(measured.reduce((a, b) => a + b, 0) / measured.length) : null;
    const seg = (field, opts) => `<div class="seg" data-f="${field}">${opts.map(([k, l]) => `<button data-k="${k}" aria-pressed="${cfg[field] === k}">${l}</button>`).join('')}</div>`;
    return `<div class="club-card${cfg.on ? '' : ' off'}" id="club-${c.id}">
      <div class="club-head"><b>${c.name}</b>
        <label class="switch"><input type="checkbox" id="on-${c.id}" ${cfg.on ? 'checked' : ''}> En la bolsa</label></div>
      ${cfg.on ? `<div class="club-body">
        <div class="field"><label for="dist-${c.id}">Distancia habitual</label>
          <div class="row"><span class="stepper"><button data-d="-5" aria-label="5 m menos">−</button>
            <input class="val num" id="dist-${c.id}" type="number" inputmode="numeric" min="5" max="320" value="${cfg.dist}">
            <button data-d="5" aria-label="5 m más">+</button></span><span class="stepper-label">m</span>
            ${m ? `<span class="muted measured">medido ${m} m en ${measured.length} golpe${measured.length === 1 ? '' : 's'}</span><button class="btn small" data-use="${m}">Usar</button>` : ''}</div></div>
        <div class="field"><label>Vuelo habitual</label>${seg('shape', SHAPES)}</div>
        <div class="field"><label>Altura de bola</label>${seg('height', HEIGHTS)}</div>
        <div class="field"><label>Fallo más repetido</label>${seg('miss', MISSES)}</div>
      </div>` : ''}
    </div>`;
  }

  function bindClubCard(c, measured) {
    const el = app.querySelector('#club-' + c.id);
    const cfg = bag.clubs[c.id] || (bag.clubs[c.id] = bagClub(c.id));
    const redraw = () => {
      el.outerHTML = clubCard(c, measured);
      bindClubCard(c, measured);
      const cnt = app.querySelector('#bag-count');
      if (cnt) cnt.textContent = `${CLUBS.filter((x) => bagClub(x.id).on).length + 1}/14 palos contando el putter`;
      Store.saveBag(bag);
    };
    el.querySelector('#on-' + c.id).onchange = (e) => {
      if (e.target.checked && CLUBS.filter((x) => bagClub(x.id).on).length + 1 >= 14) {
        e.target.checked = false;
        toast('Las reglas permiten 14 palos como máximo, putter incluido.');
        return;
      }
      cfg.on = e.target.checked;
      redraw();
    };
    if (!cfg.on) return;
    const input = el.querySelector('#dist-' + c.id);
    input.onchange = () => {
      const v = Math.round(Number(input.value));
      if (v >= 5 && v <= 320) cfg.dist = v;
      redraw();
    };
    el.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => {
      cfg.dist = GC.clamp(cfg.dist + Number(b.dataset.d), 5, 320);
      redraw();
    }));
    const use = el.querySelector('[data-use]');
    if (use) use.onclick = () => { cfg.dist = Number(use.dataset.use); redraw(); };
    el.querySelectorAll('.seg[data-f]').forEach((sg) => sg.querySelectorAll('button').forEach((b) => (b.onclick = () => {
      cfg[sg.dataset.f] = b.dataset.k;
      redraw();
    })));
  }

  // ---------- tarjeta ----------

  function mark(strokes, par) {
    const d = strokes - par;
    const cls = d <= -2 ? 'eagle' : d === -1 ? 'birdie' : d === 1 ? 'bogey' : d >= 2 ? 'double' : '';
    return `<span class="mark ${cls}">${strokes}</span>`;
  }

  function renderCard() {
    view = 'card';
    teardownMap();
    app.className = 'wrap';
    const t = totals();
    const rows = [];
    const sum = { par: 0, strokes: 0, putts: 0 };
    let section = { par: 0, strokes: 0, putts: 0 };
    let fwHit = 0;
    let fwTot = 0;
    let girHit = 0;
    let girTot = 0;
    let pens = 0;
    let puttHoles = 0;
    const subRow = (label, s) => `<tr class="sub"><td>${label}</td><td>${s.par}</td><td>${s.strokes || '–'}</td><td>${s.putts || '–'}</td><td></td><td></td></tr>`;
    round.holes.forEach((n, i) => {
      const st = holeStats(n);
      const played = st.started;
      if (played) {
        section.par += st.par;
        section.strokes += st.strokes;
        section.putts += st.putts;
        if (st.fairway != null) { fwTot++; if (st.fairway) fwHit++; }
        if (st.done) { girTot++; if (st.gir) girHit++; puttHoles++; }
        pens += st.pens;
      } else {
        section.par += st.par;
      }
      rows.push(`<tr class="link" data-i="${i}"><td>${n}</td><td>${st.par}</td>
        <td>${played ? mark(st.strokes, st.par) + (st.done ? '' : '<span class="muted">…</span>') : '–'}</td>
        <td>${played ? st.putts : '–'}</td>
        <td>${st.fairway == null ? '<span class="muted">·</span>' : st.fairway ? '<span class="yes">✓</span>' : '<span class="no">✗</span>'}</td>
        <td>${!st.done ? '<span class="muted">·</span>' : st.gir ? '<span class="yes">✓</span>' : '<span class="no">✗</span>'}</td></tr>`);
      const endOfNine = n === 9 || i === round.holes.length - 1;
      if (endOfNine) {
        rows.push(subRow(n <= 9 ? 'Ida' : 'Vuelta', section));
        sum.par += section.par;
        sum.strokes += section.strokes;
        sum.putts += section.putts;
        section = { par: 0, strokes: 0, putts: 0 };
      }
    });
    if (round.holes.length > 9) rows.push(subRow('Total', sum));

    const avg = clubAverages([round]);
    const clubRows = CLUBS.filter((c) => avg[c.id]).map((c) => {
      const d = avg[c.id];
      const m = d.reduce((a, b) => a + b, 0) / d.length;
      return `<tr><td>${c.name}</td><td>${d.length}</td><td>${Math.round(m)} m</td><td>${Math.round(Math.max(...d))} m</td></tr>`;
    }).join('');
    const tee = TEES.find((x) => x[0] === round.tees);
    const pct = (a, b) => (b ? Math.round((100 * a) / b) + ' %' : '–');

    app.innerHTML = `
      <div class="card-head">
        <div><h2>Tarjeta</h2><div class="muted">${esc(fmtDate(round.date))} · ${tee ? tee[1] : round.tees} · ${round.finished ? 'terminada' : 'en curso'}</div></div>
        <div class="big-score num">${t.played ? t.strokes : '–'}<small>${t.played ? signed(t.diff) : ''}</small></div>
      </div>
      <div class="row" style="margin:14px 0">
        <button class="btn" id="home">‹ Vueltas</button>
        <button class="btn primary" id="resume">${round.finished ? 'Editar golpes' : 'Seguir apuntando'}</button>
      </div>
      <div class="table-scroll"><table class="score">
        <thead><tr><th>Hoyo</th><th>Par</th><th>Golpes</th><th>Putts</th><th>Calle</th><th>Green reg.</th></tr></thead>
        <tbody>${rows.join('')}</tbody></table></div>
      <p class="legend"><span><span class="mark birdie">3</span> birdie</span><span><span class="mark eagle">2</span> eagle o mejor</span>
        <span><span class="mark bogey">5</span> bogey</span><span><span class="mark double">6</span> doble o peor</span></p>

      <h2 class="section-title">Estadísticas</h2>
      <div class="stats">
        <div class="stat"><div class="k">Putts</div><div class="v num">${sum.putts || 0}</div><div class="s">${puttHoles ? (sum.putts / puttHoles).toFixed(1).replace('.', ',') + ' por hoyo' : '–'}</div></div>
        <div class="stat"><div class="k">Calles cogidas</div><div class="v num">${pct(fwHit, fwTot)}</div><div class="s">${fwHit}/${fwTot} (pares 4 y 5)</div></div>
        <div class="stat"><div class="k">Greens en regulación</div><div class="v num">${pct(girHit, girTot)}</div><div class="s">${girHit}/${girTot} hoyos</div></div>
        <div class="stat"><div class="k">Penalizaciones</div><div class="v num">${pens}</div><div class="s">golpes</div></div>
      </div>

      <h2 class="section-title">Distancias por palo</h2>
      ${clubRows ? `<div class="table-scroll"><table class="score"><thead><tr><th>Palo</th><th>Golpes</th><th>Media</th><th>Máx.</th></tr></thead><tbody>${clubRows}</tbody></table></div>
        <p class="legend">Distancia en línea recta de donde salió a donde quedó la bola (con rodada); no cuenta bolas al agua o fuera.</p>`
        : '<p class="empty">Apunta golpes en el mapa para ver tus distancias por palo.</p>'}
      <p class="foot"><a href="jugar.html">Modo juego</a></p>`;
    app.querySelector('#home').onclick = renderHome;
    app.querySelector('#resume').onclick = () => {
      const i = round.holes.findIndex((m) => !(round.scores[m] && round.scores[m].done));
      openHole(i >= 0 ? i : 0);
    };
    app.querySelectorAll('tr.link').forEach((tr) => (tr.onclick = () => openHole(Number(tr.dataset.i))));
  }

  // ---------- utilidades ----------

  let toastTimer = null;
  function toast(text) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 2600);
  }

  // ---------- arranque ----------

  let listLoaded = false;
  renderHome();
  Store.init().then(async () => {
    const savedBag = await Store.loadBag();
    if (savedBag && savedBag.clubs) {
      const base = defaultBag();
      bag = { ...base, ...savedBag, clubs: { ...base.clubs, ...savedBag.clubs } };
    }
    const loaded = await Store.list();
    const ids = new Set(loaded.map((r) => r.id));
    rounds = loaded.concat(rounds.filter((r) => !ids.has(r.id)));
    listLoaded = true;
    if (view === 'home') renderHome();
  });

  window.__vuelta = { get round() { return round; }, get store() { return Store; }, toUtm30, tapMap: (p) => tapMap(p) };
})();
