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
      hand: 'diestro',
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
  // Resultado respecto al par: categoría (para colores) y nombre.
  const parKind = (d) => (d <= -2 ? 'eagle' : d === -1 ? 'birdie' : d === 0 ? 'par' : d === 1 ? 'bogey' : 'double');
  const parName = (d) => (d <= -3 ? 'albatros' : d === -2 ? 'eagle' : d === -1 ? 'birdie' : d === 0 ? 'par'
    : d === 1 ? 'bogey' : d === 2 ? 'doble bogey' : d === 3 ? 'triple bogey' : `+${d}`);

  // Cartel grande sobre el mapa (resultado del hoyo o aviso al apuntar).
  function scoreBanner(kind, title, sub, small) {
    document.querySelectorAll('.score-banner').forEach((b) => b.remove());
    const el = document.createElement('div');
    el.className = `score-banner ${kind}${small ? ' small' : ''}`;
    el.setAttribute('role', 'status');
    el.innerHTML = `<b>${title}</b><span>${sub}</span>`;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('out'), small ? 1400 : 1900);
    setTimeout(() => el.remove(), small ? 1800 : 2300);
  }

  const golpes = (k) => `${k} golpe${k === 1 ? '' : 's'}`;
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
    selectedClub: null, clubManual: false, editIndex: null, moveIndex: null, pendingDrop: false,
    cam: null, // cámara manual (zoom/arrastre); null = encuadre automático bola-green
    loupe: null, // punto bajo el dedo mientras se mantiene pulsado
    target: null, pickTarget: false, ghost: null, more: false, putting: false,
    ghostPath: null, drawPath: null, anim: null, camAuto: false,
    inputMode: (() => { try { return localStorage.getItem('sotoverde-modo') || 'toque'; } catch (e) { return 'toque'; } })(),
  };

  // ---------- tracer: trazo del vuelo dibujado con el dedo ----------

  // Simplifica el trazo (Douglas-Peucker) para guardarlo ligero.
  function simplify(pts, tol) {
    if (pts.length <= 2) return pts.slice();
    const [a, b] = [pts[0], pts[pts.length - 1]];
    const L = GC.dist(a, b) || 1;
    let worst = 0;
    let idx = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs((b.x - a.x) * (a.y - pts[i].y) - (a.x - pts[i].x) * (b.y - a.y)) / L;
      if (d > worst) { worst = d; idx = i; }
    }
    if (worst <= tol) return [a, b];
    return simplify(pts.slice(0, idx + 1), tol).slice(0, -1).concat(simplify(pts.slice(idx), tol));
  }

  // Curva del vuelo respecto a la línea recta de salida a llegada (diestro: a la derecha = fade/slice).
  function shapeOf(path) {
    if (!path || path.length < 3) return 'recto';
    const a = path[0];
    const b = path[path.length - 1];
    const L = GC.dist(a, b) || 1;
    const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
    const r = { x: -u.y, y: u.x };
    let off = 0;
    for (const p of path) {
      const o = (p.x - a.x) * r.x + (p.y - a.y) * r.y;
      if (Math.abs(o) > Math.abs(off)) off = o;
    }
    let ratio = off / L;
    if (bag.hand === 'zurdo') ratio = -ratio;
    if (Math.abs(ratio) < 0.03) return 'recto';
    if (ratio > 0) return ratio > 0.08 ? 'slice' : 'fade';
    return ratio < -0.08 ? 'gancho' : 'draw';
  }

  const shapeName = (k) => (SHAPES.find((x) => x[0] === k) || [k, k])[1];

  // Vuelo más repetido por palo en los golpes trazados.
  function clubShapes(list) {
    const acc = {};
    for (const r of list) {
      for (const n of r.holes || []) {
        const hs = r.scores && r.scores[n];
        if (!hs) continue;
        for (const e of hs.entries) {
          if (e.t !== 's' || !e.f || !e.c) continue;
          const m = (acc[e.c] = acc[e.c] || {});
          m[e.f] = (m[e.f] || 0) + 1;
        }
      }
    }
    const out = {};
    for (const [c, m] of Object.entries(acc)) {
      const total = Object.values(m).reduce((a, b) => a + b, 0);
      const [top, cnt] = Object.entries(m).sort((x, y) => y[1] - x[1])[0];
      out[c] = { top, cnt, total };
    }
    return out;
  }

  const prepared = {};
  function holeData(n) {
    const key = n + ':' + round.tees;
    if (!prepared[key]) prepared[key] = GC.prepareHole(byNumber[n], round.tees);
    return prepared[key];
  }

  // Vueltas importadas de tarjetas oficiales: solo el total de golpes por hoyo (hs.total), sin golpes en el mapa.
  const isImported = (r) => !!(r && r.source === 'tarjeta');
  function strokesOf(hs) {
    if (!hs) return 0;
    return hs.entries.length + hs.putts || hs.total || 0;
  }
  // Par del hoyo en esa vuelta (las pruebas de pitch & putt se juegan a par 54).
  const parOf = (r, n) => (r.pars && r.pars[n]) || byNumber[n].par;

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
    const strokes = strokesOf(hs);
    const par = parOf(round, n);
    const card = isImported(round);
    const shots = [];
    let firstGreen = null;
    hs.entries.forEach((e, i) => {
      if (e.t === 's') {
        shots.push({ club: e.c, lie: e.l, dist: GC.dist(pos[i], pos[i + 1]) });
        if (e.l === 'green' && firstGreen == null) firstGreen = i + 1;
      }
    });
    const firstShot = hs.entries.find((e) => e.t === 's');
    const fairway = par >= 4 && firstShot ? firstShot.l === 'fairway' : null;
    const holedAt = hs.done ? strokes : null;
    const gir = card ? null : hs.done || firstGreen
      ? (firstGreen != null && firstGreen <= par - 2) || (holedAt != null && hs.putts === 0 && holedAt <= par - 2)
      : null;
    const pens = hs.entries.filter((e) => e.t === 'p').length;
    const cur = pos[pos.length - 1];
    return {
      par, strokes, putts: card ? null : hs.putts, done: hs.done, fairway, gir, pens, shots,
      toPin: GC.dist(cur, h.pin), lie: lastLie(n), started: strokes > 0,
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
      const k = strokesOf(hs);
      if (!k) continue;
      strokes += k;
      played++;
      if (hs.done) {
        doneStrokes += k;
        par += parOf(r, n);
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
    // metros de tarjeta (el hoyo 6 tiene codo: la recta tee-bandera se queda corta)
    const yards = COURSE.reduce((a, h) => {
      const m = /Tarjeta:\s*(\d+)\s*m/.exec(h.card || '');
      return a + (m ? Number(m[1]) : Math.round(GC.dist(GC.toPoint(h.tee), GC.toPoint(h.pin))));
    }, 0);
    app.innerHTML = `
      <header class="hero"><canvas id="hero-map" aria-hidden="true"></canvas>
        <div class="hero-in">
          <span class="eyebrow">Golf Sotoverde · Arroyo de la Encomienda</span>
          <h1 class="h-display">Mis vueltas</h1>
          <div class="hero-facts"><span><b>${COURSE.length}</b>hoyos</span><span><b>${COURSE.reduce((a, h) => a + h.par, 0)}</b>par</span><span><b>${yards.toLocaleString('es-ES')}</b>m desde amarillas</span></div>
        </div>
      </header>
      <p class="storage-note">${storage}</p>

      ${GC.Tour && GC.COURSE_3D ? `<h2 class="section-title">Conoce el campo <small>Recorrido 3D hoyo a hoyo</small></h2>
      <div class="tour" id="tour"></div>` : ''}

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
        <div class="cond-grid">${condControls(form, 'f-')}</div>
        <div><button class="btn primary hero-btn" id="start" ${listLoaded ? '' : 'disabled'}>Empezar vuelta</button></div>
      </div>

      <h2 class="section-title">Tus vueltas <small id="count"></small></h2>
      <div class="rounds" id="list"><p class="empty">Cargando tus vueltas…</p></div>

      <h2 class="section-title">Mi bolsa <button class="btn small" id="bag">Editar</button></h2>
      <div class="bag-summary">${CLUBS.filter((c) => bagClub(c.id).on).map((c) => `<span><b>${bagClub(c.id).dist}</b>${c.name}</span>`).join('') || '<span>Sin palos</span>'}</div>

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
    renderHero();
    renderTour();
  }

  // Recorrido 3D de la portada: se monta una vez con un póster y solo carga three.js al darle a reproducir.
  // La portada se repinta a menudo (formulario), así que se reutiliza el mismo nodo y su escena WebGL.
  let tour = null;
  function renderTour() {
    const el = app.querySelector('#tour');
    if (!el) return;
    if (tour) el.replaceWith(tour.container);
    else tour = GC.Tour.mount(el);
  }

  // Portada: el hoyo 9 (salida sobre el lago) de lado a lado, del tee a la izquierda al green a la derecha.
  function renderHero() {
    const cv = app.querySelector('#hero-map');
    const raw = byNumber[9] || COURSE[0];
    if (!cv || !raw) return;
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(r.width * dpr);
    cv.height = Math.round(r.height * dpr);
    const c = cv.getContext('2d');
    const h = GC.prepareHole(raw, 'amarillas');
    const rot = -h.angle;
    const camH = GC.fitCamera([h.tee, h.pin], rot, { w: r.width * 1.05, h: r.height * 0.8 }, 30, 0.1, 30);
    const v = { cx: r.width / 2, cy: r.height * 0.42 };
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.save();
    GC.applyCamera(c, camH, v);
    GC.renderHole(c, h, 0, {});
    c.restore();
    const p = GC.worldToScreen(camH, v, h.pin);
    GC.drawFlag(c, p.x, p.y, 0.9, 0.4, 3);
  }

  function renderList() {
    const box = app.querySelector('#list');
    if (!box) return;
    if (!listLoaded) return;
    const cnt = app.querySelector('#count');
    if (cnt) cnt.textContent = rounds.length ? `${rounds.length} vuelta${rounds.length === 1 ? '' : 's'}` : '';
    if (!rounds.length) {
      box.innerHTML = '<p class="empty">Aún no hay vueltas. Elige barras y recorrido y pulsa «Empezar vuelta»: en cada hoyo tocas en el mapa dónde quedó la bola y confirmas.</p>';
      return;
    }
    const sorted = rounds.slice().sort((a, b) => b.date.localeCompare(a.date));
    box.innerHTML = sorted.map((r) => {
      const t = totals(r);
      const route = ROUTES.find((x) => x[0] === r.route);
      const tee = TEES.find((x) => x[0] === r.tees);
      return `<div class="round-row" data-id="${esc(r.id)}">
        <div class="score num${t.diff < 0 ? ' under' : ''}">${t.played ? t.strokes : '–'}<small>${t.played ? signed(t.diff) : '·'}</small></div>
        <div class="title">${esc(fmtDate(r.date))}${r.finished ? '' : '<span class="pill">En curso</span>'}${isImported(r) ? '<span class="pill soft">Tarjeta</span>' : ''}</div>
        <div class="meta">${isImported(r) ? `${esc(r.event || 'Competición')} · ` : `${route ? route[1] : ''} · `}${tee ? tee[1] : r.tees} · ${t.played} hoyo${t.played === 1 ? '' : 's'} jugado${t.played === 1 ? '' : 's'}</div>
        <div class="actions">
          <button class="btn small primary" data-act="open">${r.finished ? 'Ver tarjeta' : 'Continuar'}</button>
          ${isImported(r) ? '<button class="btn small" data-act="edit">Editar golpes</button>' : r.finished ? '<button class="btn small" data-act="edit">Editar golpes</button>' : '<button class="btn small" data-act="card">Tarjeta</button>'}
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
          cardEdit = isImported(r) && act === 'edit';
          if ((act === 'open' && r.finished) || isImported(r)) renderCard();
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
  let mapView = { cx: 0, cy: 0, w: 1, h: 1 };
  let insets = { top: 90, bottom: 260 };
  let resizeObs = null;
  let baseCanvas = null;

  function teardownMap() {
    if (resizeObs) resizeObs.disconnect();
    resizeObs = null;
    canvas = null;
  }

  function openHole(idx) {
    if (isImported(round)) {
      renderCard();
      return;
    }
    round.cur = idx;
    Object.assign(ui, {
      editIndex: null, moveIndex: null, pendingDrop: false, cam: null, loupe: null, ghost: null,
      target: null, pickTarget: false, clubManual: false, more: false, putting: false,
    });
    const n = round.holes[idx];
    ui.selectedClub = suggestClub(n);
    view = 'hole';
    app.className = 'hole-view';
    app.innerHTML = `
      <div class="map-wrap" id="map"><canvas aria-label="Mapa del hoyo: toca dónde quedó la bola"></canvas></div>
      <header class="hv-top glass" id="top">
        <button class="nav" id="prev" aria-label="Hoyo anterior">‹</button>
        <div class="hv-id" id="hole-id"></div>
        <div class="hv-score" id="total"></div>
        <button class="nav" id="next" aria-label="Hoyo siguiente">›</button>
      </header>
      <div class="hv-left">
        <button class="chipbtn glass" id="go-home">‹ Vueltas</button>
        <button class="chipbtn glass" id="go-card">Tarjeta</button>
        <div class="chipbtn glass" id="wind" hidden></div>
      </div>
      <div class="map-tools glass">
        <button class="z" id="zoom-in" aria-label="Acercar">+</button>
        <button class="z" id="zoom-out" aria-label="Alejar">−</button>
        <button id="zoom-all" aria-label="Ver el hoyo entero">TODO</button>
        <button id="zoom-auto" aria-label="Encuadre automático de bola y green">AUTO</button>
        <button id="gps" aria-label="Usar mi posición">GPS</button>
      </div>
      <section class="hv-sheet" id="sheet" aria-label="Golpes del hoyo"></section>`;
    canvas = app.querySelector('canvas');
    ctx = canvas.getContext('2d');
    app.querySelector('#prev').onclick = () => idx > 0 && openHole(idx - 1);
    app.querySelector('#next').onclick = () => (idx < round.holes.length - 1 ? openHole(idx + 1) : renderCard());
    app.querySelector('#go-home').onclick = renderHome;
    app.querySelector('#go-card').onclick = renderCard;
    app.querySelector('#zoom-in').onclick = () => zoomBy(1.6);
    app.querySelector('#zoom-out').onclick = () => zoomBy(1 / 1.6);
    app.querySelector('#zoom-all').onclick = () => { ui.cam = allCamera(); drawMap(); };
    app.querySelector('#zoom-auto').onclick = () => { ui.cam = null; drawMap(); };
    app.querySelector('#gps').onclick = useGps;
    if (!('geolocation' in navigator)) app.querySelector('#gps').hidden = true;
    bindMap();
    resizeObs = new ResizeObserver(() => sizeCanvas());
    resizeObs.observe(app.querySelector('#map'));
    resizeObs.observe(app.querySelector('#sheet'));
    resizeObs.observe(app.querySelector('#top'));
    renderHoleUi();
    sizeCanvas();
    Store.save(round);
  }

  // El mapa ocupa toda la pantalla; el encuadre usa la franja visible entre la cabecera y el panel.
  function sizeCanvas() {
    if (!canvas) return;
    const r = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    canvas.dataset.dpr = dpr;
    const top = app.querySelector('#top');
    const sheet = app.querySelector('#sheet');
    insets = {
      top: top ? top.getBoundingClientRect().bottom - r.top + 8 : 90,
      bottom: sheet ? r.bottom - sheet.getBoundingClientRect().top + 8 : 260,
    };
    const visible = Math.max(120, r.height - insets.top - insets.bottom);
    const old = mapView;
    mapView = { cx: r.width / 2, cy: insets.top + visible / 2, w: r.width, h: r.height };
    // con cámara fija, el mapa no se mueve en pantalla aunque cambie el tamaño del panel
    if (ui.cam && old && old.w === mapView.w && (old.cy !== mapView.cy)) {
      const anchor = { x: old.cx, y: old.cy };
      ui.cam = cameraKeeping(GC.screenToWorld(ui.cam, old, anchor), anchor, ui.cam.zoom, ui.cam.rot);
    }
    drawMap();
  }

  function currentN() {
    return round.holes[round.cur];
  }

  const MAX_ZOOM = 40; // px por metro

  function mapRect() {
    return { w: mapView.w - 120, h: Math.max(100, mapView.h - insets.top - insets.bottom - 44) };
  }

  function allCamera() {
    const h = holeData(currentN());
    return GC.fitCamera(GC.holeCorners(h), GC.holeRotation(h), mapRect(), 10, 0.05, 60);
  }

  function fitCamera() {
    if (ui.cam) return ui.cam;
    const n = currentN();
    const h = holeData(n);
    const all = allCamera();
    const pts = positions(n).concat([h.pin], ui.ghost ? [ui.ghost] : []);
    return GC.fitCamera(pts, all.rot, mapRect(), 30, all.zoom, 14);
  }

  // Cámara con el zoom dado que deja el punto del mundo `w` bajo el punto de pantalla `p`.
  function cameraKeeping(w, p, zoom, rot) {
    const z = GC.clamp(zoom, allCamera().zoom * 0.7, MAX_ZOOM);
    const off = GC.screenToWorld({ x: 0, y: 0, zoom: z, rot }, mapView, p);
    return { x: w.x - off.x, y: w.y - off.y, zoom: z, rot };
  }


  function zoomBy(f, p) {
    const c = fitCamera();
    const at = p || { x: mapView.cx, y: mapView.cy };
    ui.cam = cameraKeeping(GC.screenToWorld(c, mapView, at), at, c.zoom * f, c.rot);
    drawMap();
  }

  const FONT = (w, px) => `${w} ${px}px 'Barlow Condensed', 'Arial Narrow', system-ui, sans-serif`;

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
    const hs = holeScore(n);
    const pos = positions(n);
    const cur = pos[pos.length - 1];

    // recomendación: línea de mira y cruz
    const rec = recommend(n);
    if (rec && !ui.ghost) {
      const a = w2s(rec.aim);
      const f = w2s(rec.from);
      ctx.save();
      ctx.strokeStyle = 'rgba(168,214,114,0.95)';
      ctx.lineWidth = 2;
      ctx.setLineDash([2, 6]);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(f.x, f.y);
      ctx.lineTo(a.x, a.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(a.x, a.y, 11, 0, Math.PI * 2);
      ctx.moveTo(a.x - 17, a.y);
      ctx.lineTo(a.x - 6, a.y);
      ctx.moveTo(a.x + 6, a.y);
      ctx.lineTo(a.x + 17, a.y);
      ctx.moveTo(a.x, a.y - 17);
      ctx.lineTo(a.x, a.y - 6);
      ctx.moveTo(a.x, a.y + 6);
      ctx.lineTo(a.x, a.y + 17);
      ctx.stroke();
      ctx.restore();
    }
    if (ui.target) {
      const t = w2s(ui.target);
      ctx.save();
      ctx.strokeStyle = '#a8d672';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    GC.drawFlag(ctx, pin.x, pin.y, GC.clamp(cam.zoom / 7, 0.55, 1.15), 0, 2.5);

    // trayectorias: arcos con sombra, como el vuelo de la bola
    const now = performance.now();
    for (let i = 1; i < pos.length; i++) {
      const e = hs.entries[i - 1];
      if (e.t === 'p') {
        dropLine(w2s(pos[i - 1]), w2s(pos[i]));
        continue;
      }
      let prog = 1;
      if (ui.anim && ui.anim.i === i - 1) prog = Math.min(1, (now - ui.anim.t0) / 1100);
      if (e.p && e.p.length > 1) tracer(e.p.map(w2s), GC.dist(pos[i - 1], pos[i]), prog, false);
      else arc(w2s(pos[i - 1]), w2s(pos[i]), GC.dist(pos[i - 1], pos[i]), false);
    }
    if (ui.anim) {
      if (now - ui.anim.t0 < 1150) requestAnimationFrame(() => drawMap());
      else ui.anim = null;
    }
    if (ui.drawPath && ui.drawPath.length > 1) tracer(ui.drawPath.map(w2s), 0, 1, true);
    marker(w2s(pos[0]), 'T', 'tee', false);
    hs.entries.forEach((e, i) => {
      if (e.x == null) return;
      marker(w2s(e), String(i + 1), e.t === 'p' ? 'pen' : 'shot', ui.editIndex === i);
    });

    // bola provisional
    if (ui.ghost) {
      const from = ui.moveIndex != null ? pos[ui.moveIndex] : cur;
      const gp = w2s(ui.ghost);
      if (ui.ghostPath && !ui.pendingDrop) tracer(ui.ghostPath.map(w2s), 0, 1, true);
      else if (!ui.pendingDrop) arc(w2s(from), gp, GC.dist(from, ui.ghost), true);
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.beginPath();
      ctx.arc(gp.x, gp.y, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#0f3a24';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(gp.x, gp.y, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      const lie = lieName(detectLie(h, ui.ghost.x, ui.ghost.y));
      const sh = ui.ghostPath ? ` · ${shapeName(shapeOf(ui.ghostPath))}` : '';
      tag(ui.pendingDrop ? `Drop · ${lie}` : `${lie} · ${Math.round(GC.dist(from, ui.ghost))} m${sh}`, gp.x, gp.y - 42, true);
    } else if (hs.entries.length && !hs.done) {
      const c = w2s(cur);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.setLineDash([5, 6]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(pin.x, pin.y);
      ctx.stroke();
      ctx.restore();
    }

    updateWindBadge();
    const auto = app.querySelector('#zoom-auto');
    if (auto) auto.setAttribute('aria-pressed', String(!ui.cam));
    if (!baseCanvas || baseCanvas.width !== canvas.width || baseCanvas.height !== canvas.height) {
      baseCanvas = document.createElement('canvas');
      baseCanvas.width = canvas.width;
      baseCanvas.height = canvas.height;
    }
    baseCanvas.getContext('2d').drawImage(canvas, 0, 0);
    if (ui.loupe) drawLoupe();
  }

  // Tracer: el vuelo dibujado, con brillo como en las retransmisiones; prog < 1 lo anima.
  function tracer(sp, meters, prog, provisional) {
    if (sp.length < 2) return;
    // recorta el trazo a la fracción `prog` de su longitud
    let total = 0;
    for (let i = 1; i < sp.length; i++) total += Math.hypot(sp[i].x - sp[i - 1].x, sp[i].y - sp[i - 1].y);
    const lim = total * prog;
    const part = [sp[0]];
    let acc = 0;
    for (let i = 1; i < sp.length; i++) {
      const d = Math.hypot(sp[i].x - sp[i - 1].x, sp[i].y - sp[i - 1].y);
      if (acc + d >= lim) {
        const t = d ? (lim - acc) / d : 0;
        part.push({ x: sp[i - 1].x + (sp[i].x - sp[i - 1].x) * t, y: sp[i - 1].y + (sp[i].y - sp[i - 1].y) * t });
        break;
      }
      part.push(sp[i]);
      acc += d;
    }
    const path = () => {
      ctx.beginPath();
      part.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    };
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 6;
    ctx.translate(2, 3);
    path();
    ctx.stroke();
    ctx.translate(-2, -3);
    ctx.shadowColor = 'rgba(255,90,30,0.95)';
    ctx.shadowBlur = 14;
    ctx.strokeStyle = provisional ? 'rgba(255,106,43,0.85)' : '#ff6a2b';
    ctx.lineWidth = 5;
    path();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#fff4c2';
    ctx.lineWidth = 1.8;
    path();
    ctx.stroke();
    const end = part[part.length - 1];
    if (prog < 1) {
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(255,200,120,1)';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(end.x, end.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    if (prog >= 1 && meters >= 8 && !provisional) {
      const mid = sp[Math.floor(sp.length / 2)];
      tag(`${Math.round(meters)} m`, mid.x, mid.y - 14, false);
    }
  }

  function dropLine(a, b) {
    if (Math.hypot(b.x - a.x, b.y - a.y) < 2) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  // Arco del golpe (curva de vuelo vista desde arriba) con la distancia en medio.
  function arc(a, b, meters, provisional) {
    if (Math.hypot(b.x - a.x, b.y - a.y) < 2) return;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const bend = Math.min(40, L * 0.12);
    const cx = mx + ((b.y - a.y) / L) * bend;
    const cy = my - ((b.x - a.x) / L) * bend;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(a.x + 2, a.y + 3);
    ctx.quadraticCurveTo(cx + 2, cy + 3, b.x + 2, b.y + 3);
    ctx.stroke();
    ctx.strokeStyle = provisional ? 'rgba(255,255,255,0.95)' : '#ffffff';
    ctx.lineWidth = provisional ? 2.5 : 3;
    if (provisional) ctx.setLineDash([7, 6]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(cx, cy, b.x, b.y);
    ctx.stroke();
    ctx.restore();
    if (meters >= 8 && !provisional) tag(`${Math.round(meters)} m`, (mx + cx) / 2, (my + cy) / 2, false);
  }

  function marker(p, label, kind, selected) {
    ctx.save();
    if (selected) {
      ctx.fillStyle = 'rgba(168,214,114,0.45)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 20, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = kind === 'tee' ? '#f2cf3c' : kind === 'pen' ? '#c8322a' : '#ffffff';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = '#0f3a24';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = kind === 'pen' ? '#ffffff' : '#0f3a24';
    ctx.font = FONT(800, 15);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, p.x, p.y + 1);
    ctx.restore();
  }

  function tag(text, x, y, strong) {
    ctx.save();
    ctx.font = FONT(800, strong ? 17 : 14);
    const w = ctx.measureText(text).width + (strong ? 20 : 12);
    const hgt = strong ? 28 : 21;
    ctx.fillStyle = strong ? 'rgba(15,58,36,0.94)' : 'rgba(15,35,24,0.78)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - w / 2, y - hgt / 2, w, hgt, hgt / 2);
    else ctx.rect(x - w / 2, y - hgt / 2, w, hgt);
    ctx.fill();
    ctx.fillStyle = strong ? '#ffffff' : '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 1);
    ctx.restore();
  }

  // Lupa ×3 sobre el dedo: muestra exactamente dónde quedará la bola.
  function drawLoupe() {
    const dpr = Number(canvas.dataset.dpr) || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(baseCanvas, 0, 0, canvas.width / dpr, canvas.height / dpr);
    const p = ui.loupe;
    const R = 64;
    const Z = 3;
    const lx = GC.clamp(p.x, R + 8, mapView.w - R - 8);
    const ly = p.y - 120 < insets.top + R ? p.y + 120 : p.y - 120;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 16;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(lx, ly, R + 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.arc(lx, ly, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(baseCanvas, (p.x - R / Z) * dpr, (p.y - R / Z) * dpr, ((2 * R) / Z) * dpr, ((2 * R) / Z) * dpr,
      lx - R, ly - R, 2 * R, 2 * R);
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = '#0f3a24';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(lx - 18, ly);
    ctx.lineTo(lx - 5, ly);
    ctx.moveTo(lx + 5, ly);
    ctx.lineTo(lx + 18, ly);
    ctx.moveTo(lx, ly - 18);
    ctx.lineTo(lx, ly - 5);
    ctx.moveTo(lx, ly + 5);
    ctx.lineTo(lx, ly + 18);
    ctx.stroke();
    ctx.restore();
    const n = currentN();
    const h = holeData(n);
    const w = GC.screenToWorld(cam, mapView, p);
    const pos = positions(n);
    const label = ui.pickTarget
      ? `Objetivo · ${Math.round(GC.dist(pos[pos.length - 1], w))} m`
      : `${lieName(detectLie(h, w.x, w.y))} · ${Math.round(GC.dist(pos[pos.length - 1], w))} m · bandera ${Math.round(GC.dist(w, h.pin))}`;
    tag(label, lx, ly + R + 22, true);
  }

  function updateWindBadge() {
    const el = app.querySelector('#wind');
    if (!el) return;
    const c = round.cond;
    if (!c || !c.wind) {
      el.hidden = true;
      return;
    }
    const b = (((c.from + 180) % 360) * Math.PI) / 180;
    const v = { x: Math.sin(b), y: -Math.cos(b) };
    const sx = v.x * Math.cos(cam.rot) - v.y * Math.sin(cam.rot);
    const sy = v.x * Math.sin(cam.rot) + v.y * Math.cos(cam.rot);
    const deg = (Math.atan2(sy, sx) * 180) / Math.PI;
    el.hidden = false;
    el.innerHTML = `<svg width="22" height="22" viewBox="-11 -11 22 22" style="transform:rotate(${deg.toFixed(0)}deg);vertical-align:-6px" aria-hidden="true"><path d="M-8 0H6M2-5l6 5-6 5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg> ${c.wind} km/h`;
    el.setAttribute('aria-label', `Viento ${c.wind} km/h del ${dirName(c.from)}`);
  }

  // Gestos: toque = poner la bola provisional; mantener = lupa y colocarla al soltar;
  // arrastrar la bola provisional = afinarla con lupa; arrastrar el mapa = moverlo; dos dedos = zoom.
  function bindMap() {
    const pts = new Map();
    let g = null;
    let timer = null;
    let raf = 0;
    const local = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const redraw = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        drawMap();
      });
    };
    const two = () => {
      const [a, b] = [...pts.values()];
      return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    };
    const nearGhost = (p) => ui.ghost && Math.hypot(...Object.values(subtract(GC.worldToScreen(cam, mapView, ui.ghost), p))) < 34;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      const p = local(e);
      pts.set(e.pointerId, p);
      clearTimeout(timer);
      const c = fitCamera();
      if (pts.size === 2) {
        ui.loupe = null;
        const t = two();
        g = { type: 'pinch', d0: t.d, zoom0: c.zoom, rot: c.rot, w0: GC.screenToWorld(c, mapView, t.mid) };
        redraw();
      } else if (pts.size === 1) {
        const n = currentN();
        const hs = holeScore(n);
        const posNow = positions(n);
        const ball = posNow[posNow.length - 1];
        const bs = GC.worldToScreen(c, mapView, ball);
        if (ui.inputMode === 'trazo' && !ui.ghost && !ui.pickTarget && !ui.pendingDrop && ui.moveIndex == null && !hs.done
          && Math.hypot(bs.x - p.x, bs.y - p.y) < 56) {
          // trazar el vuelo desde la bola: la cámara queda fija mientras se dibuja
          if (!ui.cam) { ui.camAuto = true; ui.cam = c; }
          g = { type: 'draw' };
          ui.drawPath = [ball, GC.screenToWorld(c, mapView, p)];
          redraw();
          return;
        }
        if (nearGhost(p) && !ui.pickTarget) {
          // afinar la bola provisional: la cámara se congela para que no se mueva bajo el dedo
          ui.cam = c;
          g = { type: 'ghost', start: p };
          ui.loupe = GC.worldToScreen(c, mapView, ui.ghost);
          redraw();
          return;
        }
        g = { type: 'pending', start: p, cam0: c };
        timer = setTimeout(() => {
          if (g && g.type === 'pending') {
            g.type = 'loupe';
            ui.cam = c;
            ui.loupe = g.start;
            redraw();
          }
        }, 300);
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId) || !g) return;
      const p = local(e);
      pts.set(e.pointerId, p);
      if (g.type === 'pinch' && pts.size === 2) {
        const t = two();
        ui.cam = cameraKeeping(g.w0, t.mid, g.zoom0 * (t.d / g.d0), g.rot);
        redraw();
      } else if (g.type === 'pending' && Math.hypot(p.x - g.start.x, p.y - g.start.y) > 10) {
        clearTimeout(timer);
        g.type = 'pan';
      }
      if (g.type === 'pan') {
        ui.cam = cameraKeeping(GC.screenToWorld(g.cam0, mapView, g.start), p, g.cam0.zoom, g.cam0.rot);
        redraw();
      } else if (g.type === 'loupe') {
        ui.loupe = p;
        redraw();
      } else if (g.type === 'ghost') {
        ui.ghost = roundPt(GC.screenToWorld(cam, mapView, p));
        if (ui.ghostPath) ui.ghostPath = ui.ghostPath.slice(0, -1).concat([ui.ghost]);
        ui.loupe = p;
        redraw();
      } else if (g.type === 'draw') {
        const last = GC.worldToScreen(cam, mapView, ui.drawPath[ui.drawPath.length - 1]);
        if (Math.hypot(last.x - p.x, last.y - p.y) > 4) {
          ui.drawPath.push(GC.screenToWorld(cam, mapView, p));
          redraw();
        }
      }
    });
    const end = (e) => {
      if (!pts.has(e.pointerId)) return;
      const p = local(e);
      pts.delete(e.pointerId);
      clearTimeout(timer);
      if (!g) return;
      const type = g.type;
      if (type === 'pinch' && pts.size === 1) {
        const [rest] = [...pts.values()];
        g = { type: 'pan', start: rest, cam0: fitCamera() };
        return;
      }
      if (pts.size) return;
      g = null;
      ui.loupe = null;
      if (type === 'draw') {
        const raw = ui.drawPath || [];
        ui.drawPath = null;
        if (raw.length > 2 && GC.dist(raw[0], raw[raw.length - 1]) > 3) {
          const path = simplify(raw, 0.8).slice(0, 30).map(roundPt);
          ui.ghost = path[path.length - 1];
          ui.ghostPath = path;
        } else if (ui.camAuto) {
          ui.cam = null;
          ui.camAuto = false;
        }
        renderHoleUi();
        drawMap();
        return;
      }
      if (e.type === 'pointerup' && (type === 'pending' || type === 'loupe')) {
        tapMap(p, type === 'loupe');
        return;
      }
      if (type === 'ghost') renderHoleUi();
      drawMap();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, local(e));
    }, { passive: false });
  }

  const subtract = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  const roundPt = (w) => ({ x: Math.round(w.x * 10) / 10, y: Math.round(w.y * 10) / 10 });

  function tapMap(p, precise) {
    const n = currentN();
    const hs = holeScore(n);
    const w = GC.screenToWorld(cam, mapView, p);
    if (ui.pickTarget) {
      ui.target = w;
      ui.pickTarget = false;
      if (!ui.clubManual) ui.selectedClub = suggestClub(n);
      drawMap();
      renderHoleUi();
      return;
    }
    // un toque sobre un golpe ya apuntado lo selecciona para editarlo
    if (!precise && !ui.ghost && ui.moveIndex == null && !ui.pendingDrop) {
      for (let i = hs.entries.length - 1; i >= 0; i--) {
        const e = hs.entries[i];
        if (e.x == null) continue;
        const s = GC.worldToScreen(cam, mapView, e);
        if (Math.hypot(s.x - p.x, s.y - p.y) < 20) {
          ui.editIndex = ui.editIndex === i ? null : i;
          ui.more = ui.editIndex != null;
          drawMap();
          renderHoleUi();
          return;
        }
      }
    }
    if (hs.done) {
      toast('Hoyo terminado. Pulsa «Reabrir» para seguir apuntando.');
      return;
    }
    if (!ui.ghost && !ui.cam) {
      ui.camAuto = true;
      ui.cam = cam;
    }
    ui.ghost = roundPt(w);
    ui.ghostPath = null;
    drawMap();
    renderHoleUi();
  }

  function clearGhost() {
    ui.ghost = null;
    ui.ghostPath = null;
    if (ui.camAuto) ui.cam = null;
    ui.camAuto = false;
  }

  // Confirma la bola provisional: golpe nuevo, drop de una penalización o golpe movido.
  function commitGhost() {
    const n = currentN();
    const before = holeStats(n).strokes;
    const hs = holeScore(n);
    const h = holeData(n);
    if (!ui.ghost) return;
    const { x, y } = ui.ghost;
    if (ui.moveIndex != null) {
      const e = hs.entries[ui.moveIndex];
      e.x = x;
      e.y = y;
      if (e.t === 's') e.l = detectLie(h, x, y);
      if (ui.ghostPath) {
        e.p = ui.ghostPath;
        e.f = shapeOf(ui.ghostPath);
      } else {
        delete e.p;
        delete e.f;
      }
      ui.moveIndex = null;
    } else if (ui.pendingDrop) {
      const e = hs.entries[hs.entries.length - 1];
      e.x = x;
      e.y = y;
      ui.pendingDrop = false;
    } else {
      if (!ui.selectedClub) {
        toast('Elige el palo del golpe.');
        return;
      }
      const l = detectLie(h, x, y);
      const entry = { t: 's', x, y, c: ui.selectedClub, l };
      if (ui.ghostPath) {
        entry.p = ui.ghostPath;
        entry.f = shapeOf(ui.ghostPath);
        ui.anim = { i: hs.entries.length, t0: performance.now() };
      }
      hs.entries.push(entry);
      ui.editIndex = null;
      ui.target = null;
      ui.clubManual = false;
      if (l === 'water' || l === 'ob') toast(l === 'water' ? 'Bola al agua: añade la penalización y marca el drop.' : 'Fuera de límites: añade la penalización.');
      if (l === 'green') ui.putting = true;
    }
    clearGhost();
    ui.selectedClub = suggestClub(n);
    afterChange();
    notifyPar(n, before);
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

  // Tras apuntar: «putt para…» al llegar al green y aviso al quedarse sin opción de par (o empeorar).
  function notifyPar(n, before) {
    const st = holeStats(n);
    const hs = holeScore(n);
    if (hs.done || st.strokes <= before) return;
    const next = st.strokes + 1 - st.par;
    const prev = before + 1 - st.par;
    const last = hs.entries[hs.entries.length - 1];
    if (last && last.t === 's' && last.l === 'green' && hs.putts === 0) {
      scoreBanner(parKind(next), `Putt para ${parName(next)}`, `${Math.round(st.toPin)} m a bandera`, true);
    } else if (next >= 1 && next > prev) {
      scoreBanner(parKind(next), next === 1 ? 'Sin opción de par' : `Vas +${next - 1}`, `Emboca para ${parName(next)}`, true);
    }
  }

  function renderHoleUi() {
    const n = currentN();
    const raw = byNumber[n];
    const h = holeData(n);
    const hs = holeScore(n);
    const st = holeStats(n);
    const idx = round.cur;
    const teeOk = raw.tees && raw.tees[round.tees];
    const t = totals();
    app.querySelector('#hole-id').innerHTML = `
      <div class="hv-num"><small>Hoyo</small>${n}</div>
      <div class="hv-meta">Par ${raw.par} · ${h.length} m<span>${teeOk ? (TEES.find((x) => x[0] === round.tees) || [0, ''])[1] : 'Amarillas'} · ${idx + 1} de ${round.holes.length}</span></div>`;
    app.querySelector('#total').innerHTML = `<b class="${t.diff < 0 ? 'k-birdie' : t.diff > 0 ? 'k-double' : ''}">${t.played ? signed(t.diff) : 'E'}</b><span>${golpes(t.strokes)}</span>`;
    app.querySelector('#prev').disabled = idx === 0;

    const putting = !hs.done && (ui.putting || st.lie === 'green' || hs.putts > 0);
    const rec = hs.done || putting ? null : recommend(n);
    const term = (v, label) => (Math.abs(v) < 0.5 ? '' : ` ${v > 0 ? '+' : '−'}${Math.round(Math.abs(v))} ${label}`);

    let recHtml = '';
    if (rec && !ui.ghost) {
      const m = rec.model;
      const parts = [];
      if (Math.abs(m.drift) >= 0.5) parts.push(`viento ${Math.round(Math.abs(m.drift))} m`);
      if (Math.abs(rec.curve) >= 0.5) parts.push(`tu ${rec.cfg.shape} ${Math.round(Math.abs(rec.curve))} m`);
      recHtml = `<div class="rec">
        <div class="club"><small>Recomendado</small>${rec.club.name}</div>
        <div class="plays">Juega <b class="num">${Math.round(m.total)} m</b> · ${rec.partial ? 'a media distancia' : `tu ${rec.cfg.dist} m${rec.alt ? ' · o ' + rec.alt : ''}`}</div>
        <div class="calc">${Math.round(m.D)} m${term(m.elev, 'desnivel')}${term(m.wind, m.head > 0 ? 'viento en contra' : 'viento a favor')}${term(m.temp, 'temperatura')}</div>
        ${Math.abs(rec.aimRight) >= 1 ? `<div class="aim">Apunta ${Math.round(Math.abs(rec.aimRight))} m a la ${rec.aimRight < 0 ? 'izquierda' : 'derecha'} (${parts.join(', ')})</div>` : '<div class="aim">Apunta a la cruz verde del mapa</div>'}
        ${rec.warn ? `<div class="warn">Cuidado: ${rec.warn}.</div>` : ''}
        ${ui.selectedClub === rec.club.id ? '' : '<button class="btn small use" id="use-rec">Usar ' + rec.club.name + '</button>'}
      </div>`;
    }

    const clubsHtml = hs.done || putting || ui.pendingDrop || ui.moveIndex != null ? '' : `<div class="clubs" id="clubs" role="group" aria-label="Palo del golpe">${CLUBS
      .filter((x) => bagClub(x.id).on || x.id === ui.selectedClub)
      .map((x) => `<button data-k="${x.id}" aria-pressed="${ui.selectedClub === x.id}" class="${rec && rec.club.id === x.id ? 'rec-mark' : ''}"><b>${short(x)}</b><span>${bagClub(x.id).dist} m</span></button>`).join('')}</div>`;

    // zona de acción según el estado
    let action;
    const pos = positions(n);
    if (hs.done) {
      action = `<div class="action"><button class="btn" id="reopen">Reabrir</button>
        <button class="btn primary" id="next2"><span>${idx < round.holes.length - 1 ? 'Siguiente hoyo' : 'Ver tarjeta'}<small>${GC.scoreName(st.strokes, st.par)} · ${golpes(st.strokes)}</small></span></button></div>`;
    } else if (ui.ghost) {
      const from = ui.moveIndex != null ? pos[ui.moveIndex] : pos[pos.length - 1];
      const d = Math.round(GC.dist(from, ui.ghost));
      const what = ui.moveIndex != null ? `Mover golpe ${ui.moveIndex + 1}` : ui.pendingDrop ? 'Confirmar drop' : `Apuntar golpe ${hs.entries.length + 1}`;
      const shape = ui.ghostPath ? ` · ${shapeName(shapeOf(ui.ghostPath)).toLowerCase()}` : '';
      const sub = ui.pendingDrop ? lieName(detectLie(h, ui.ghost.x, ui.ghost.y)) : `${ui.moveIndex != null ? '' : clubName(ui.selectedClub) + ' · '}${d} m · ${lieName(detectLie(h, ui.ghost.x, ui.ghost.y))}${shape}`;
      action = `<div class="action"><button class="btn cancel" id="cancel" aria-label="Quitar la bola provisional">✕</button>
        <button class="btn primary" id="commit"><span>${what}<small>${sub}</small></span></button></div>`;
    } else if (putting) {
      action = `<div class="putt-row"><span class="lbl">Putts</span>
        <span class="stepper"><button id="p-minus" aria-label="Quitar putt">−</button><span class="val">${hs.putts}</span><button id="p-plus" aria-label="Añadir putt">+</button></span>
        <span class="grow"></span></div>
        <div class="action"><button class="btn primary" id="finish" ${st.strokes ? '' : 'disabled'}><span>Embocada · terminar<small>${golpes(st.strokes)} en el hoyo</small></span></button></div>`;
    } else {
      const trace = ui.inputMode === 'trazo' && !ui.pickTarget && !ui.pendingDrop && ui.moveIndex == null;
      const msg = ui.pickTarget ? 'Toca el punto al que quieres jugar'
        : ui.pendingDrop ? 'Toca dónde dropas la bola'
        : ui.moveIndex != null ? `Toca la nueva posición del golpe ${ui.moveIndex + 1}`
        : trace ? 'Dibuja el vuelo desde la bola' : 'Toca el mapa donde quedó la bola';
      const tip = trace ? 'Arrastra el dedo desde la bola hasta donde cayó' : 'Mantén pulsado para afinar con lupa';
      const modeSeg = ui.pickTarget || ui.pendingDrop || ui.moveIndex != null ? '' : `<div class="mode" role="group" aria-label="Cómo apuntar">
          <button data-mode="toque" aria-pressed="${ui.inputMode === 'toque'}">Tocar</button><button data-mode="trazo" aria-pressed="${ui.inputMode === 'trazo'}">Trazar</button></div>`;
      action = `<div class="action"><div class="hintbox"><span class="tap${trace ? ' trace' : ''}" aria-hidden="true"></span><span>${msg}<br><span class="muted" style="font-size:13px">${tip}</span></span></div>${modeSeg}</div>`;
    }

    const tools = hs.done ? '' : `<div class="tools">
      ${putting ? '<button class="btn small" id="back-shots">Otro golpe</button>' : '<button class="btn small" id="to-putts">Putts / green</button>'}
      <button class="btn small" id="pen">+1 penalización</button>
      <button class="btn small" id="undo" ${hs.entries.length || hs.putts ? '' : 'disabled'}>Deshacer</button>
      ${putting ? '' : `<button class="btn small" id="finish2" ${st.strokes ? '' : 'disabled'}>Terminar hoyo</button>`}
      <button class="btn small ghost" id="more" aria-expanded="${ui.more}">${ui.more ? 'Menos ▴' : 'Más ▾'}</button></div>`;

    // detalles: condiciones, objetivo y lista de golpes
    let details = '';
    if (ui.more || hs.done) {
      const c = round.cond || (round.cond = { temp: bag.tref, wind: 0, from: 270 });
      const list = hs.entries.map((e, i) => {
        const d = e.t === 's' ? Math.round(GC.dist(pos[i], pos[i + 1])) : null;
        return `<button class="shot-chip${e.t === 'p' ? ' pen' : ''}" data-i="${i}" aria-pressed="${ui.editIndex === i}"><span class="n">${i + 1}</span>
          ${e.t === 'p' ? '<b>Penalización</b>' : `<b>${esc(clubName(e.c))}</b><span class="muted">${lieName(e.l)}</span>${e.f ? `<span class="shape">${shapeName(e.f)}</span>` : ''}<span class="d">${d} m</span>`}</button>`;
      }).join('');
      let editor = '';
      if (ui.editIndex != null && hs.entries[ui.editIndex]) {
        const e = hs.entries[ui.editIndex];
        editor = `<div class="editor">
          ${e.t === 's' ? `<div class="seg" id="e-club">${CLUBS.map((x) => `<button data-k="${x.id}" aria-pressed="${e.c === x.id}">${x.name}</button>`).join('')}</div>
          <div class="seg" id="e-lie">${LIES.map(([k, l]) => `<button data-k="${k}" aria-pressed="${e.l === k}">${l}</button>`).join('')}</div>` : '<span class="muted">Golpe de penalización.</span>'}
          <div class="row"><button class="btn small" id="e-move">${e.t === 's' ? 'Mover en el mapa' : 'Marcar el drop'}</button>
          <button class="btn small danger" id="e-del">Borrar</button><span class="grow"></span><button class="btn small" id="e-close">Listo</button></div></div>`;
      }
      details = `<div class="details">
        <div class="row"><span class="eyebrow">Condiciones</span><span class="grow"></span>
          ${hs.done ? '' : `<button class="btn small" id="target-btn">${ui.pickTarget ? 'Toca el objetivo…' : ui.target ? 'Objetivo: punto ✕' : 'Objetivo: bandera'}</button>`}</div>
        <div class="cond-grid">${condControls(c, 'h-')}</div>
        ${list ? `<span class="eyebrow">Golpes del hoyo</span><div class="shots" id="shots">${list}</div>` : ''}
        ${editor}
      </div>`;
    }

    const sheet = app.querySelector('#sheet');
    const compact = !!ui.ghost && !ui.more;
    sheet.classList.toggle('compact', compact);
    if (compact) {
      sheet.innerHTML = `<div class="compact-head"><b>${ui.ghostPath ? 'Ajusta el trazo' : 'Ajusta la bola'}</b><span>Arrástrala para afinar · ${Math.round(GC.dist(ui.ghost, h.pin))} m a bandera</span></div>
        ${clubsHtml}
        ${action}`;
    } else sheet.innerHTML = `<button class="grab" id="grab" aria-label="${ui.more ? 'Plegar' : 'Desplegar'} el panel"></button>
      <div class="sh-head">
        <div><span class="eyebrow">${hs.done ? `Hoyo terminado · ${parName(st.strokes - st.par)}` : `${putting ? 'Putt' : 'Golpe'} para ${st.strokes === 0 ? 'hoyo en uno' : parName(st.strokes + 1 - st.par)}`}</span>
          <div class="big num k-${parKind(hs.done ? st.strokes - st.par : st.strokes + 1 - st.par)}">${hs.done ? st.strokes : st.strokes + 1}</div>
          <span class="from">${hs.done ? `${st.putts} putts` : `desde <b>${lieName(st.lie)}</b>`}</span></div>
        <div class="right"><span class="eyebrow">A bandera</span><div class="big num">${Math.round(st.toPin)}<small>m</small></div>
          <span class="from">${rec || hs.done || !h.elev ? '' : `juega ${Math.round(GC.playsLike(h, pos[pos.length - 1], h.pin))} m por desnivel`}</span></div>
      </div>
      ${recHtml}
      ${clubsHtml}
      ${action}
      ${tools}
      ${details}`;

    // eventos
    const $s = (q) => sheet.querySelector(q);
    sheet.querySelectorAll('#clubs button').forEach((b) => (b.onclick = () => {
      ui.selectedClub = b.dataset.k;
      ui.clubManual = true;
      renderHoleUi();
    }));
    const sel = $s('#clubs button[aria-pressed="true"]');
    if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'center' });
    const toggleMore = () => { ui.more = !ui.more; renderHoleUi(); };
    if ($s('#grab')) $s('#grab').onclick = toggleMore;
    sheet.querySelectorAll('.mode button').forEach((b) => (b.onclick = () => {
      ui.inputMode = b.dataset.mode;
      try { localStorage.setItem('sotoverde-modo', ui.inputMode); } catch (e) { /* preferencia solo de esta sesión */ }
      renderHoleUi();
    }));
    if ($s('#more')) $s('#more').onclick = toggleMore;
    if ($s('#use-rec')) $s('#use-rec').onclick = () => { ui.selectedClub = rec.club.id; ui.clubManual = false; renderHoleUi(); };
    if ($s('#cancel')) $s('#cancel').onclick = () => { clearGhost(); afterChange(); };
    if ($s('#commit')) $s('#commit').onclick = commitGhost;
    if ($s('#p-minus')) $s('#p-minus').onclick = () => { hs.putts = Math.max(0, hs.putts - 1); afterChange(); };
    if ($s('#p-plus')) $s('#p-plus').onclick = () => {
      const before = st.strokes;
      hs.putts += 1;
      afterChange();
      notifyPar(n, before);
    };
    if ($s('#to-putts')) $s('#to-putts').onclick = () => { ui.putting = true; ui.ghost = null; afterChange(); };
    if ($s('#back-shots')) $s('#back-shots').onclick = () => { ui.putting = false; hs.putts = 0; afterChange(); };
    if ($s('#pen')) $s('#pen').onclick = () => {
      const before = st.strokes;
      hs.entries.push({ t: 'p' });
      ui.pendingDrop = true;
      ui.putting = false;
      ui.ghost = null;
      afterChange();
      notifyPar(n, before);
    };
    if ($s('#undo')) $s('#undo').onclick = () => {
      if (hs.putts > 0 && putting) hs.putts -= 1;
      else hs.entries.pop();
      Object.assign(ui, { editIndex: null, pendingDrop: false, moveIndex: null, ghost: null });
      ui.putting = hs.putts > 0;
      ui.selectedClub = suggestClub(n);
      afterChange();
    };
    const finish = () => {
      hs.done = true;
      Object.assign(ui, { pendingDrop: false, ghost: null, putting: false });
      if (round.holes.every((m) => round.scores[m] && round.scores[m].done)) {
        round.finished = true;
        Store.save(round);
        renderCard();
        const t = totals();
        scoreBanner(t.diff < 0 ? 'birdie' : t.diff === 0 ? 'par' : t.diff <= 3 ? 'bogey' : 'double', 'Vuelta terminada', `${golpes(t.strokes)} · ${signed(t.diff)} al par`);
        return;
      }
      Store.save(round);
      const d = st.strokes - st.par;
      scoreBanner(st.strokes === 1 ? 'eagle' : parKind(d),
        st.strokes === 1 ? '¡Hoyo en uno!' : d < 0 ? `¡${parName(d)}!` : parName(d),
        `Hoyo ${n} · ${golpes(st.strokes)} · ${signed(d)}`);
      const nextIdx = round.holes.findIndex((m, i) => i > round.cur && !(round.scores[m] && round.scores[m].done));
      openHole(nextIdx >= 0 ? nextIdx : Math.min(round.cur + 1, round.holes.length - 1));
    };
    if ($s('#finish')) $s('#finish').onclick = finish;
    if ($s('#finish2')) $s('#finish2').onclick = finish;
    if ($s('#reopen')) $s('#reopen').onclick = () => {
      hs.done = false;
      round.finished = false;
      ui.selectedClub = suggestClub(n);
      afterChange();
    };
    if ($s('#next2')) $s('#next2').onclick = () => (idx < round.holes.length - 1 ? openHole(idx + 1) : renderCard());
    const tb = $s('#target-btn');
    if (tb) tb.onclick = () => {
      if (ui.target || ui.pickTarget) {
        ui.target = null;
        ui.pickTarget = false;
        if (!ui.clubManual) ui.selectedClub = suggestClub(n);
        drawMap();
      } else {
        ui.pickTarget = true;
        ui.ghost = null;
      }
      renderHoleUi();
    };
    if (ui.more || hs.done) {
      const c = round.cond;
      bindCond(sheet, c, 'h-', () => {
        if (!ui.clubManual) ui.selectedClub = suggestClub(n);
        Store.save(round);
        drawMap();
        renderHoleUi();
      });
      sheet.querySelectorAll('#shots .shot-chip').forEach((b) => (b.onclick = () => {
        const i = Number(b.dataset.i);
        ui.editIndex = ui.editIndex === i ? null : i;
        if (hs.entries[i] && hs.entries[i].p) ui.anim = { i, t0: performance.now() }; // repite el tracer
        drawMap();
        renderHoleUi();
      }));
      if (ui.editIndex != null && hs.entries[ui.editIndex]) {
        const e = hs.entries[ui.editIndex];
        sheet.querySelectorAll('#e-club button').forEach((b) => (b.onclick = () => { e.c = b.dataset.k; afterChange(); }));
        sheet.querySelectorAll('#e-lie button').forEach((b) => (b.onclick = () => { e.l = b.dataset.k; afterChange(); }));
        $s('#e-move').onclick = () => {
          if (hs.done) hs.done = false;
          ui.moveIndex = ui.editIndex;
          ui.ghost = e.x != null ? { x: e.x, y: e.y } : null;
          ui.more = false;
          afterChange();
        };
        $s('#e-del').onclick = () => {
          hs.entries.splice(ui.editIndex, 1);
          ui.editIndex = null;
          afterChange();
        };
        $s('#e-close').onclick = () => { ui.editIndex = null; drawMap(); renderHoleUi(); };
      }
    }
  }

  // Nombre corto del palo para los botones (DR, M3, H7, PW…).
  function short(c) {
    return { dr: 'Driver', m3: 'Mad. 3', m5: 'Mad. 5', hi: 'Híbrido' }[c.id] || c.id.toUpperCase();
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
        ui.ghost = roundPt(w);
        drawMap();
        renderHoleUi();
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
      <div class="page-head"><div><span class="eyebrow">Tus palos y tus distancias</span><h1 class="h-display">Mi bolsa</h1>
        <div class="sub" id="bag-count">${count}/14 palos contando el putter</div></div></div>
      <div class="row" style="margin:14px 0"><button class="btn" id="home">‹ Vueltas</button></div>
      <div class="panel stack">
        <div class="field"><label>Temperatura a la que das esas distancias</label>
          <span class="stepper"><button id="tref-minus" aria-label="Menos grados">−</button><span class="val">${bag.tref}°</span><button id="tref-plus" aria-label="Más grados">+</button></span></div>
        <div class="field"><label>Juegas con la mano</label>
          <div class="seg" id="hand">${[['diestro', 'Diestro'], ['zurdo', 'Zurdo']].map(([k, l]) => `<button data-k="${k}" aria-pressed="${(bag.hand || 'diestro') === k}">${l}</button>`).join('')}</div></div>
        <p class="note">Distancia habitual: dónde suele quedar la bola con un golpe normal, sin viento y a esa temperatura.
          Con el vuelo, la altura y el fallo, el recomendador corrige el punto de mira y te avisa si tu fallo acaba en un obstáculo.</p>
      </div>
      <div class="bag-list">${CLUBS.map((c) => clubCard(c, avg[c.id])).join('')}</div>
      <p class="foot"><a href="jugar.html">Modo juego</a></p>`;
    app.querySelector('#home').onclick = renderHome;
    app.querySelector('#tref-minus').onclick = () => { bag.tref = Math.max(-5, bag.tref - 1); Store.saveBag(bag); renderBag(); };
    app.querySelector('#tref-plus').onclick = () => { bag.tref = Math.min(40, bag.tref + 1); Store.saveBag(bag); renderBag(); };
    app.querySelectorAll('#hand button').forEach((b) => (b.onclick = () => { bag.hand = b.dataset.k; Store.saveBag(bag); renderBag(); }));
    CLUBS.forEach((c) => bindClubCard(c, avg[c.id]));
  }

  function clubCard(c, measured) {
    const cfg = bagClub(c.id);
    const traced = clubShapes(rounds);
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
        <div class="field"><label>Vuelo habitual</label>${seg('shape', SHAPES)}
          ${traced[c.id] ? `<div class="row" style="margin-top:8px"><span class="muted measured">trazado: ${shapeName(traced[c.id].top).toLowerCase()} en ${traced[c.id].cnt} de ${traced[c.id].total}</span>${cfg.shape === traced[c.id].top ? '' : `<button class="btn small" data-shape="${traced[c.id].top}">Usar</button>`}</div>` : ''}</div>
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
    const useShape = el.querySelector('[data-shape]');
    if (useShape) useShape.onclick = () => { cfg.shape = useShape.dataset.shape; redraw(); };
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

  // Tarjetas importadas: se editan con el total de golpes de cada hoyo (no hay golpes en el mapa).
  let cardEdit = false;
  function setHoleTotal(n, d) {
    const cur = strokesOf(round.scores[n]);
    const next = cur ? cur + d : d > 0 ? parOf(round, n) : 0;
    if (next <= 0) delete round.scores[n];
    else round.scores[n] = { entries: [], putts: 0, done: true, total: Math.min(next, 15) };
    round.edited = true;
    Store.save(round);
    const y = window.scrollY;
    renderCard();
    window.scrollTo(0, y);
  }

  function renderCard() {
    view = 'card';
    teardownMap();
    app.className = 'wrap';
    const card = isImported(round);
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
    const subRow = (label, s) => `<tr class="sub"><td>${label}</td><td>${s.par}</td><td>${s.strokes || '–'}</td>${card ? '' : `<td>${s.putts || '–'}</td><td></td><td></td>`}</tr>`;
    round.holes.forEach((n, i) => {
      const st = holeStats(n);
      const played = st.started;
      if (played) {
        section.par += st.par;
        section.strokes += st.strokes;
        section.putts += st.putts || 0;
        if (st.fairway != null) { fwTot++; if (st.fairway) fwHit++; }
        if (st.done && st.gir != null) { girTot++; if (st.gir) girHit++; puttHoles++; }
        pens += st.pens;
      } else {
        section.par += st.par;
      }
      const tint = st.done ? (st.strokes < st.par ? ' t-under' : st.strokes > st.par ? ' t-over' : '') : '';
      rows.push(`<tr class="link${tint}" data-i="${i}"><td>${n}</td><td>${st.par}</td>
        <td>${card && cardEdit
          ? `<span class="stepper sm"><button data-h="${n}" data-d="-1" aria-label="Quitar un golpe en el hoyo ${n}">−</button><span class="val">${played ? mark(st.strokes, st.par) : '–'}</span><button data-h="${n}" data-d="1" aria-label="${played ? 'Añadir un golpe' : 'Poner resultado'} en el hoyo ${n}">+</button></span>`
          : played ? mark(st.strokes, st.par) + (st.done ? '' : '<span class="muted">…</span>') : '–'}</td>
        ${card ? '' : `<td>${played && st.putts != null ? st.putts : '–'}</td>
        <td>${st.fairway == null ? '<span class="muted">·</span>' : st.fairway ? '<span class="yes">✓</span>' : '<span class="no">✗</span>'}</td>
        <td>${!st.done || st.gir == null ? '<span class="muted">·</span>' : st.gir ? '<span class="yes">✓</span>' : '<span class="no">✗</span>'}</td>`}</tr>`);
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
    const shapes = clubShapes([round]);
    const clubRows = CLUBS.filter((c) => avg[c.id]).map((c) => {
      const d = avg[c.id];
      const m = d.reduce((a, b) => a + b, 0) / d.length;
      const sh = shapes[c.id];
      return `<tr><td>${c.name}</td><td>${d.length}</td><td>${Math.round(m)} m</td><td>${Math.round(Math.max(...d))} m</td><td>${sh ? `${shapeName(sh.top)} <span class="muted">${sh.cnt}/${sh.total}</span>` : '<span class="muted">·</span>'}</td></tr>`;
    }).join('');
    const tee = TEES.find((x) => x[0] === round.tees);
    const pct = (a, b) => (b ? Math.round((100 * a) / b) + ' %' : '–');
    const official = round.official || {};
    let better = 0;
    let worse = 0;
    for (const n of round.holes) {
      const st = holeStats(n);
      if (!st.started) continue;
      if (st.strokes < st.par) better++;
      if (st.strokes >= st.par + 2) worse++;
    }
    const missing = round.holes.filter((n) => !holeStats(n).started).length;
    const stats = card ? `
        <div class="stat"><div class="k">Stableford</div><div class="v num">${official.stableford ?? '–'}</div><div class="s">puntos oficiales</div></div>
        <div class="stat"><div class="k">Hándicap de juego</div><div class="v num">${official.playingHcp ?? '–'}</div><div class="s">${official.index != null ? `índice ${String(official.index).replace('.', ',')}` : 'en esta prueba'}</div></div>
        <div class="stat"><div class="k">Birdies o mejor</div><div class="v num">${better}</div><div class="s">hoyos bajo par</div></div>
        <div class="stat"><div class="k">Dobles o peor</div><div class="v num">${worse}</div><div class="s">hoyos +2 o más</div></div>`
      : `
        <div class="stat"><div class="k">Putts</div><div class="v num">${sum.putts || 0}</div><div class="s">${puttHoles ? (sum.putts / puttHoles).toFixed(1).replace('.', ',') + ' por hoyo' : '–'}</div></div>
        <div class="stat"><div class="k">Calles cogidas</div><div class="v num">${pct(fwHit, fwTot)}</div><div class="s">${fwHit}/${fwTot} (pares 4 y 5)</div></div>
        <div class="stat"><div class="k">Greens en regulación</div><div class="v num">${pct(girHit, girTot)}</div><div class="s">${girHit}/${girTot} hoyos</div></div>
        <div class="stat"><div class="k">Penalizaciones</div><div class="v num">${pens}</div><div class="s">golpes</div></div>`;

    app.innerHTML = `
      <div class="page-head">
        <div><span class="eyebrow">Tarjeta · Golf Sotoverde</span><h1 class="h-display">${esc(fmtDate(round.date))}</h1>
          <div class="sub">${card ? `${esc(round.event || 'Competición')} · ` : ''}Barras ${tee ? tee[1].toLowerCase() : round.tees} · ${card ? `tarjeta oficial${official.gross ? ` · bruto ${official.gross}` : ''}` : round.finished ? 'vuelta terminada' : 'vuelta en curso'}</div></div>
        <div class="big-score num${t.diff < 0 ? ' under' : ''}">${t.played ? t.strokes : '–'}<small>${t.played ? signed(t.diff) : ''}</small></div>
      </div>
      <div class="row" style="margin:14px 0">
        <button class="btn" id="home">‹ Vueltas</button>
        ${card ? `<button class="btn primary" id="edit-card">${cardEdit ? 'Hecho' : 'Editar golpes'}</button>` : `<button class="btn primary" id="resume">${round.finished ? 'Editar golpes' : 'Seguir apuntando'}</button>`}
      </div>
      <div class="table-scroll"><table class="score">
        <thead><tr><th>Hoyo</th><th>Par</th><th>Golpes</th>${card ? '' : '<th>Putts</th><th>Calle</th><th>Green reg.</th>'}</tr></thead>
        <tbody>${rows.join('')}</tbody></table></div>
      <p class="legend"><span><span class="mark birdie">3</span> birdie</span><span><span class="mark eagle">2</span> eagle o mejor</span>
        <span><span class="mark bogey">5</span> bogey</span><span><span class="mark double">6</span> doble o peor</span></p>
      ${card ? `<p class="legend">${cardEdit ? 'Toca − o + en cada hoyo; con «−» por debajo de 1 el hoyo queda sin resultado. Se guarda al momento.' : `Importada de la tarjeta oficial${round.edited ? ' y editada por ti' : ''}: solo golpes por hoyo, sin putts, calles ni greens.`}${missing ? ` ${missing} hoyo${missing === 1 ? '' : 's'} sin resultado (–).` : ''}${round.pars ? ' Prueba de pitch & putt: todos los hoyos par 3.' : ''}</p>` : ''}

      <h2 class="section-title">Estadísticas</h2>
      <div class="stats">${stats}
      </div>

      ${card ? '' : '<h2 class="section-title">Distancias por palo</h2>'}
      ${clubRows ? `<div class="table-scroll"><table class="score"><thead><tr><th>Palo</th><th>Golpes</th><th>Media</th><th>Máx.</th><th>Vuelo trazado</th></tr></thead><tbody>${clubRows}</tbody></table></div>
        <p class="legend">Distancia en línea recta de donde salió a donde quedó la bola (con rodada); no cuenta bolas al agua o fuera.</p>`
        : card ? '' : '<p class="empty">Apunta golpes en el mapa para ver tus distancias por palo.</p>'}
      <p class="foot"><a href="jugar.html">Modo juego</a></p>`;
    app.querySelector('#home').onclick = renderHome;
    if (card) {
      app.querySelector('#edit-card').onclick = () => {
        cardEdit = !cardEdit;
        renderCard();
      };
      app.querySelectorAll('.stepper.sm button').forEach((b) => (b.onclick = (e) => {
        e.stopPropagation();
        setHoleTotal(Number(b.dataset.h), Number(b.dataset.d));
      }));
      return;
    }
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

  window.__vuelta = {
    get round() { return round; }, get store() { return Store; }, toUtm30, tapMap: (p) => tapMap(p),
    teeScreen: () => { const pos = positions(currentN()); return GC.worldToScreen(cam, mapView, pos[pos.length - 1]); },
    pinScreen: () => GC.worldToScreen(cam, mapView, holeData(currentN()).pin),
  };
})();
