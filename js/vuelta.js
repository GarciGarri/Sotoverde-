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
  const clone = (o) => JSON.parse(JSON.stringify(o));

  /*
   * Guardado. Con cuenta: en la base de datos del artefacto, con una copia local de lo que aún no se ha
   * podido guardar (sin cobertura en el campo) que se reintenta al volver la conexión. Sin cuenta: en este
   * navegador. La base de datos no tiene transacciones (gana la última escritura), así que cada hoyo lleva
   * su marca de tiempo (hs.ts) y antes de escribir se lee lo que hay y se fusiona hoyo a hoyo: lo apuntado
   * en otro dispositivo no se pisa. Los comentarios se unen.
   */
  function mergeRounds(remote, local) {
    const out = clone(local);
    // datos que solo tiene la versión de la cuenta (p. ej. añadidos después a una tarjeta importada)
    for (const k of Object.keys(remote)) if (!(k in out)) out[k] = clone(remote[k]);
    if (remote.official && local.official) out.official = { ...clone(remote.official), ...clone(local.official) };
    const cleared = { ...(remote.cleared || {}), ...(local.cleared || {}) };
    for (const [n, t] of Object.entries(remote.cleared || {})) cleared[n] = Math.max(t, (local.cleared || {})[n] || 0);
    const holes = new Set(Object.keys(remote.scores || {}).concat(Object.keys(local.scores || {})));
    out.scores = {};
    for (const n of holes) {
      const a = (remote.scores || {})[n];
      const b = (local.scores || {})[n];
      let pick = !a ? b : !b ? a : (a.ts || 0) > (b.ts || 0) ? a : b;
      if (pick && cleared[n] && cleared[n] > (pick.ts || 0)) pick = null;
      if (pick) out.scores[n] = clone(pick);
    }
    if (Object.keys(cleared).length) out.cleared = cleared;
    const seen = new Set();
    out.chat = (remote.chat || []).concat(local.chat || []).filter((m) => {
      const k = `${m.role}|${m.at}|${m.content}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).sort((x, y) => String(x.at).localeCompare(String(y.at))).slice(-60);
    if (!out.chat.length) delete out.chat;
    out.updatedAt = [remote.updatedAt, local.updatedAt].sort().pop();
    return out;
  }

  // Cambia el contenido de una vuelta sin cambiar el objeto (la vista lo tiene referenciado).
  function adopt(target, src) {
    target.scores = src.scores;
    if (src.chat) target.chat = src.chat;
    if (src.cleared) target.cleared = src.cleared;
    for (const k of ['finished', 'cur', 'cond', 'edited', 'updatedAt']) if (k in src) target[k] = src[k];
  }

  const Store = {
    mode: 'local',
    db: null,
    uid: null,
    readOnly: false,
    timers: {},
    writing: {},
    dirty: {},
    sigs: {},
    pending: {},
    retryTimer: null,

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
      if (this.mode === 'db') {
        this.loadPending();
        window.addEventListener('online', () => this.retry());
        document.addEventListener('visibilitychange', () => { if (!document.hidden) this.retry(); });
      }
    },
    col() {
      return this.db.collection('data/users/' + this.uid);
    },
    pendingKey() {
      return LOCAL_KEY + '-pendiente-' + this.uid;
    },
    loadPending() {
      try {
        this.pending = JSON.parse(localStorage.getItem(this.pendingKey())) || {};
      } catch (e) {
        this.pending = {};
      }
    },
    keepPending() {
      try {
        localStorage.setItem(this.pendingKey(), JSON.stringify(this.pending));
      } catch (e) {
        /* sin almacenamiento local: solo queda en memoria */
      }
    },
    // Huella de cada hoyo tal como está guardado, para saber luego qué hoyos cambian.
    remember(round) {
      const sig = {};
      for (const [n, hs] of Object.entries(round.scores || {})) sig[n] = JSON.stringify({ ...hs, ts: 0 });
      this.sigs[round.id] = sig;
    },
    stamp(round) {
      const now = Date.now();
      const prev = this.sigs[round.id] || {};
      for (const [n, hs] of Object.entries(round.scores || {})) {
        const sig = JSON.stringify({ ...hs, ts: 0 });
        if (prev[n] !== sig) hs.ts = now;
      }
      this.remember(round);
    },
    async list() {
      if (this.mode === 'db') {
        let list = [];
        try {
          const snap = await this.col().get();
          list = snap.docs.filter((d) => d.exists).map((d) => clone(d.data())).filter(isRound);
        } catch (e) {
          toast('No se pudieron cargar tus vueltas. Vuelve a abrir la página en un momento.');
        }
        // lo que quedó sin guardar (sin conexión) se fusiona y se vuelve a enviar
        for (const [id, local] of Object.entries(this.pending)) {
          if (!isRound(local)) continue;
          const i = list.findIndex((r) => r.id === id);
          if (i >= 0) list[i] = mergeRounds(list[i], local);
          else list.push(local);
        }
        list.forEach((r) => this.remember(r));
        Object.keys(this.pending).forEach((id) => {
          const r = list.find((x) => x.id === id);
          if (r) this.flush(r);
        });
        this.watch();
        return list;
      }
      try {
        return (JSON.parse(localStorage.getItem(LOCAL_KEY)) || []).filter(isRound);
      } catch (e) {
        return [];
      }
    },
    // Cambios hechos en otro dispositivo, en directo.
    watch() {
      if (this.unwatch) return;
      this.unwatch = this.col().onSnapshot((snap) => {
        let changed = false;
        for (const ch of snap.docChanges()) {
          const id = ch.doc.id;
          if (ch.doc.metadata.hasPendingWrites || this.writing[id] || this.pending[id] || this.timers[id]) continue;
          if (ch.type === 'removed') {
            if (rounds.some((r) => r.id === id) && round && round.id !== id) {
              rounds = rounds.filter((r) => r.id !== id);
              changed = true;
            }
            continue;
          }
          const data = ch.doc.data();
          if (!isRound(data)) continue;
          const mine = rounds.find((r) => r.id === id);
          if (!mine) {
            rounds.push(clone(data));
            this.remember(data);
            changed = true;
          } else if (data.updatedAt !== mine.updatedAt) {
            adopt(mine, mergeRounds(clone(data), mine));
            this.remember(mine);
            changed = true;
          }
        }
        if (changed) refreshAfterSync();
      }, () => { this.unwatch = null; });
    },
    // Guarda con una pausa corta y nunca dos escrituras a la vez sobre la misma vuelta.
    save(round) {
      round.updatedAt = new Date().toISOString();
      if (this.mode === 'db') {
        this.stamp(round);
        this.pending[round.id] = clone(round);
        this.keepPending();
      }
      clearTimeout(this.timers[round.id]);
      this.timers[round.id] = setTimeout(() => {
        delete this.timers[round.id];
        this.flush(round);
      }, 600);
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
        const ref = this.col().doc(round.id);
        const snap = await ref.get();
        let body = clone(round);
        if (snap.exists && isRound(snap.data())) {
          body = mergeRounds(clone(snap.data()), body);
          // lo que llegó de otro dispositivo pasa también a la vista
          if (JSON.stringify(body.scores) !== JSON.stringify(round.scores) || (body.chat || []).length !== (round.chat || []).length) {
            adopt(round, clone(body));
            refreshAfterSync();
          }
        }
        await ref.set(body);
        this.remember(round);
        if (!this.dirty[round.id] && !this.timers[round.id]) {
          delete this.pending[round.id];
          this.keepPending();
        }
      } catch (e) {
        if (e && e.code === 'invalid_argument') {
          this.readOnly = true;
          toast('No tienes permiso para guardar vueltas en esta página.');
        } else if (e && e.code === 'quota_exceeded') {
          toast('El espacio para vueltas está lleno: borra alguna vuelta antigua.');
        } else {
          toast('Sin conexión: la vuelta queda guardada en este móvil y se enviará al volver la cobertura.');
          this.scheduleRetry();
        }
      } finally {
        this.writing[round.id] = false;
        if (this.dirty[round.id]) {
          this.dirty[round.id] = false;
          this.flush(round);
        }
      }
    },
    scheduleRetry() {
      if (this.retryTimer) return;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.retry();
      }, 20000);
    },
    retry() {
      for (const id of Object.keys(this.pending)) {
        const r = rounds.find((x) => x.id === id);
        if (r && !this.writing[id] && !this.timers[id]) this.flush(r);
      }
    },
    pendingCount() {
      return Object.keys(this.pending).length;
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
      if (this.pending[id]) {
        delete this.pending[id];
        this.keepPending();
      }
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

  // Tras recibir cambios de otro dispositivo: repintar lo que se esté viendo (sin tocar una bola a medio poner).
  function refreshAfterSync() {
    if (view === 'home') renderList();
    else if (view === 'card' && !cardEdit) {
      const y = window.scrollY;
      renderCard();
      window.scrollTo(0, y);
    } else if (view === 'hole' && !ui.ghost && canvas) {
      renderHoleUi();
      drawMap();
    }
  }

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

  // Ejecuta fn con otra vuelta como activa (positions, holeStats… leen `round`) y la restaura pase lo que pase.
  function withRound(r, fn) {
    const saved = round;
    round = r;
    try {
      return fn();
    } finally {
      round = saved;
    }
  }

  const prepared = {};
  function holeData(n) {
    const key = n + ':' + round.tees;
    if (!prepared[key]) prepared[key] = GC.prepareHole(byNumber[n], round.tees);
    return prepared[key];
  }

  // Vueltas importadas de tarjetas oficiales: traen el total de golpes por hoyo (hs.total). Si se apuntan los
  // golpes en el mapa, el total de la tarjeta vale hasta que el hoyo se termina; desde ahí mandan los golpes.
  const isImported = (r) => !!(r && r.source === 'tarjeta');
  const liveStrokes = (hs) => (hs ? hs.entries.length + hs.putts : 0);
  const usesTotal = (hs) => !!hs && hs.total != null && !(hs.done && liveStrokes(hs));
  function strokesOf(hs) {
    if (!hs) return 0;
    return usesTotal(hs) ? hs.total : liveStrokes(hs);
  }
  const scoreDone = (hs) => !!hs && (hs.done || hs.total != null);
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
    const strokes = liveStrokes(hs);
    const par = parOf(round, n);
    const card = usesTotal(hs);
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
      cardStrokes: strokesOf(hs), cardDone: scoreDone(hs), detailed: strokes > 0,
      toPin: GC.dist(cur, h.pin), lie: lastLie(n), started: strokesOf(hs) > 0,
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
      if (scoreDone(hs)) {
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
        const pos = withRound(r, () => positions(n));
        hs.entries.forEach((e, i) => {
          if (e.t !== 's' || !e.c || e.l === 'water' || e.l === 'ob') return;
          const d = GC.dist(pos[i], pos[i + 1]);
          if (d < 5) return;
          (acc[e.c] = acc[e.c] || []).push(d);
        });
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

      ${GC.Tour ? `<h2 class="section-title">Conoce el campo <small>Recorrido 3D hoyo a hoyo</small></h2>
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

      <h2 class="section-title">Tus vueltas <small id="count"></small><button class="btn small" id="progress">Mi progreso</button></h2>
      <div class="rounds" id="list"><p class="empty">Cargando tus vueltas…</p></div>

      <h2 class="section-title">Mi bolsa <button class="btn small" id="bag">Editar</button></h2>
      <div class="bag-summary">${CLUBS.filter((c) => bagClub(c.id).on).map((c) => `<span><b>${bagClub(c.id).dist}</b>${c.name}</span>`).join('') || '<span>Sin palos</span>'}</div>

      <p class="foot"><a href="jugar.html">Modo juego (estilo Golf Clash)</a>
        <span>Mapas: ortofoto y MDT © IGN · contorno © OpenStreetMap</span></p>`;
    app.querySelectorAll('#f-tees button').forEach((b) => (b.onclick = () => { form.tees = b.dataset.k; renderHome(); }));
    app.querySelectorAll('#f-route button').forEach((b) => (b.onclick = () => { form.route = b.dataset.k; renderHome(); }));
    bindCond(app, form, 'f-', renderHome);
    app.querySelector('#bag').onclick = renderBag;
    app.querySelector('#progress').onclick = () => renderProgress();
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
      const r3d = t.played && GC.Tour
        ? `<button class="r3d" data-act="3d" aria-label="Ver el resumen 3D de la vuelta del ${esc(fmtDate(r.date))}"><span class="play3d" aria-hidden="true"></span>3D</button>` : '';
      return `<div class="round-row${r3d ? ' has-3d' : ''}" data-id="${esc(r.id)}">${r3d}
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
          if (act === '3d') {
            open3D(replayData(r), r);
            return;
          }
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
    round.cur = idx;
    // hoyo de una tarjeta importada sin golpes en el mapa: se abre para apuntarlos (cuenta el total mientras)
    const hs0 = round.scores[round.holes[idx]];
    if (hs0 && hs0.total != null && !liveStrokes(hs0)) hs0.done = false;
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
      <div class="hv-meta">Par ${st.par} · ${h.length} m<span>${teeOk ? (TEES.find((x) => x[0] === round.tees) || [0, ''])[1] : 'Amarillas'} · ${idx + 1} de ${round.holes.length}${hs.total != null ? ` · tarjeta ${hs.total}` : ''}</span></div>`;
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
        ${GC.Tour ? '<button class="btn" id="hole3d">Ver en 3D</button>' : ''}
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
      if (hs.total != null) {
        const k = liveStrokes(hs);
        if (k !== hs.total) {
          toast(`La tarjeta decía ${golpes(hs.total)}; el hoyo queda con ${k}.`);
          hs.total = k;
          round.edited = true;
        }
      }
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
      round.finished = isImported(round);
      ui.selectedClub = suggestClub(n);
      afterChange();
    };
    if ($s('#hole3d')) $s('#hole3d').onclick = () => open3D(replayData(round, n), round);
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
    if (liveStrokes(round.scores[n])) return; // con golpes en el mapa se edita en el mapa
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

  /*
   * Stableford de una vuelta importada. Sin cambios, el oficial. Si se han editado golpes, se recalcula con
   * los golpes de hándicap que recibió en cada hoyo (official.rec, sacados de los puntos oficiales por hoyo;
   * si faltan, repartiendo el hándicap de juego por el hándicap de cada hoyo).
   */
  function stablefordOf(r) {
    const o = r.official || {};
    if (o.stableford == null) return { points: null, note: 'sin dato oficial' };
    if (!r.edited || o.playingHcp == null) return { points: o.stableford, note: 'puntos oficiales' };
    const SI = GC.STROKE_INDEX || {};
    const h = o.playingHcp;
    let pts = 0;
    for (const n of r.holes) {
      const k = strokesOf(r.scores[n]);
      if (!k) continue;
      const rec = o.rec && o.rec[n] != null ? o.rec[n] : Math.floor(h / 18) + ((SI[n] || 18) <= h % 18 ? 1 : 0);
      pts += Math.max(0, 2 + parOf(r, n) + rec - k);
    }
    return { points: pts, note: pts === o.stableford ? 'como el oficial' : `con tus cambios · oficial ${o.stableford}` };
  }

  function renderCard() {
    view = 'card';
    teardownMap();
    window.scrollTo(0, 0);
    app.className = 'wrap';
    const card = isImported(round);
    // columnas de putts, calle y green solo si hay golpes apuntados en el mapa
    const cols = !card || round.holes.some((n) => liveStrokes(round.scores[n]));
    const has3d = !!(GC.Tour);
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
    const subRow = (label, s) => `<tr class="sub"><td>${label}</td><td>${s.par}</td><td>${s.strokes || '–'}</td>${cols ? `<td>${s.putts || '–'}</td><td></td><td></td>` : ''}</tr>`;
    round.holes.forEach((n, i) => {
      const st = holeStats(n);
      const played = st.started;
      if (played) {
        section.par += st.par;
        section.strokes += st.cardStrokes;
        section.putts += st.putts || 0;
        if (st.fairway != null) { fwTot++; if (st.fairway) fwHit++; }
        if (st.done && st.gir != null) { girTot++; if (st.gir) girHit++; puttHoles++; }
        pens += st.pens;
      } else {
        section.par += st.par;
      }
      const ks = st.cardStrokes;
      const tint = st.cardDone ? (ks < st.par ? ' t-under' : ks > st.par ? ' t-over' : '') : '';
      rows.push(`<tr class="link${tint}" data-i="${i}"><td>${n}${played && has3d ? `<button class="mini3d" data-n="${n}" aria-label="Ver el hoyo ${n} en 3D">3D</button>` : ''}</td><td>${st.par}</td>
        <td>${card && cardEdit && !st.detailed
          ? `<span class="stepper sm"><button data-h="${n}" data-d="-1" aria-label="Quitar un golpe en el hoyo ${n}">−</button><span class="val">${played ? mark(ks, st.par) : '–'}</span><button data-h="${n}" data-d="1" aria-label="${played ? 'Añadir un golpe' : 'Poner resultado'} en el hoyo ${n}">+</button></span>`
          : played ? mark(ks, st.par) + (st.cardDone ? '' : '<span class="muted">…</span>') + (card && cardEdit ? ' <span class="muted">en el mapa</span>' : '') : '–'}</td>
        ${!cols ? '' : `<td>${played && st.putts != null ? st.putts : '–'}</td>
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
      if (st.cardStrokes < st.par) better++;
      if (st.cardStrokes >= st.par + 2) worse++;
    }
    const missing = round.holes.filter((n) => !holeStats(n).started).length;
    const stb = stablefordOf(round);
    const stats = card ? `
        <div class="stat"><div class="k">Stableford</div><div class="v num">${stb.points ?? '–'}</div><div class="s">${stb.note}</div></div>
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
        ${has3d && t.played ? '<button class="btn" id="replay3d"><span class="play3d" aria-hidden="true"></span>Resumen 3D</button>' : ''}
        ${card ? `<button class="btn primary" id="edit-card">${cardEdit ? 'Hecho' : 'Editar golpes'}</button>` : `<button class="btn primary" id="resume">${round.finished ? 'Editar golpes' : 'Seguir apuntando'}</button>`}
      </div>
      <div class="table-scroll"><table class="score">
        <thead><tr><th>Hoyo</th><th>Par</th><th>Golpes</th>${cols ? '<th>Putts</th><th>Calle</th><th>Green reg.</th>' : ''}</tr></thead>
        <tbody>${rows.join('')}</tbody></table></div>
      <p class="legend"><span><span class="mark birdie">3</span> birdie</span><span><span class="mark eagle">2</span> eagle o mejor</span>
        <span><span class="mark bogey">5</span> bogey</span><span><span class="mark double">6</span> doble o peor</span></p>
      ${card ? `<p class="legend">${cardEdit ? 'Toca − o + en cada hoyo; con «−» por debajo de 1 el hoyo queda sin resultado. Se guarda al momento.' : `Importada de la tarjeta oficial${round.edited ? ' y editada por ti' : ''}. Toca un hoyo para apuntar en el mapa dónde acabó cada golpe y con qué palo.`}${missing ? ` ${missing} hoyo${missing === 1 ? '' : 's'} sin resultado (–).` : ''}${round.pars ? ' Prueba de pitch & putt: todos los hoyos par 3.' : ''}</p>` : ''}

      <h2 class="section-title">Estadísticas</h2>
      <div class="stats">${stats}
      </div>

      ${card && !clubRows ? '' : '<h2 class="section-title">Distancias por palo</h2>'}
      ${clubRows ? `<div class="table-scroll"><table class="score"><thead><tr><th>Palo</th><th>Golpes</th><th>Media</th><th>Máx.</th><th>Vuelo trazado</th></tr></thead><tbody>${clubRows}</tbody></table></div>
        <p class="legend">Distancia en línea recta de donde salió a donde quedó la bola (con rodada); no cuenta bolas al agua o fuera.</p>`
        : card ? '' : '<p class="empty">Apunta golpes en el mapa para ver tus distancias por palo.</p>'}
      <p class="foot"><a href="jugar.html">Modo juego</a></p>`;
    app.querySelector('#home').onclick = renderHome;
    if (app.querySelector('#replay3d')) app.querySelector('#replay3d').onclick = () => open3D(replayData(round), round);
    app.querySelectorAll('.mini3d').forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      open3D(replayData(round, Number(b.dataset.n)), round);
    }));
    if (card) {
      app.querySelector('#edit-card').onclick = () => {
        cardEdit = !cardEdit;
        renderCard();
      };
      app.querySelectorAll('.stepper.sm button').forEach((b) => (b.onclick = (e) => {
        e.stopPropagation();
        setHoleTotal(Number(b.dataset.h), Number(b.dataset.d));
      }));
      if (cardEdit) return;
      app.querySelectorAll('tr.link').forEach((tr) => (tr.onclick = () => openHole(Number(tr.dataset.i))));
      return;
    }
    app.querySelector('#resume').onclick = () => {
      const i = round.holes.findIndex((m) => !(round.scores[m] && round.scores[m].done));
      openHole(i >= 0 ? i : 0);
    };
    app.querySelectorAll('tr.link').forEach((tr) => (tr.onclick = () => openHole(Number(tr.dataset.i))));
  }

  // ---------- mi progreso ----------

  const SI_OF = (n) => (GC.STROKE_INDEX || {})[n] || 18;
  const recFor = (h, n) => (h == null ? 0 : Math.floor(h / 18) + (SI_OF(n) <= h % 18 ? 1 : 0));

  // Estadísticas de todas las vueltas. Fuera quedan las pruebas de pitch & putt (otro par) y las de equipos.
  function progressData(list = rounds) {
    const usable = list.filter((r) => !r.pars && !(r.official && r.official.team));
    const byDate = usable.slice().sort((a, b) => a.date.localeCompare(b.date));
    const hcpOf = (r) => (r.official && r.official.playingHcp != null ? r.official.playingHcp : null);
    const lastHcp = byDate.map(hcpOf).filter((x) => x != null).pop() ?? null;
    const trend = [];
    const holes = {};
    const tally = (arr) => arr.reduce((t, d) => (t[d < 0 ? 'under' : d === 0 ? 'par' : d === 1 ? 'bogey' : 'double']++, t), { under: 0, par: 0, bogey: 0, double: 0 });
    const perRound = [];
    for (const r of byDate) {
      const hcp = hcpOf(r) ?? lastHcp;
      const ds = [];
      let all = r.holes.length === 18;
      for (const n of r.holes) {
        const hs = r.scores[n];
        const k = strokesOf(hs);
        if (!k || !scoreDone(hs)) {
          all = false;
          continue;
        }
        const par = parOf(r, n);
        const rec = r.official && r.official.rec && r.official.rec[n] != null ? r.official.rec[n] : recFor(hcp, n);
        (holes[n] = holes[n] || []).push({ d: k - par, ex: k - par - rec, k, id: r.id });
        ds.push(k - par);
      }
      if (ds.length) perRound.push({ r, ds });
      if (all && ds.length === 18) {
        const t = totals(r);
        trend.push({ id: r.id, date: r.date, event: r.event || '', strokes: t.strokes, diff: t.diff, stb: r.official ? stablefordOf(r).points : null });
      }
    }
    const recent = perRound.slice(-8).flatMap((x) => x.ds);
    const before = perRound.slice(0, -8).flatMap((x) => x.ds);
    const holeRows = COURSE.map((raw) => {
      const xs = holes[raw.number] || [];
      const avg = (f) => (xs.length ? xs.reduce((a, x) => a + f(x), 0) / xs.length : null);
      return { n: raw.number, par: raw.par, si: SI_OF(raw.number), count: xs.length, toPar: avg((x) => x.d), excess: avg((x) => x.ex), t: tally(xs.map((x) => x.d)) };
    });
    return { trend, holeRows, recent: tally(recent), before: tally(before), nRecent: recent.length, nBefore: before.length, lastHcp, usable: usable.length, excluded: list.length - usable.length };
  }

  // Golpes con palo apuntados en el mapa: distancia y desvío lateral respecto a la línea a bandera (+ = derecha).
  function clubDispersion(list = rounds) {
    const out = {};
    for (const r of list) {
      for (const n of r.holes) {
        const hs = r.scores && r.scores[n];
        if (!hs || !hs.entries.length || !byNumber[n]) continue;
        const pos = withRound(r, () => positions(n));
        const pin = withRound(r, () => holeData(n).pin);
        hs.entries.forEach((e, i) => {
          if (e.t !== 's' || !e.c || e.l === 'water' || e.l === 'ob') return;
          const A = pos[i];
          const B = pos[i + 1];
          const d = GC.dist(A, B);
          if (d < 8) return;
          const L = GC.dist(A, pin) || 1;
          const u = { x: (pin.x - A.x) / L, y: (pin.y - A.y) / L };
          const vx = B.x - A.x;
          const vy = B.y - A.y;
          (out[e.c] = out[e.c] || []).push({ d, along: vx * u.x + vy * u.y, lat: u.x * vy - u.y * vx, n, date: r.date });
        });
      }
    }
    return out;
  }

  const quant = (xs, q) => {
    const a = xs.slice().sort((x, y) => x - y);
    const i = (a.length - 1) * q;
    return a[Math.floor(i)] + (a[Math.ceil(i)] - a[Math.floor(i)]) * (i - Math.floor(i));
  };
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
  const sgn = (v, dec = 1) => {
    const r = Number(v.toFixed(dec));
    return (r > 0 ? '+' : r < 0 ? '−' : '±') + Math.abs(r).toFixed(dec).replace('.', ',');
  };

  let progressHole = 9;
  let progressClub = null;

  function renderProgress() {
    view = 'progress';
    teardownMap();
    window.scrollTo(0, 0);
    app.className = 'wrap';
    const P = progressData();
    const disp = clubDispersion();
    const T = P.trend;
    const last6 = T.slice(-6);
    const prev6 = T.slice(-12, -6);
    const mean = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
    const m6 = mean(last6.map((x) => x.diff));
    const p6 = mean(prev6.map((x) => x.diff));
    const best = T.slice().sort((a, b) => a.diff - b.diff)[0];
    const ranked = P.holeRows.filter((h) => h.count >= 3 && h.excess != null).sort((a, b) => b.excess - a.excess);
    const worst = ranked.slice(0, 3);
    const easy = ranked.slice(-3).reverse();
    const share = (t, n) => `${pct(t.under + t.par, n)} %`;
    const clubsWith = CLUBS.filter((c) => disp[c.id] && disp[c.id].length);
    if (!progressClub || !disp[progressClub]) progressClub = clubsWith.length ? clubsWith.slice().sort((a, b) => disp[b.id].length - disp[a.id].length)[0].id : null;

    app.innerHTML = `
      <div class="page-head"><div><span class="eyebrow">Golf Sotoverde · todas tus vueltas</span><h1 class="h-display">Mi progreso</h1>
        <div class="sub">${P.usable} vueltas analizadas${P.excluded ? ` · ${P.excluded} fuera (pitch & putt o por equipos)` : ''}</div></div></div>
      <div class="row" style="margin:14px 0"><button class="btn" id="home">‹ Vueltas</button></div>

      <div class="stats">
        <div class="stat"><div class="k">Últimas 6 vueltas</div><div class="v num">${m6 == null ? '–' : sgn(m6)}</div><div class="s">${p6 == null ? 'al par, de media' : `${m6 < p6 ? '▼' : m6 > p6 ? '▲' : '='} ${sgn(m6 - p6)} frente a las 6 anteriores`}</div></div>
        <div class="stat"><div class="k">Mejor vuelta</div><div class="v num">${best ? best.strokes : '–'}</div><div class="s">${best ? `${signed(best.diff)} · ${esc(fmtDate(best.date))}` : 'sin vueltas completas'}</div></div>
        <div class="stat"><div class="k">Par o mejor</div><div class="v num">${share(P.recent, P.nRecent)}</div><div class="s">de los hoyos en las 8 últimas${P.nBefore ? ` · antes ${share(P.before, P.nBefore)}` : ''}</div></div>
        <div class="stat"><div class="k">Dobles o peor</div><div class="v num">${pct(P.recent.double, P.nRecent)} %</div><div class="s">en las 8 últimas${P.nBefore ? ` · antes ${pct(P.before.double, P.nBefore)} %` : ''}</div></div>
      </div>

      <h2 class="section-title">Resultado por vuelta <small>18 hoyos completos, al par</small></h2>
      <div class="panel viz" id="trend"></div>

      <h2 class="section-title">Hoyo a hoyo <small>golpes de más o de menos frente a lo que te da tu hándicap</small></h2>
      ${worst.length ? `<p class="viz-note">Te cuestan más de lo esperado: <b>${worst.map((h) => `el ${h.n}`).join(', ')}</b>. Donde mejor juegas para tu hándicap: <b>${easy.map((h) => `el ${h.n}`).join(', ')}</b>.</p>` : ''}
      <div class="panel viz" id="holes"></div>

      <h2 class="section-title">Mapa de tus golpes</h2>
      <div class="seg hole-pick" id="hole-pick">${COURSE.map((h) => `<button data-n="${h.number}" aria-pressed="${h.number === progressHole}">${h.number}</button>`).join('')}</div>
      <div class="shotmap-wrap"><canvas id="shotmap" aria-label="Golpes apuntados en el hoyo ${progressHole}"></canvas><div class="shotmap-info" id="shotmap-info"></div></div>

      <h2 class="section-title">Dispersión por palo <small>golpes apuntados en el mapa</small></h2>
      ${clubsWith.length ? `<div class="seg" id="club-pick">${clubsWith.map((c) => `<button data-c="${c.id}" aria-pressed="${c.id === progressClub}">${c.name} <small>${disp[c.id].length}</small></button>`).join('')}</div>
        <div class="panel viz disp" id="disp"></div>`
        : '<p class="empty">Cuando apuntes golpes en el mapa (o los añadas a tus tarjetas importadas) verás aquí dónde caen tus golpes con cada palo.</p>'}
      <div class="viz-tip" id="viz-tip" role="status" hidden></div>`;
    app.querySelector('#home').onclick = renderHome;
    drawTrend(app.querySelector('#trend'), T);
    drawHoles(app.querySelector('#holes'), P.holeRows);
    app.querySelectorAll('#hole-pick button').forEach((b) => (b.onclick = () => {
      progressHole = Number(b.dataset.n);
      app.querySelectorAll('#hole-pick button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      drawShotMap(P);
    }));
    drawShotMap(P);
    if (clubsWith.length) {
      app.querySelectorAll('#club-pick button').forEach((b) => (b.onclick = () => {
        progressClub = b.dataset.c;
        app.querySelectorAll('#club-pick button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        drawDispersion(app.querySelector('#disp'), disp[progressClub], progressClub);
      }));
      drawDispersion(app.querySelector('#disp'), disp[progressClub], progressClub);
    }
    bindVizTips(app);
  }

  // Tooltip compartido: cualquier elemento con data-tip (en hover y en foco).
  function bindVizTips(root) {
    const tip = root.querySelector('#viz-tip');
    const show = (el, x, y) => {
      tip.textContent = '';
      el.dataset.tip.split('\n').forEach((line, i) => {
        const d = document.createElement(i ? 'span' : 'b');
        d.textContent = line;
        tip.append(d);
      });
      tip.hidden = false;
      const r = tip.getBoundingClientRect();
      tip.style.left = `${Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2))}px`;
      tip.style.top = `${Math.max(8, y - r.height - 12)}px`;
    };
    root.addEventListener('pointermove', (e) => {
      const el = e.target.closest('[data-tip]');
      if (el) show(el, e.clientX, e.clientY);
      else tip.hidden = true;
    });
    root.addEventListener('pointerleave', () => (tip.hidden = true));
    root.addEventListener('focusin', (e) => {
      const el = e.target.closest('[data-tip]');
      if (!el) return;
      const r = el.getBoundingClientRect();
      show(el, r.left + r.width / 2, r.top);
    });
    root.addEventListener('focusout', () => (tip.hidden = true));
  }

  const NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs, parent) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (parent) parent.append(el);
    return el;
  }

  // Evolución: cada vuelta (puntos grises) y la media de las 5 últimas (línea azul). Un solo eje: golpes al par.
  function drawTrend(box, T) {
    if (T.length < 2) {
      box.innerHTML = '<p class="empty">Hacen falta al menos dos vueltas de 18 hoyos completas.</p>';
      return;
    }
    const W = Math.max(300, box.clientWidth - 32);
    const H = 240;
    const pad = { l: 34, r: 14, t: 14, b: 26 };
    const ys = T.map((p) => p.diff);
    const lo = Math.floor(Math.min(0, ...ys) / 4) * 4;
    const hi = Math.ceil(Math.max(...ys) / 4) * 4 || 4;
    const t0 = new Date(T[0].date).getTime();
    const t1 = new Date(T[T.length - 1].date).getTime();
    const X = (p) => pad.l + ((new Date(p.date).getTime() - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r);
    const Y = (v) => pad.t + ((hi - v) / (hi - lo)) * (H - pad.t - pad.b);
    box.innerHTML = `<div class="legend"><span><i class="k-dot"></i>Cada vuelta</span><span><i class="k-line"></i>Media de las 5 últimas</span></div>`;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'Resultado al par de cada vuelta y media móvil' }, box);
    for (let v = lo; v <= hi; v += 4) {
      svgEl('line', { x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v), class: v === 0 ? 'axis0' : 'grid' }, svg);
      svgEl('text', { x: pad.l - 6, y: Y(v) + 4, class: 'tick', 'text-anchor': 'end' }, svg).textContent = v === 0 ? 'Par' : (v > 0 ? '+' : '') + v;
    }
    const years = [...new Set(T.map((p) => new Date(p.date).getFullYear()))];
    for (const yr of years) {
      const x = X({ date: `${yr}-01-01` });
      if (x >= pad.l && x <= W - pad.r) svgEl('text', { x, y: H - 6, class: 'tick', 'text-anchor': 'middle' }, svg).textContent = yr;
    }
    const avg = T.map((p, i) => {
      const w = T.slice(Math.max(0, i - 4), i + 1);
      return { ...p, m: w.reduce((a, x) => a + x.diff, 0) / w.length };
    });
    svgEl('path', { d: avg.map((p, i) => `${i ? 'L' : 'M'}${X(p).toFixed(1)},${Y(p.m).toFixed(1)}`).join(''), class: 'line' }, svg);
    T.forEach((p, i) => {
      const g = svgEl('g', { tabindex: 0, 'data-tip': `${signed(p.diff)} · ${p.strokes} golpes\n${fmtDate(p.date)}${p.event ? ' · ' + p.event : ''}\nMedia de 5: ${sgn(avg[i].m)}` }, svg);
      svgEl('circle', { cx: X(p), cy: Y(p.diff), r: 12, class: 'hit' }, g);
      svgEl('circle', { cx: X(p), cy: Y(p.diff), r: 4.5, class: 'dot' }, g);
    });
    const lastP = avg[avg.length - 1];
    svgEl('circle', { cx: X(lastP), cy: Y(lastP.m), r: 5, class: 'end' }, svg);
    svgEl('text', { x: X(lastP) - 8, y: Y(lastP.m) - 10, class: 'lab', 'text-anchor': 'end' }, svg).textContent = sgn(lastP.m);
    const tbl = document.createElement('details');
    tbl.innerHTML = `<summary>Ver como tabla</summary><div class="table-scroll"><table class="score"><thead><tr><th>Fecha</th><th>Prueba</th><th>Golpes</th><th>Al par</th></tr></thead><tbody>${
      T.slice().reverse().map((p) => `<tr><td>${esc(fmtDate(p.date))}</td><td>${esc(p.event)}</td><td>${p.strokes}</td><td>${signed(p.diff)}</td></tr>`).join('')}</tbody></table></div>`;
    box.append(tbl);
  }

  // Hoyo a hoyo: barras divergentes (izquierda azul = mejor de lo que da tu hándicap, derecha roja = peor).
  function drawHoles(box, rows) {
    const data = rows.filter((r) => r.count);
    if (!data.length) {
      box.innerHTML = '<p class="empty">Aún no hay hoyos terminados.</p>';
      return;
    }
    const W = Math.max(300, box.clientWidth - 32);
    const rowH = 24;
    const pad = { l: 64, r: 52, t: 6, b: 6 };
    const H = pad.t + pad.b + rowH * rows.length;
    const max = Math.max(0.5, ...data.map((r) => Math.abs(r.excess)));
    const mid = pad.l + (W - pad.l - pad.r) / 2;
    const S = (v) => (v / max) * ((W - pad.l - pad.r) / 2 - 40); // deja sitio a la etiqueta en la punta
    box.innerHTML = '<div class="legend"><span><i class="k-bar under"></i>Mejor de lo esperado</span><span><i class="k-bar over"></i>Peor de lo esperado</span></div>';
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'Golpes por encima o por debajo de lo esperado en cada hoyo' }, box);
    svgEl('line', { x1: mid, x2: mid, y1: pad.t, y2: H - pad.b, class: 'axis0' }, svg);
    rows.forEach((r, i) => {
      const y = pad.t + i * rowH;
      svgEl('text', { x: 4, y: y + rowH / 2 + 4, class: 'tick' }, svg).textContent = `${r.n} · par ${r.par}`;
      if (!r.count) return;
      const w = Math.abs(S(r.excess));
      const x = r.excess < 0 ? mid - w : mid;
      const g = svgEl('g', {
        tabindex: 0,
        'data-tip': `${sgn(r.excess)} golpes frente a tu hándicap\nHoyo ${r.n} · par ${r.par} · hándicap ${r.si}\nMedia ${sgn(r.toPar)} al par · ${r.count} veces · par o mejor ${pct(r.t.under + r.t.par, r.count)} %`,
      }, svg);
      svgEl('rect', { x: pad.l, y, width: W - pad.l - pad.r, height: rowH, class: 'hit' }, g);
      const bh = Math.min(16, rowH - 6);
      if (w > 0.5) {
        const rad = Math.min(4, w / 2);
        const yy = y + (rowH - bh) / 2;
        // extremo redondeado solo en la punta, recto en la línea de cero
        const d = r.excess < 0
          ? `M${mid},${yy} H${x + rad} Q${x},${yy} ${x},${yy + rad} V${yy + bh - rad} Q${x},${yy + bh} ${x + rad},${yy + bh} H${mid} Z`
          : `M${mid},${yy} H${mid + w - rad} Q${mid + w},${yy} ${mid + w},${yy + rad} V${yy + bh - rad} Q${mid + w},${yy + bh} ${mid + w - rad},${yy + bh} H${mid} Z`;
        svgEl('path', { d, class: r.excess < 0 ? 'bar under' : 'bar over' }, g);
      }
      const lx = r.excess < 0 ? mid - w - 6 : mid + w + 6;
      svgEl('text', { x: lx, y: y + rowH / 2 + 4, class: 'lab', 'text-anchor': r.excess < 0 ? 'end' : 'start' }, g).textContent = sgn(r.excess);
    });
    const tbl = document.createElement('details');
    tbl.innerHTML = `<summary>Ver como tabla</summary><div class="table-scroll"><table class="score"><thead><tr><th>Hoyo</th><th>Par</th><th>Hcp</th><th>Veces</th><th>Al par</th><th>Vs. hándicap</th><th>Par o mejor</th></tr></thead><tbody>${
      rows.map((r) => `<tr><td>${r.n}</td><td>${r.par}</td><td>${r.si}</td><td>${r.count}</td><td>${r.count ? sgn(r.toPar) : '–'}</td><td>${r.count ? sgn(r.excess) : '–'}</td><td>${r.count ? pct(r.t.under + r.t.par, r.count) + ' %' : '–'}</td></tr>`).join('')}</tbody></table></div>`;
    box.append(tbl);
  }

  // Dispersión de un palo: desvío lateral (x) y distancia (y) de cada golpe, con la caja central (cuartiles).
  function drawDispersion(box, shots, club) {
    const W = Math.max(300, Math.min(560, box.clientWidth - 32));
    const H = 280;
    const pad = { l: 40, r: 14, t: 14, b: 30 };
    const ds = shots.map((s) => s.d);
    const lats = shots.map((s) => s.lat);
    const latMax = Math.max(15, ...lats.map(Math.abs)) * 1.1;
    const dLo = Math.max(0, Math.floor((Math.min(...ds) - 10) / 10) * 10);
    const dHi = Math.ceil((Math.max(...ds) + 10) / 10) * 10;
    const X = (v) => pad.l + ((v + latMax) / (2 * latMax)) * (W - pad.l - pad.r);
    const Y = (v) => pad.t + ((dHi - v) / (dHi - dLo)) * (H - pad.t - pad.b);
    const med = quant(ds, 0.5);
    const latMed = quant(lats, 0.5);
    const side = Math.abs(latMed) < 3 ? 'recto' : latMed > 0 ? `a la derecha (${Math.round(latMed)} m)` : `a la izquierda (${Math.round(-latMed)} m)`;
    const cfg = bagClub(club);
    box.innerHTML = `<p class="viz-note">${shots.length} golpe${shots.length === 1 ? '' : 's'} · distancia mediana <b>${Math.round(med)} m</b>${shots.length >= 4 ? ` (la mitad entre ${Math.round(quant(ds, 0.25))} y ${Math.round(quant(ds, 0.75))} m)` : ''} · tendencia <b>${side}</b>. En tu bolsa: ${cfg.dist} m.
      ${shots.length >= 3 && Math.abs(med - cfg.dist) >= 8 ? `<button class="btn small" id="use-med">Usar ${Math.round(med)} m en la bolsa</button>` : ''}</p>`;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': `Dispersión de ${clubName(club)}` }, box);
    for (let v = dLo; v <= dHi; v += dHi - dLo > 80 ? 20 : 10) {
      svgEl('line', { x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v), class: 'grid' }, svg);
      svgEl('text', { x: pad.l - 6, y: Y(v) + 4, class: 'tick', 'text-anchor': 'end' }, svg).textContent = `${v} m`;
    }
    svgEl('line', { x1: X(0), x2: X(0), y1: pad.t, y2: H - pad.b, class: 'axis0' }, svg);
    svgEl('text', { x: X(0), y: H - 8, class: 'tick', 'text-anchor': 'middle' }, svg).textContent = 'línea a bandera';
    svgEl('text', { x: pad.l + 2, y: H - 8, class: 'tick' }, svg).textContent = '← izquierda';
    svgEl('text', { x: W - pad.r, y: H - 8, class: 'tick', 'text-anchor': 'end' }, svg).textContent = 'derecha →';
    if (shots.length >= 4) {
      const x0 = X(quant(lats, 0.25));
      const x1 = X(quant(lats, 0.75));
      const y0 = Y(quant(ds, 0.75));
      const y1 = Y(quant(ds, 0.25));
      svgEl('rect', { x: x0, y: y0, width: Math.max(2, x1 - x0), height: Math.max(2, y1 - y0), rx: 4, class: 'box' }, svg);
    }
    shots.forEach((s) => {
      const g = svgEl('g', { tabindex: 0, 'data-tip': `${Math.round(s.d)} m · ${Math.abs(s.lat) < 1 ? 'recto' : `${Math.round(Math.abs(s.lat))} m a la ${s.lat > 0 ? 'derecha' : 'izquierda'}`}\nHoyo ${s.n} · ${fmtDate(s.date)}` }, svg);
      svgEl('circle', { cx: X(s.lat), cy: Y(s.d), r: 12, class: 'hit' }, g);
      svgEl('circle', { cx: X(s.lat), cy: Y(s.d), r: 4.5, class: 'pt' }, g);
    });
    const use = box.querySelector('#use-med');
    if (use) use.onclick = () => {
      bag.clubs[club] = { ...bagClub(club), dist: Math.round(med) };
      Store.saveBag(bag);
      toast(`${clubName(club)}: ${Math.round(med)} m en tu bolsa.`);
      drawDispersion(box, shots, club);
    };
  }

  // Mapa de un hoyo con todos los golpes apuntados en todas las vueltas.
  const lieImgs = {};
  function drawShotMap(P) {
    const cv = app.querySelector('#shotmap');
    const info = app.querySelector('#shotmap-info');
    if (!cv) return;
    const n = progressHole;
    const raw = byNumber[n];
    const h = GC.prepareHole(raw, 'amarillas');
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(r.width * dpr);
    cv.height = Math.round(r.height * dpr);
    cv.setAttribute('aria-label', `Golpes apuntados en el hoyo ${n}`);
    const c = cv.getContext('2d');
    const rot = GC.holeRotation(h);
    const cam = GC.fitCamera([h.tee, h.pin], rot, { w: r.width * 0.8, h: r.height * 0.86 }, 40, 0.1, 30);
    const v = { cx: r.width / 2, cy: r.height / 2 };
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.save();
    GC.applyCamera(c, cam, v);
    GC.renderHole(c, h, 0, {});
    c.restore();
    const S = (p) => GC.worldToScreen(cam, v, p);
    let shotsN = 0;
    let roundsN = 0;
    const ends = [];
    for (const rd of rounds) {
      const hs = rd.scores[n];
      if (!hs || !hs.entries.length) continue;
      roundsN++;
      const pos = withRound(rd, () => positions(n));
      hs.entries.forEach((e, i) => {
        if (e.t !== 's') return;
        shotsN++;
        const pts = [pos[i]].concat(e.p || [], [pos[i + 1]]).map(S);
        c.strokeStyle = e.l === 'water' || e.l === 'ob' ? 'rgba(255,110,90,0.85)' : 'rgba(255,248,210,0.8)';
        c.lineWidth = 2;
        c.lineCap = c.lineJoin = 'round';
        c.beginPath();
        pts.forEach((p, k) => (k ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
        c.stroke();
        ends.push({ p: pts[pts.length - 1], l: e.l });
      });
    }
    const pin = S(h.pin);
    GC.drawFlag(c, pin.x, pin.y, 0.9, 0.4, 3);
    // icono del lie donde quedó cada bola (encima de todas las líneas)
    const pending = [];
    for (const e of ends) {
      const url = GC.Tour && GC.Tour.lieIconUrl ? GC.Tour.lieIconUrl(e.l) : null;
      if (!url) continue;
      let img = lieImgs[e.l];
      if (!img) {
        img = lieImgs[e.l] = new Image();
        img.src = url;
      }
      if (img.complete) c.drawImage(img, e.p.x - 9, e.p.y - 9, 18, 18);
      else pending.push(img);
    }
    if (pending.length) pending[0].onload = () => drawShotMap(P);
    const row = P.holeRows.find((x) => x.n === n);
    info.innerHTML = `<b>Hoyo ${n}</b> · par ${raw.par} · hándicap ${SI_OF(n)}<br>${row && row.count
      ? `Jugado ${row.count} veces · media ${sgn(row.toPar)} al par · par o mejor ${pct(row.t.under + row.t.par, row.count)} % · dobles o peor ${pct(row.t.double, row.count)} %`
      : 'Sin resultados todavía'}<br><span class="muted">${shotsN ? `${shotsN} golpes apuntados en ${roundsN} vuelta${roundsN === 1 ? '' : 's'}` : 'Ningún golpe apuntado en el mapa en este hoyo'}</span>`;
  }

  // ---------- resumen en 3D ----------

  const LIE_FROM = { tee: 'Desde el tee', fairway: 'Desde la calle', rough: 'Desde el rough', sand: 'Desde el búnker',
    green: 'Desde el green', water: 'Desde el agua', ob: 'Desde fuera' };
  const LIE_TO = { tee: 'al tee', fairway: 'a la calle', rough: 'al rough', sand: 'al búnker', green: 'al green',
    water: 'al agua', ob: 'fuera de límites' };
  const cap1 = (t) => t.charAt(0).toUpperCase() + t.slice(1);

  // Golpes de un hoyo explicados, con las posiciones en metros del hoyo (para GC.Tour.replay).
  function replayHole(n) {
    const hs = round.scores[n];
    const total = strokesOf(hs);
    if (!total) return null;
    const h = holeData(n);
    const st = holeStats(n);
    const par = st.par;
    const pos = positions(n);
    const steps = [];
    let k = 0;
    let lie = 'tee';
    hs.entries.forEach((e, i) => {
      const A = pos[i];
      const B = pos[i + 1];
      k++;
      if (e.t === 's') {
        const d = GC.dist(A, B);
        const left = GC.dist(B, h.pin);
        const dz = h.heightAt(B.x, B.y) - h.heightAt(A.x, A.y);
        const chips = [];
        if (e.f) chips.push(`Vuelo ${shapeName(e.f).toLowerCase()}`);
        if (Math.abs(dz) >= 2) chips.push(`${dz > 0 ? 'Sube' : 'Baja'} ${Math.abs(dz).toFixed(0)} m`);
        const holed = hs.done && i === hs.entries.length - 1 && !hs.putts && left < 3;
        let tip = '';
        if (e.l === 'water' || e.l === 'ob') tip = 'Penalización: un golpe más y a dropar.';
        else if (holed) tip = '¡Embocada desde fuera del green!';
        else if (e.l === 'green' && k <= par - 2) tip = 'Green en regulación.';
        steps.push({
          kind: 'shot', from: A, to: B, path: e.p || null, lie: e.l,
          cap: {
            eyebrow: `Hoyo ${n} · golpe ${k}`,
            title: `${clubName(e.c)} · ${Math.round(d)} m`,
            line: `${LIE_FROM[lie] || 'Desde ' + lieName(lie).toLowerCase()} ${LIE_TO[e.l] || lieName(e.l).toLowerCase()}${holed ? ' · dentro' : ` · quedan ${Math.round(left)} m`}`,
            chips, tip, lie: { k: e.l, name: holed ? 'Dentro' : lieName(e.l) },
          },
        });
        lie = e.l;
      } else {
        const dropped = e.x != null;
        lie = dropped ? detectLie(h, B.x, B.y) : lie;
        steps.push({
          kind: 'drop', from: A, to: B, lie,
          cap: {
            eyebrow: `Hoyo ${n} · golpe ${k}`, title: 'Penalización', lie: dropped ? { k: lie, name: `Drop en ${lieName(lie).toLowerCase()}` } : null,
            line: `+1 golpe${dropped ? ` · drop en ${lieName(lie).toLowerCase()} a ${Math.round(GC.dist(B, h.pin))} m de la bandera` : ''}`,
            chips: [], tip: '',
          },
        });
      }
    });
    if (hs.putts) {
      const L = pos[pos.length - 1];
      steps.push({
        kind: 'putts', from: L, to: h.pin, lie: 'green',
        cap: {
          eyebrow: `Hoyo ${n} · en el green`,
          title: `${hs.putts} putt${hs.putts === 1 ? '' : 's'}`, lie: { k: 'green', name: 'Green' },
          line: `Desde ${Math.round(GC.dist(L, h.pin))} m${hs.done ? ' · embocada' : ''}`,
          chips: [], tip: hs.putts >= 3 ? 'Tres putts o más: el green se complicó.' : hs.putts === 1 ? 'Un solo putt.' : '',
        },
      });
    }
    const card = usesTotal(hs);
    const strokes = st.cardStrokes;
    const d = strokes - par;
    const result = st.cardDone ? cap1(parName(d)) : 'Sin terminar';
    const chips = [];
    if (!card && st.fairway != null) chips.push(st.fairway ? 'Calle cogida' : 'Calle fallada');
    if (!card && st.gir != null) chips.push(st.gir ? 'Green en regulación' : 'Sin green en regulación');
    if (!card && st.pens) chips.push(`${st.pens} penalización${st.pens > 1 ? 'es' : ''}`);
    return {
      n,
      holed: !!hs.done,
      header: {
        eyebrow: `Hoyo ${n} · par ${par}`, title: `Hoyo ${n}`,
        line: `${h.length} m · ${golpes(strokes)}${st.cardDone ? ` · ${parName(d)}` : ''}`,
        chips: card ? ['Tarjeta, sin golpes en el mapa'] : [`${golpes(liveStrokes(hs))} apuntados`], tip: '',
      },
      end: {
        eyebrow: `Hoyo ${n} · resultado`, title: result,
        line: `${golpes(strokes)}${!card && hs.putts ? ` · ${hs.putts} putt${hs.putts === 1 ? '' : 's'}` : ''}${st.cardDone ? ` · ${signed(d)}` : ''}`,
        chips, tip: holeNote(n) || (card ? 'Apunta los golpes en el mapa para verlos dibujados.' : ''),
      },
      steps: card ? [] : steps,
    };
  }

  // Resumen de la vuelta (o de un hoyo) para el visor 3D.
  function replayData(r, only) {
    return withRound(r, () => {
      const holes = r.holes.filter((n) => only == null || n === only).map(replayHole).filter(Boolean);
      if (only != null) return { holes };
      const t = totals(r);
      const tally = { birdie: 0, par: 0, bogey: 0, double: 0 };
      let putts = 0;
      let best = null;
      let worst = null;
      for (const hd of holes) {
        const st = holeStats(hd.n);
        if (!st.cardDone) continue;
        const d = st.cardStrokes - st.par;
        tally[d < 0 ? 'birdie' : d === 0 ? 'par' : d === 1 ? 'bogey' : 'double']++;
        putts += st.putts || 0;
        if (!best || d < best.d) best = { n: hd.n, d };
        if (!worst || d > worst.d) worst = { n: hd.n, d };
      }
      const chips = [];
      if (tally.birdie) chips.push(`${tally.birdie} bajo par`);
      chips.push(`${tally.par} par${tally.par === 1 ? '' : 'es'}`);
      if (tally.bogey) chips.push(`${tally.bogey} bogey${tally.bogey === 1 ? '' : 's'}`);
      if (tally.double) chips.push(`${tally.double} doble${tally.double === 1 ? '' : 's'} o peor`);
      if (putts) chips.push(`${putts} putts`);
      const tip = best ? `Mejor hoyo: el ${best.n} (${parName(best.d)}).${worst && worst.d > best.d ? ` El que más costó: el ${worst.n} (${parName(worst.d)}).` : ''}` : '';
      return {
        intro: {
          eyebrow: `Resumen de la vuelta${r.event ? ' · ' + esc(r.event) : ''}`, title: esc(fmtDate(r.date)),
          line: `${golpes(t.strokes)} · ${signed(t.diff)} al par · ${t.played} hoyo${t.played === 1 ? '' : 's'}`, chips, tip: '',
        },
        outro: { eyebrow: 'Final de la vuelta', title: `${golpes(t.strokes)} · ${signed(t.diff)}`, line: esc(fmtDate(r.date)), chips, tip },
        holes,
      };
    });
  }

  // Último comentario del jugador sobre un hoyo (para la ficha final del hoyo en el resumen).
  function holeNote(n) {
    const c = (round.chat || []).filter((m) => m.role === 'user' && m.hole === n).pop();
    return c ? `Tu comentario: «${esc(c.content.length > 140 ? c.content.slice(0, 137) + '…' : c.content)}»` : '';
  }

  // Texto de la vuelta para la IA: cada hoyo con sus golpes explicados (lo mismo que cuenta el resumen 3D).
  function roundBrief(r) {
    const data = replayData(r);
    const plain = (t) => String(t || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    const lines = [];
    const t = totals(r);
    lines.push(`Vuelta en Golf Sotoverde (par 60), ${fmtDate(r.date)}${r.event ? `, prueba «${r.event}»` : ''}. Barras ${r.tees}.`);
    lines.push(`Resultado: ${golpes(t.strokes)} en ${t.played} hoyos, ${signed(t.diff)} al par en los terminados.`);
    if (r.cond) lines.push(`Condiciones: ${r.cond.temp} °C, viento ${r.cond.wind} km/h.`);
    for (const hd of data.holes) {
      const steps = hd.steps.map((st) => `   - ${plain(st.cap.title)}: ${plain(st.cap.line)}${st.cap.chips.length ? ` (${st.cap.chips.join(', ')})` : ''}`);
      lines.push(`Hoyo ${hd.n}: ${plain(hd.header.line)}. Resultado: ${plain(hd.end.title)}, ${plain(hd.end.line)}${hd.end.chips.length ? `; ${hd.end.chips.join(', ')}` : ''}.`);
      if (steps.length) lines.push(...steps);
      else lines.push('   (solo el total de la tarjeta, sin golpes apuntados)');
    }
    const clubs = CLUBS.filter((c) => bagClub(c.id).on).map((c) => `${c.name} ${bagClub(c.id).dist} m (${bagClub(c.id).shape}, fallo habitual: ${bagClub(c.id).miss})`);
    if (clubs.length) lines.push(`Bolsa del jugador (distancias habituales): ${clubs.join('; ')}.`);
    return lines.join('\n').slice(0, 24000);
  }

  const COACH_RULES = (brief) => `Eres un entrenador de golf que repasa con un jugador amateur su vuelta en el campo Golf Sotoverde (Valladolid). \
El jugador está viendo un resumen en 3D de la vuelta y te escribe comentarios: qué sintió, qué pasó en un golpe, dudas.
Responde SIEMPRE en español, breve (2 a 5 frases), cercano y concreto. Relaciona lo que dice con los datos de la vuelta \
(palos, distancias, lies, putts) y, si viene a cuento, da UN consejo práctico para la próxima vez. No inventes golpes ni datos que no estén abajo; \
si te falta información, pregunta. Si el comentario es solo una nota (p. ej. «el viento estaba de cara»), confírmala en una frase y relaciónala con el hoyo.
Cada mensaje del jugador empieza con el hoyo que estaba viendo entre corchetes.

Datos de la vuelta:
${brief}`;

  // Visor a pantalla completa con comentarios: se cierra con ✕ o Escape y libera la escena.
  function open3D(data, r) {
    if (!data.holes.length) {
      toast('No hay hoyos jugados para ver en 3D.');
      return;
    }
    const modal = document.createElement('div');
    modal.className = 'replay-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', 'Resumen en 3D');
    modal.innerHTML = `<div class="replay-wrap"><div class="tour replay" id="replay"></div>
      <aside class="coach" aria-label="Comentarios">
        <header><b>Comentarios</b><span class="coach-ai">con IA</span></header>
        <div class="coach-log" aria-live="polite"></div>
        <div class="coach-quick"></div>
        <form class="coach-form">
          <span class="coach-ctx"></span>
          <textarea rows="2" maxlength="600" placeholder="¿Qué pasó en este hoyo?" aria-label="Tu comentario"></textarea>
          <div class="coach-row"><span class="coach-note muted"></span><button type="button" class="btn small coach-stop" hidden>Parar</button><button class="btn small primary" type="submit">Enviar</button></div>
        </form>
      </aside></div><button class="replay-close" aria-label="Cerrar">✕</button>`;
    document.body.appendChild(modal);
    let hole = data.holes.length === 1 ? data.holes[0].n : null;
    const coach = modal.querySelector('.coach');
    const player = GC.Tour.replay(modal.querySelector('#replay'), data, {
      autoplay: true, button: data.intro ? 'Resumen 3D' : 'Hoyo en 3D',
      onSegment: (n) => {
        if (n != null) hole = n;
        ctx();
      },
    });
    const ctx = () => {
      coach.querySelector('.coach-ctx').textContent = hole != null ? `Hoyo ${hole}` : 'Vuelta';
      coach.querySelector('textarea').placeholder = hole != null ? `¿Qué pasó en el hoyo ${hole}?` : '¿Qué tal fue la vuelta?';
    };
    ctx();
    bindCoach(coach, r, () => hole, () => GC.Tour.pause(player));
    const close = () => {
      if (coach.abort) coach.abort();
      GC.Tour.dispose(player);
      modal.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape' && document.activeElement.tagName !== 'TEXTAREA') close(); };
    document.addEventListener('keydown', onKey);
    modal.querySelector('.replay-close').onclick = close;
  }

  const COACH_ERRORS = {
    not_granted: 'La IA no tiene permiso en esta página; tu comentario queda guardado igualmente.',
    sampling_disabled: 'La IA no está disponible en tu cuenta; tu comentario queda guardado.',
    rate_limited: 'Demasiadas consultas seguidas: prueba de nuevo en un rato.',
    session_expired: 'Vuelve a iniciar sesión en Claude para usar la IA.',
    refused: 'La IA no ha querido responder a ese comentario.',
  };

  function bindCoach(coach, r, getHole, pause) {
    const log = coach.querySelector('.coach-log');
    const form = coach.querySelector('.coach-form');
    const box = form.querySelector('textarea');
    const note = form.querySelector('.coach-note');
    const stop = form.querySelector('.coach-stop');
    const send = form.querySelector('[type="submit"]');
    let sample = null;
    let disabled = false;
    let busy = false;
    if (!r.chat) r.chat = [];
    const bubble = (m) => {
      const el = document.createElement('div');
      el.className = `msg ${m.role}`;
      if (m.role === 'user') {
        const tag = document.createElement('span');
        tag.className = 'msg-hole';
        tag.textContent = m.hole != null ? `Hoyo ${m.hole}` : 'Vuelta';
        el.append(tag);
      }
      const body = document.createElement('p');
      body.textContent = m.content;
      el.append(body);
      log.append(el);
      log.scrollTop = log.scrollHeight;
      return body;
    };
    const render = () => {
      log.textContent = '';
      if (!r.chat.length) {
        const p = document.createElement('p');
        p.className = 'coach-empty';
        p.textContent = 'Cuenta qué sentiste o qué pasó en cada golpe. Se guarda en la vuelta y la IA lo comenta con tus datos.';
        log.append(p);
      }
      r.chat.forEach(bubble);
    };
    render();
    const quick = coach.querySelector('.coach-quick');
    for (const q of ['¿Dónde perdí más golpes?', '¿Qué practico esta semana?', 'Resúmeme la vuelta']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = q;
      b.onclick = () => ask(q);
      quick.append(b);
    }
    const setBusy = (v) => {
      busy = v;
      send.disabled = v;
      stop.hidden = !v;
      quick.hidden = v || disabled;
    };
    async function ask(text) {
      const content = text.trim();
      if (!content || busy) return;
      pause();
      const msg = { role: 'user', content, hole: getHole(), at: new Date().toISOString() };
      if (!r.chat.length) log.textContent = '';
      r.chat.push(msg);
      bubble(msg);
      box.value = '';
      Store.save(r);
      if (disabled) return;
      if (!sample) sample = window.claude && window.claude.use ? await window.claude.use('sample').catch(() => null) : null;
      if (!sample) {
        disabled = true;
        quick.hidden = true;
        note.textContent = 'Comentario guardado. La IA no está disponible aquí.';
        return;
      }
      const out = bubble({ role: 'assistant', content: 'Pensando…' });
      out.parentNode.classList.add('pending');
      const ctl = new AbortController();
      coach.abort = () => ctl.abort();
      stop.onclick = () => ctl.abort();
      setBusy(true);
      note.textContent = '';
      // instrucciones + últimos turnos (la IA no recuerda nada entre llamadas)
      const turns = r.chat.slice(-16).map((m) => ({
        role: m.role, content: m.role === 'user' ? `[${m.hole != null ? 'Hoyo ' + m.hole : 'Vuelta'}] ${m.content}` : m.content,
      }));
      while (turns.length && turns[0].role !== 'user') turns.shift();
      try {
        const { text: answer } = await sample([{ role: 'user', content: COACH_RULES(roundBrief(r)) }, ...turns], {
          cache: false, signal: ctl.signal,
          onText: ({ text: t }) => { out.textContent = t; out.parentNode.classList.remove('pending'); log.scrollTop = log.scrollHeight; },
        });
        out.textContent = answer;
        r.chat.push({ role: 'assistant', content: answer, at: new Date().toISOString() });
        if (r.chat.length > 60) r.chat.splice(0, r.chat.length - 60);
        Store.save(r);
      } catch (e) {
        const code = e && e.code;
        if (e && e.text && code !== 'refused') {
          out.textContent = e.text;
          r.chat.push({ role: 'assistant', content: e.text, at: new Date().toISOString() });
          Store.save(r);
        } else out.parentNode.remove();
        if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(code)) {
          disabled = true;
          quick.hidden = true;
        }
        if (code !== 'cancelled') note.textContent = COACH_ERRORS[code] || 'No se pudo contactar con la IA; tu comentario queda guardado.';
      } finally {
        coach.abort = null;
        setBusy(false);
      }
    }
    form.onsubmit = (e) => {
      e.preventDefault();
      ask(box.value);
    };
    box.onfocus = pause;
    box.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        ask(box.value);
      }
    };
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
    get round() { return round; }, get rounds() { return rounds; }, get store() { return Store; }, toUtm30, tapMap: (p) => tapMap(p),
    mergeRounds, stablefordOf,
    teeScreen: () => { const pos = positions(currentN()); return GC.worldToScreen(cam, mapView, pos[pos.length - 1]); },
    pinScreen: () => GC.worldToScreen(cam, mapView, holeData(currentN()).pin),
  };
})();
