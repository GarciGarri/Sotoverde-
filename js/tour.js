/*
 * Recorrido 3D del campo para la portada: un "vídeo" generado en el navegador con three.js.
 * Terreno con la ortofoto PNOA sobre el relieve real (MDT05 del IGN), edificios en volumen con su tejado de la
 * ortofoto, lagos, puente, árboles con el color de su copa, banderas y tees (datos de tools/campo_3d.py).
 * La cámara sobrevuela el campo, enseña las instalaciones y recorre cada hoyo del tee al green con su ficha.
 */
(function (global) {
  'use strict';
  const GC = (global.GC = global.GC || {});

  const THREE_URLS = ['https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js', 'vendor/three.min.js'];
  // Hándicap de cada hoyo (tarjeta del club).
  const STROKE_INDEX = { 1: 16, 2: 9, 3: 8, 4: 13, 5: 11, 6: 3, 7: 18, 8: 6, 9: 2, 10: 10, 11: 17, 12: 12, 13: 15, 14: 1, 15: 14, 16: 4, 17: 5, 18: 7 };
  // Lo que no se deduce de la recta tee-bandera: el hoyo 6 gira en el plano del club.
  const NOTES = { 6: ['Dog-leg'] };
  const EXAG = 1.3; // exageración vertical del relieve
  const DUR = { intro: 8, club: 5.5, hole: 6.5, outro: 5 };

  function loadThree() {
    if (global.THREE) return Promise.resolve(global.THREE);
    return THREE_URLS.reduce((p, url) => p.catch(() => new Promise((ok, ko) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => (global.THREE ? ok(global.THREE) : ko(new Error('three.js no se ha cargado')));
      s.onerror = ko;
      document.head.appendChild(s);
    })), Promise.reject(new Error('inicio')));
  }

  // ---------- datos del campo en coordenadas del recorrido (metros, x este, y sur desde la esquina NO) ----------

  // Los datos 3D (js/campo3d.js, ~350 KB) solo se descargan al reproducir; hasta entonces basta con los hoyos.
  const ORIGIN = [349080, 4609290]; // esquina NO del campo (UTM 30N), la misma que usa tools/campo_3d.py
  const POSTER = 'img/campo_poster.jpg';
  const DATA_URL = 'js/campo3d.js';
  let dataPromise = null;
  function loadCourse() {
    if (GC.COURSE_3D) return Promise.resolve(GC.COURSE_3D);
    if (!dataPromise) {
      dataPromise = new Promise((ok, ko) => {
        const s = document.createElement('script');
        s.src = DATA_URL;
        s.onload = () => (GC.COURSE_3D ? ok(GC.COURSE_3D) : ko(new Error('sin datos 3D')));
        s.onerror = () => {
          dataPromise = null;
          ko(new Error('sin datos 3D'));
        };
        document.head.appendChild(s);
      });
    }
    return dataPromise;
  }

  let holesCache = null;
  function holesModel() {
    if (holesCache) return holesCache;
    const [X0, Y1] = ORIGIN;
    const holes = (GC.COURSE_HOLES || []).slice().sort((a, b) => a.number - b.number).map((raw) => {
      const h = GC.prepareHole(raw, 'amarillas');
      const ox = raw.geo.origin[0] - X0;
      const oy = Y1 - raw.geo.origin[1];
      const to = (p) => ({ x: p.x + ox, y: p.y + oy });
      return { raw, h, ox, oy, to, tee: to(h.tee), pin: to(h.pin), info: holeInfo(raw, h) };
    });
    holesCache = { C: null, holes, club: [] };
    return holesCache;
  }

  let modelCache = null;
  function courseModel() {
    if (modelCache) return modelCache;
    const C = GC.COURSE_3D;
    if (C.origin[0] !== ORIGIN[0] || C.origin[1] !== ORIGIN[1]) throw new Error('campo3d.js no coincide con ORIGIN');
    const D = C.dem;
    const heights = D.dm.map((v) => D.base + v / 10);
    const heightAt = (x, y) => {
      const fx = GC.clamp((x - D.x) / D.cell, 0, D.cols - 1);
      const fy = GC.clamp((y - D.y) / D.cell, 0, D.rows - 1);
      const i = Math.min(Math.floor(fx), D.cols - 2);
      const j = Math.min(Math.floor(fy), D.rows - 2);
      const u = fx - i;
      const v = fy - j;
      const at = (a, b) => heights[b * D.cols + a];
      return at(i, j) * (1 - u) * (1 - v) + at(i + 1, j) * u * (1 - v) + at(i, j + 1) * (1 - u) * v + at(i + 1, j + 1) * u * v;
    };
    const { holes } = holesModel();
    const model = { C, heightAt, holes, base: Math.min(...heights), width: C.size[0], depth: C.size[1] };
    model.club = clubStops(model);
    modelCache = model;
    return model;
  }

  function segDist(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = GC.clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    return { d: Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy), t };
  }

  // Ficha del hoyo a partir de los datos: tipo, desnivel, agua, búnkeres, dog-leg y un consejo.
  function holeInfo(raw, h) {
    const m = /Tarjeta:\s*(\d+)\s*m/.exec(raw.card || '');
    const meters = m ? Number(m[1]) : h.length;
    const par = raw.par;
    const chips = [];
    let type;
    if (par === 3) type = meters < 100 ? 'Par 3 corto' : meters <= 150 ? 'Par 3 medio' : 'Par 3 largo';
    else if (par === 4) type = meters < 270 ? 'Par 4 corto' : 'Par 4';
    else type = 'El único par 5';
    const dz = h.elev ? h.heightAt(h.pin.x, h.pin.y) - h.heightAt(h.tee.x, h.tee.y) : 0;
    // agua: sobre la línea de juego o junto al green
    let waterLine = false;
    let waterGreen = false;
    for (const w of h.water) {
      for (const p of w.pts) {
        const s = segDist(p, h.tee, h.pin);
        if (s.d < 12 && s.t > 0.05 && s.t < 0.9) waterLine = true;
        if (GC.dist(p, h.pin) < 30) waterGreen = true;
      }
    }
    const centroid = (poly) => poly.pts.reduce((a, p) => ({ x: a.x + p.x / poly.pts.length, y: a.y + p.y / poly.pts.length }), { x: 0, y: 0 });
    let greenBunkers = 0;
    let fairwayBunkers = 0;
    for (const b of h.bunkers) {
      const c = centroid(b);
      const s = segDist(c, h.tee, h.pin);
      if (GC.dist(c, h.pin) < 26) greenBunkers++;
      else if (s.d < 22 && s.t > 0.25) fairwayBunkers++;
    }
    // dog-leg: la calle se aparta de la recta tee-bandera
    let dogleg = null;
    if (par >= 4 && h.fairways.length) {
      const L = GC.dist(h.tee, h.pin) || 1;
      const u = { x: (h.pin.x - h.tee.x) / L, y: (h.pin.y - h.tee.y) / L };
      let off = 0;
      for (const p of h.fairways[0].pts) {
        const o = (p.x - h.tee.x) * -u.y + (p.y - h.tee.y) * u.x;
        if (Math.abs(o) > Math.abs(off)) off = o;
      }
      if (Math.abs(off) > 25) dogleg = off > 0 ? 'derecha' : 'izquierda';
    }
    chips.push(type);
    (NOTES[raw.number] || []).forEach((n) => chips.push(n));
    if (dogleg && !NOTES[raw.number]) chips.push(`Dog-leg a la ${dogleg}`);
    if (Math.abs(dz) >= 2) chips.push(`${dz > 0 ? 'Sube' : 'Baja'} ${Math.abs(dz).toFixed(0)} m`);
    if (waterLine) chips.push('Salida sobre agua');
    else if (waterGreen) chips.push('Agua junto al green');
    if (greenBunkers) chips.push(`${greenBunkers} búnker${greenBunkers > 1 ? 'es' : ''} en el green`);
    if (fairwayBunkers) chips.push(`${fairwayBunkers} en la calle`);

    let tip;
    const si = STROKE_INDEX[raw.number];
    if (si === 1) tip = 'El hoyo más difícil del campo: aquí el bogey no es mal resultado.';
    else if (waterLine) tip = 'Hay que pasar el agua: elige el palo que la supera con margen, no el justo.';
    else if (dz >= 4) tip = `El green está ${dz.toFixed(0)} m más alto: coge un palo más.`;
    else if (dz <= -4) tip = `Baja ${Math.abs(dz).toFixed(0)} m hasta el green: un palo menos.`;
    else if (waterGreen) tip = 'El agua acecha junto al green: mejor quedarse en el lado seguro.';
    else if (greenBunkers >= 2) tip = 'Green bien defendido por arena: apunta al centro.';
    else if (par === 3 && meters < 100) tip = 'Hoyo corto: buena ocasión de birdie si aciertas la distancia.';
    else if (par >= 4) tip = 'Prioriza dejar la bola en calle: el segundo golpe es más sencillo.';
    else tip = 'Green accesible: juega al centro y deja un putt cómodo.';
    return { meters, par, si, dz, chips, tip };
  }

  // ---------- instalaciones: fichas calculadas con los datos extraídos ----------

  function near(model, p, r) {
    const out = [];
    for (const ho of model.holes) {
      if (GC.dist(ho.tee, p) < r) out.push({ n: ho.raw.number, what: 'tee', d: GC.dist(ho.tee, p) });
      if (GC.dist(ho.pin, p) < r) out.push({ n: ho.raw.number, what: 'green', d: GC.dist(ho.pin, p) });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  function listJoin(xs) {
    return xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`;
  }

  // «a los greens del 9 y 18 y a la salida del 1» (prep 'a') o «de los greens…» (prep 'de')
  function nearText(list, prep = 'a') {
    const uniq = (xs) => [...new Set(xs)];
    const greens = uniq(list.filter((x) => x.what === 'green').map((x) => x.n));
    const tees = uniq(list.filter((x) => x.what === 'tee').map((x) => x.n));
    const parts = [];
    const el = prep === 'a' ? 'al' : 'del';
    if (greens.length) parts.push(`${greens.length > 1 ? `${prep} los greens` : `${el} green`} del ${listJoin(greens)}`);
    if (tees.length) parts.push(`${prep} ${tees.length > 1 ? 'las salidas' : 'la salida'} del ${listJoin(tees)}`);
    return parts.join(' y ');
  }

  function polyArea(p) {
    let a = 0;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]);
    return Math.abs(a / 2);
  }

  function clubStops(model) {
    const C = model.C;
    const poi = (name) => C.pois.find((p) => p.name === name);
    const stops = [];
    const club = poi('Casa club');
    const parking = poi('Aparcamiento');
    if (club) {
      const list = near(model, club, 80);
      stops.push({
        at: club, radius: 85, height: 42, fit: [[club.x, club.y, club.h + 9]].concat(parking ? [[parking.x, parking.y, 2]] : []),
        cap: {
          eyebrow: 'Instalaciones', title: 'Casa club',
          line: list.length ? `Junto ${nearText(list)}` : 'El corazón del campo',
          chips: ['Casa club'].concat(parking ? [`Aparcamiento a ${Math.round(GC.dist(club, parking) / 10) * 10} m`] : []),
          tip: '',
        },
      });
    }
    const field = poi('Cancha de prácticas');
    const bays = C.buildings.find((b) => b.k === 'range');
    if (field && bays) {
      const bc = bays.p.reduce((a, q) => ({ x: a.x + q[0] / bays.p.length, y: a.y + q[1] / bays.p.length }), { x: 0, y: 0 });
      const len = C.range ? Math.max(...C.range.map((q) => Math.hypot(q[0] - bc.x, q[1] - bc.y))) : 0;
      const side = Math.max(...bays.p.map((q, i) => Math.hypot(q[0] - bays.p[(i + 1) % bays.p.length][0], q[1] - bays.p[(i + 1) % bays.p.length][1])));
      stops.push({
        at: { x: (bc.x * 2 + field.x) / 3, y: (bc.y * 2 + field.y) / 3 }, radius: 120, height: 55, from: bc,
        fit: bays.p.map((q) => [q[0], q[1], 5]).concat([[field.x, field.y, field.h + 9]]),
        cap: {
          eyebrow: 'Instalaciones', title: 'Cancha de prácticas',
          line: `Puestos cubiertos de unos ${Math.round(side / 5) * 5} m${len ? ` y campo de unos ${Math.round(len / 10) * 10} m de fondo` : ''}`,
          chips: ['Puestos cubiertos'].concat(C.range ? [`${(polyArea(C.range) / 10000).toFixed(1).replace('.', ',')} ha de cancha`] : []),
          tip: '',
        },
      });
    }
    const br = C.bridge;
    if (br) {
      const mid = { x: (br.a[0] + br.b[0]) / 2, y: (br.a[1] + br.b[1]) / 2 };
      const list = near(model, mid, 110);
      stops.push({
        at: mid, radius: 70, height: 26, fit: [[br.a[0], br.a[1], 2], [br.b[0], br.b[1], 2], [mid.x, mid.y, 18]],
        cap: {
          eyebrow: 'Instalaciones', title: 'El puente',
          line: `${Math.round(Math.hypot(br.b[0] - br.a[0], br.b[1] - br.a[1]))} m sobre el lago grande`,
          chips: ['Cruza el lago'],
          tip: list.length ? `Cerca ${nearText(list.slice(0, 3), 'de')}.` : '',
        },
      });
    }
    return stops;
  }

  // ---------- reproductor ----------

  function segments(model, clubStopsCount = model.club.length) {
    const segs = [{ kind: 'intro', dur: DUR.intro, label: 'I', title: 'Introducción' }];
    if (clubStopsCount) segs.push({ kind: 'club', dur: DUR.club * clubStopsCount, label: 'C', title: 'Instalaciones' });
    model.holes.forEach((ho, i) => segs.push({ kind: 'hole', i, dur: DUR.hole, label: String(ho.raw.number), title: `Hoyo ${ho.raw.number}` }));
    segs.push({ kind: 'outro', dur: DUR.outro, label: 'F', title: 'Final' });
    let t = 0;
    segs.forEach((s) => {
      s.t0 = t;
      t += s.dur;
    });
    return { segs, duration: t };
  }

  function mount(container, opts = {}) {
    const model = GC.COURSE_3D ? courseModel() : holesModel();
    const { segs, duration } = segments(model, model.C ? model.club.length : 3); // 3 instalaciones hasta tener los datos
    return makePlayer(container, model, segs, duration, {
      ...opts, button: 'Recorrido 3D', sub: `${Math.round(duration / 60)} min · 18 hoyos`, first: intro(model),
      resegment: (m) => segments(m),
    });
  }

  function makePlayer(container, model, segs, duration, opts) {
    const player = container.__player = {
      container, model, segs, duration, playing: false, t: 0, onEnd: opts.onEnd, data: opts.data || null, onSegment: opts.onSegment || null,
      resegment: opts.resegment || null,
    };
    container.innerHTML = `
      <canvas class="tour-poster" aria-hidden="true"></canvas>
      <div class="tour-gl"></div>
      <div class="tour-shade"></div>
      <div class="tour-cap" aria-live="polite"></div>
      <button class="tour-play" aria-label="Reproducir: ${opts.button}"><span class="tri"></span><b>${opts.button}</b><small>${opts.sub}</small></button>
      ${opts.data ? `<div class="tour-tools" hidden>
        ${opts.data.holes.some((h) => h.others && h.others.length) ? '<button class="tt" data-t="others" aria-pressed="false">Otras vueltas</button>' : ''}
        <button class="tt" data-t="free" aria-pressed="false">Cámara libre</button>
        <button class="tt" data-t="shot">Guardar imagen</button>
      </div>` : ''}
      <div class="tour-bar" hidden>
        <button class="tb" data-a="prev" aria-label="${opts.data ? 'Golpe anterior' : 'Tramo anterior'}">‹‹</button>
        <button class="tb" data-a="toggle" aria-label="Pausa">❚❚</button>
        <button class="tb" data-a="next" aria-label="${opts.data ? 'Golpe siguiente' : 'Tramo siguiente'}">››</button>
        <div class="tour-prog" role="slider" aria-label="Progreso del recorrido" aria-valuemin="0" aria-valuemax="100"></div>
      </div>`;
    if (!opts.data) {
      const fb = document.createElement('button');
      fb.className = 'tour-full';
      fb.setAttribute('aria-label', 'Pantalla completa');
      fb.setAttribute('aria-pressed', 'false');
      fb.innerHTML = '<span aria-hidden="true">⛶</span>';
      fb.onclick = () => toggleFull(player);
      container.append(fb);
      const onFs = () => {
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        if (!fsEl && player.fsOn) setFull(player, false);
        player.fsOn = !!fsEl;
      };
      document.addEventListener('fullscreenchange', onFs);
      document.addEventListener('webkitfullscreenchange', onFs);
      container.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && container.classList.contains('immersive')) setFull(player, false);
        if (e.key === 'f' || e.key === 'F') toggleFull(player);
      });
    }
    drawPoster(player);
    container.querySelector('.tour-play').onclick = () => start(player);
    container.querySelectorAll('.tour-bar .tb').forEach((b) => (b.onclick = () => action(player, b.dataset.a)));
    container.querySelectorAll('.tour-tools .tt').forEach((b) => (b.onclick = () => tool(player, b)));
    drawBar(player);
    caption(player, opts.first);
    bindSwipe(player);
    if (opts.autoplay) start(player);
    return player;
  }

  function drawBar(player) {
    const prog = player.container.querySelector('.tour-prog');
    prog.innerHTML = player.segs.filter((s) => s.kind !== 'outro' && s.kind !== 'routro')
      .map((s, i) => `<span data-seg="${i}" class="k-${s.kind}" title="${s.title}"><i></i></span>`).join('');
    prog.querySelectorAll('span').forEach((s) => (s.onclick = () => seekSeg(player, Number(s.dataset.seg))));
  }

  // Deslizar a izquierda o derecha pasa al tramo (hoyo) siguiente o anterior; también las flechas del teclado.
  function bindSwipe(player) {
    const c = player.container;
    let start = null;
    c.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, .tour-bar, .tour-tools') || player.free) return;
      start = { x: e.clientX, y: e.clientY };
    });
    c.addEventListener('pointercancel', () => (start = null));
    c.addEventListener('pointerup', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      start = null;
      if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      swipeTo(player, dx < 0 ? 1 : -1);
    });
    c.tabIndex = 0;
    c.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      swipeTo(player, e.key === 'ArrowRight' ? 1 : -1);
    });
    if (player.data && player.segs.length > 1) {
      const hint = document.createElement('div');
      hint.className = 'tour-hint';
      hint.innerHTML = '<span>‹</span>Desliza para cambiar de hoyo<span>›</span>';
      c.append(hint);
      setTimeout(() => hint.classList.add('out'), 3800);
      setTimeout(() => hint.remove(), 4600);
    }
  }

  function swipeTo(player, dir) {
    const { seg } = segmentAt(player, player.t);
    const last = player.segs.length - 1;
    const to = GC.clamp(seg + dir, 0, last);
    if (to === seg) return;
    const c = player.container;
    c.classList.remove('swipe-l', 'swipe-r');
    void c.offsetWidth;
    c.classList.add(dir > 0 ? 'swipe-l' : 'swipe-r');
    seekSeg(player, to);
  }

  // En los resúmenes, ‹‹ y ›› van de golpe en golpe (deslizar sigue cambiando de hoyo).
  function stepShot(player, dir) {
    const { seg, s } = segmentAt(player, player.t);
    if (s.kind !== 'play') {
      seekSeg(player, seg + dir);
      return;
    }
    const { j } = stepAt(s, player.t - s.t0);
    const lt = player.t - s.t0 - s.steps[j].t0;
    // atrás: al principio de este golpe si ya va avanzado, si no al anterior
    const to = dir > 0 ? j + 1 : lt > 0.8 ? j : j - 1;
    if (to < 0) seekSeg(player, seg - 1);
    else if (to >= s.steps.length) seekSeg(player, seg + 1);
    else {
      player.t = s.t0 + s.steps[to].t0 + 0.001;
      player.camPos = null;
      player.container.classList.remove('ended', 'paused');
      if (!player.playing) {
        player.playing = true;
        player.last = performance.now();
        player.container.classList.add('playing');
        loop(player);
      }
    }
  }

  // Herramientas del resumen: otras vueltas, cámara libre e imagen.
  function tool(player, b) {
    const t = b.dataset.t;
    if (!player.three) return;
    if (t === 'others') {
      player.showOthers = !player.showOthers;
      b.setAttribute('aria-pressed', String(player.showOthers));
      if (!player.playing) render(player);
    } else if (t === 'free') {
      if (player.free) {
        player.free = null;
        player.container.classList.remove('free-cam');
      } else {
        pause(player);
        const off = player.camPos.clone().sub(player.camLook);
        const dist = off.length();
        player.free = { target: player.camLook.clone(), dist, yaw: Math.atan2(off.x, off.z), pitch: Math.asin(GC.clamp(off.y / dist, -1, 1)) };
        player.container.classList.add('free-cam');
        bindFreeCam(player);
        render(player);
      }
      b.setAttribute('aria-pressed', String(!!player.free));
    } else if (t === 'shot') {
      saveImage(player);
    }
  }

  // Cámara libre: arrastrar gira alrededor del punto que se mira; rueda o pellizco acercan.
  function bindFreeCam(player) {
    if (player.freeBound) return;
    player.freeBound = true;
    const c = player.container.querySelector('.tour-gl');
    const pts = new Map();
    let pinch = null;
    c.addEventListener('pointerdown', (e) => {
      if (!player.free) return;
      c.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: player.free.dist };
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (!player.free || !pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const f = player.free;
      if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()];
        f.dist = GC.clamp(pinch.dist * (pinch.d / Math.max(10, Math.hypot(a.x - b.x, a.y - b.y))), 8, 900);
      } else {
        f.yaw -= (e.clientX - prev.x) * 0.006;
        f.pitch = GC.clamp(f.pitch + (e.clientY - prev.y) * 0.005, 0.08, 1.45);
      }
      render(player);
    });
    const up = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      if (!player.free) return;
      e.preventDefault();
      player.free.dist = GC.clamp(player.free.dist * Math.exp(e.deltaY * 0.0012), 8, 900);
      render(player);
    }, { passive: false });
  }

  // Guarda el fotograma con la ficha: con la capacidad de descargas de claude.ai o, fuera de ella, como enlace.
  async function saveImage(player) {
    render(player);
    const gl = player.three.renderer.domElement;
    const out = document.createElement('canvas');
    out.width = gl.width;
    out.height = gl.height;
    const g = out.getContext('2d');
    g.drawImage(gl, 0, 0);
    const k = out.width / Math.max(1, player.container.clientWidth);
    const grd = g.createLinearGradient(0, out.height * 0.55, 0, out.height);
    grd.addColorStop(0, 'rgba(8,28,17,0)');
    grd.addColorStop(1, 'rgba(8,28,17,0.88)');
    g.fillStyle = grd;
    g.fillRect(0, out.height * 0.55, out.width, out.height * 0.45);
    const cap = player.container.querySelector('.tour-cap');
    const text = (sel) => (cap.querySelector(sel) ? cap.querySelector(sel).textContent.trim() : '');
    const x = 22 * k;
    let y = out.height - 26 * k;
    g.textBaseline = 'alphabetic';
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.font = `600 ${13 * k}px Barlow, system-ui, sans-serif`;
    g.fillText('Golf Sotoverde · Mis vueltas', x, y);
    y -= 26 * k;
    g.fillStyle = '#ffffff';
    g.font = `700 ${18 * k}px 'Barlow Condensed', 'Arial Narrow', sans-serif`;
    g.fillText(text('.t-line'), x, y);
    y -= 12 * k;
    g.font = `800 ${40 * k}px 'Barlow Condensed', 'Arial Narrow', sans-serif`;
    g.fillText(text('.t-title').toUpperCase(), x, y);
    y -= 44 * k;
    g.fillStyle = '#a8d672';
    g.font = `700 ${12 * k}px Barlow, system-ui, sans-serif`;
    g.fillText(text('.eyebrow').toUpperCase(), x, y);
    const blob = await new Promise((ok) => out.toBlob(ok, 'image/png'));
    const name = `sotoverde-${text('.t-title').toLowerCase().replace(/[^a-z0-9áéíóúñ]+/gi, '-').replace(/^-|-$/g, '') || 'resumen'}.png`;
    const dl = global.claude && global.claude.use ? await global.claude.use('downloads').catch(() => null) : null;
    if (dl) {
      try {
        await dl.save({ filename: name, data: blob });
      } catch (e) {
        /* el visitante no quiso guardarla */
      }
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // Pantalla completa del recorrido de la portada: la del navegador si se puede y, en todo caso, a toda la ventana.
  function setFull(player, on) {
    const c = player.container;
    c.classList.toggle('immersive', on);
    document.documentElement.classList.toggle('tour-immersive', on);
    const b = c.querySelector('.tour-full');
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', on ? 'Salir de pantalla completa' : 'Pantalla completa');
    b.innerHTML = on ? '<span aria-hidden="true">✕</span>' : '<span aria-hidden="true">⛶</span>';
  }

  async function toggleFull(player) {
    const c = player.container;
    const on = !c.classList.contains('immersive');
    setFull(player, on);
    c.focus();
    try {
      if (on) {
        const req = c.requestFullscreen || c.webkitRequestFullscreen;
        if (req) await req.call(c);
      } else if (document.fullscreenElement || document.webkitFullscreenElement) {
        await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      }
    } catch (e) {
      /* sin pantalla completa del navegador: queda a toda la ventana */
    }
    if (on && !player.playing && !player.three) start(player);
  }

  // Libera la escena WebGL (los navegadores limitan cuántos contextos puede haber a la vez).
  function dispose(player) {
    player.playing = false;
    player.disposed = true;
    if (!player.three) return;
    player.three.ro.disconnect();
    player.three.renderer.dispose();
    player.three.renderer.forceContextLoss();
    player.three.renderer.domElement.remove();
    player.three = null;
  }

  function intro(model) {
    const meters = model.holes.reduce((a, ho) => a + ho.info.meters, 0);
    const par = model.holes.reduce((a, ho) => a + ho.info.par, 0);
    const p3 = model.holes.filter((ho) => ho.info.par === 3).length;
    const p4 = model.holes.filter((ho) => ho.info.par === 4).length;
    const lakes = model.C ? model.C.water.length : 0;
    return {
      eyebrow: 'Golf Sotoverde · Arroyo de la Encomienda',
      title: 'El campo',
      line: `${model.holes.length} hoyos · par ${par} · ${meters.toLocaleString('es-ES')} m desde amarillas`,
      chips: [`${p3} pares 3`, `${p4} pares 4`, `${model.holes.length - p3 - p4} par 5`].concat(lakes ? [`${lakes} lagos`] : [], ['Cancha de prácticas']),
      tip: 'Un recorrido corto y técnico: aquí manda la precisión con los hierros.',
    };
  }

  // Póster: la ortofoto del campo (versión reducida) hasta que se pulsa reproducir.
  function drawPoster(player) {
    const cv = player.container.querySelector('.tour-poster');
    const img = new Image();
    img.onload = () => {
      const r = player.container.getBoundingClientRect();
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      cv.width = Math.max(1, Math.round(r.width * dpr));
      cv.height = Math.max(1, Math.round(r.height * dpr));
      const ctx = cv.getContext('2d');
      const s = Math.max(cv.width / img.width, cv.height / img.height) * 1.08;
      ctx.drawImage(img, (cv.width - img.width * s) / 2, (cv.height - img.height * s) / 2, img.width * s, img.height * s);
    };
    img.src = POSTER;
  }

  function loadTexture(THREE, url) {
    return new Promise((ok, ko) => new THREE.TextureLoader().load(url, ok, undefined, ko));
  }

  async function start(player) {
    const c = player.container;
    c.classList.add('loading');
    try {
      const [THREE] = await Promise.all([loadThree(), loadCourse()]);
      if (!player.model.C) {
        player.model = courseModel();
        if (player.resegment) {
          Object.assign(player, player.resegment(player.model));
          drawBar(player);
        }
      }
      if (!player.three) {
        const [course, around] = await Promise.all([
          loadTexture(THREE, player.model.C.tex.course), loadTexture(THREE, player.model.C.tex.around)]);
        build(player, course, around);
      }
    } catch (e) {
      c.classList.remove('loading');
      caption(player, { eyebrow: 'Recorrido 3D', title: 'No disponible', line: 'No se pudo cargar el motor 3D o las imágenes del campo. Revisa la conexión y vuelve a intentarlo.', chips: [], tip: '' });
      return;
    }
    c.classList.remove('loading', 'paused', 'ended', 'free-cam');
    if (player.free) {
      player.free = null;
      const fb = c.querySelector('.tt[data-t="free"]');
      if (fb) fb.setAttribute('aria-pressed', 'false');
    }
    c.classList.add('playing');
    c.querySelector('.tour-bar').hidden = false;
    if (c.querySelector('.tour-tools')) c.querySelector('.tour-tools').hidden = false;
    player.playing = true;
    player.last = performance.now();
    if (player.t >= player.duration) player.t = 0;
    loop(player);
  }

  // ---------- escena ----------

  function build(player, courseTex, aroundTex) {
    const THREE = global.THREE;
    const { model } = player;
    const { C } = model;
    const host = player.container.querySelector('.tour-gl');
    // en los resúmenes se puede guardar la imagen: hace falta conservar el último fotograma
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: !!player.data });
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = skyTexture(THREE);
    scene.fog = new THREE.Fog(0xdfe8ea, 650, 1500);
    const camera = new THREE.PerspectiveCamera(46, 1, 1, 4000);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7a5c, 0.72));
    const sun = new THREE.DirectionalLight(0xfff1d8, 0.62);
    sun.position.set(-300, 420, -200);
    scene.add(sun);

    const aniso = renderer.capabilities.getMaxAnisotropy();
    [courseTex, aroundTex].forEach((t) => {
      t.anisotropy = aniso;
      t.encoding = THREE.sRGBEncoding;
    });
    renderer.outputEncoding = THREE.sRGBEncoding;

    const cx = model.width / 2;
    const cz = model.depth / 2;
    const Y = (x, y) => (model.heightAt(x, y) - model.base) * EXAG;
    const W = (x, y, lift = 0) => new THREE.Vector3(x - cx, Y(x, y) + lift, y - cz);
    player.W = W;

    // terreno: el campo con su ortofoto y, por debajo, los alrededores
    const ground = (x0, y0, w, h, step, tex, drop) => {
      const geo = new THREE.PlaneGeometry(w, h, Math.round(w / step), Math.round(h / step));
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i) + x0 + w / 2;
        const y = pos.getZ(i) + y0 + h / 2;
        pos.setY(i, Y(x, y) - drop);
        pos.setX(i, x - cx);
        pos.setZ(i, y - cz);
      }
      geo.computeVertexNormals();
      return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex }));
    };
    scene.add(ground(0, 0, model.width, model.depth, 4, courseTex, 0));
    const A = C.around;
    scene.add(ground(A.x, A.y, A.w, A.h, 10, aroundTex, 0.8));
    const skirt = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000), new THREE.MeshLambertMaterial({ color: 0xbdb79a }));
    skirt.rotation.x = -Math.PI / 2;
    skirt.position.y = -6;
    scene.add(skirt);

    // lagos
    const waterMat = new THREE.MeshPhongMaterial({ color: 0x2d6278, specular: 0xbfd8e4, shininess: 80, transparent: true, opacity: 0.9 });
    for (const w of C.water) {
      const shape = new THREE.Shape(w.p.map(([x, y]) => new THREE.Vector2(x - cx, -(y - cz))));
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, waterMat);
      mesh.position.y = (w.z - model.base) * EXAG + 0.25;
      scene.add(mesh);
    }

    // edificios: paredes claras y tejado con la propia ortofoto
    const uvFor = (inCourse) => ({
      generateTopUV(geometry, v, a, b, c) {
        return [a, b, c].map((k) => {
          const x = v[k * 3] + cx;
          const y = cz - v[k * 3 + 1];
          return inCourse
            ? new THREE.Vector2(x / model.width, 1 - y / model.depth)
            : new THREE.Vector2((x - A.x) / A.w, 1 - (y - A.y) / A.h);
        });
      },
      // fachada: u en tramos de 3 m a lo largo de la pared, v en plantas de 3 m
      generateSideWallUV(geometry, v, a, b, c, d) {
        const len = Math.hypot(v[a * 3] - v[b * 3], v[a * 3 + 1] - v[b * 3 + 1]) / 3;
        return [[0, a], [len, b], [len, c], [0, d]].map(([u, k]) => new THREE.Vector2(u, v[k * 3 + 2] / 3));
      },
    });
    const roofCourse = new THREE.MeshLambertMaterial({ map: courseTex });
    const roofAround = new THREE.MeshLambertMaterial({ map: aroundTex });
    const wall = new THREE.MeshLambertMaterial({ map: facade(THREE, '#d8c8ae', '#5d5a55') });
    const wallClub = new THREE.MeshLambertMaterial({ map: facade(THREE, '#f1eee6', '#3f4a52') });
    const wallRange = new THREE.MeshLambertMaterial({ color: 0x7a5b46 });
    for (const b of C.buildings) {
      const inCourse = b.p.every(([x, y]) => x >= 0 && y >= 0 && x <= model.width && y <= model.depth);
      const shape = new THREE.Shape(b.p.map(([x, y]) => new THREE.Vector2(x - cx, -(y - cz))));
      const hs = b.p.map(([x, y]) => Y(x, y));
      const mean = hs.reduce((a, v) => a + v, 0) / hs.length;
      const bottom = Math.max(Math.min(...hs), mean - 1.5) - 0.6; // sin paredes eternas en los taludes
      const top = mean + b.h;
      const geo = new THREE.ExtrudeGeometry(shape, { depth: top - bottom, bevelEnabled: false, UVGenerator: uvFor(inCourse) });
      geo.rotateX(-Math.PI / 2);
      const walls = b.k === 'range' ? wallRange : b.k === 'clubhouse' ? wallClub : wall;
      const roofMat = inCourse ? roofCourse : roofAround;
      const mesh = new THREE.Mesh(geo, [roofMat, walls]);
      mesh.position.y = bottom;
      scene.add(mesh);
      // casas: tejado a cuatro aguas (pirámide desde el centro), con la ortofoto como teja
      if (b.k === 'house') scene.add(hipRoof(THREE, b.p, top, roofMat, (x, y) => (inCourse
        ? [x / model.width, 1 - y / model.depth] : [(x - A.x) / A.w, 1 - (y - A.y) / A.h]), cx, cz));
    }

    // puente
    const br = C.bridge;
    if (br) {
      const a = { x: br.a[0], y: br.a[1] };
      const b = { x: br.b[0], y: br.b[1] };
      const L = GC.dist(a, b);
      const lake = C.water.map((w) => w.z).sort((p, q) => p - q)[0];
      const deckY = ((lake == null ? model.heightAt((a.x + b.x) / 2, (a.y + b.y) / 2) : lake) - model.base) * EXAG + 1.1;
      const group = new THREE.Group();
      const wood = new THREE.MeshLambertMaterial({ color: 0x9a7650 });
      const dark = new THREE.MeshLambertMaterial({ color: 0x5d4532 });
      const deck = new THREE.Mesh(new THREE.BoxGeometry(L, 0.35, br.w), wood);
      group.add(deck);
      for (const side of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(L, 0.12, 0.12), dark);
        rail.position.set(0, 1.1, side * (br.w / 2 - 0.1));
        group.add(rail);
        const n = Math.round(L / 2.5);
        for (let i = 0; i <= n; i++) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.1, 0.12), dark);
          post.position.set(-L / 2 + (L * i) / n, 0.55, side * (br.w / 2 - 0.1));
          group.add(post);
        }
      }
      group.position.set((a.x + b.x) / 2 - cx, deckY, (a.y + b.y) / 2 - cz);
      group.rotation.y = -Math.atan2(b.y - a.y, b.x - a.x);
      scene.add(group);
    }

    // árboles: tronco y copa con el color medido en la ortofoto
    const trees = C.trees;
    const crown = new THREE.IcosahedronGeometry(1, 1);
    const trunk = new THREE.CylinderGeometry(0.18, 0.26, 1, 6);
    const crowns = new THREE.InstancedMesh(crown, new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), trees.length);
    const trunks = new THREE.InstancedMesh(trunk, new THREE.MeshLambertMaterial({ color: 0x5a4632 }), trees.length);
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    const leaf = new THREE.Color(0x56763c);
    const rand = GC.rng(11);
    trees.forEach(([x, y, r, hex], i) => {
      const th = 1.2 + r * 0.7;
      const base = W(x, y);
      m4.makeScale(r * 0.9, th, r * 0.9).setPosition(base.x, base.y + th / 2, base.z);
      trunks.setMatrixAt(i, m4);
      const s = r * (0.95 + rand() * 0.1);
      m4.makeScale(s, s * (1.05 + rand() * 0.35), s).setPosition(base.x, base.y + th + s * 0.8, base.z);
      crowns.setMatrixAt(i, m4);
      col.set('#' + hex).lerp(leaf, 0.35).offsetHSL(0, 0.04, 0.04).convertSRGBToLinear();
      crowns.setColorAt(i, col);
    });
    scene.add(trunks, crowns);

    // banderas, números y tees
    const labels = { holes: [], pois: [] };
    const poleMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const flagMat = new THREE.MeshLambertMaterial({ color: 0xd8322a, side: THREE.DoubleSide });
    const teeMat = new THREE.MeshLambertMaterial({ color: 0xf2cf3c });
    for (const ho of model.holes) {
      const base = W(ho.pin.x, ho.pin.y);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 9, 6), poleMat);
      pole.position.copy(base).add(new THREE.Vector3(0, 4.5, 0));
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 2.4), flagMat);
      flag.position.copy(base).add(new THREE.Vector3(1.8, 7.8, 0));
      const label = textSprite(THREE, String(ho.raw.number), { round: true });
      label.position.copy(base).add(new THREE.Vector3(0, 10, 0));
      const tee = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 8), teeMat);
      tee.position.copy(W(ho.tee.x, ho.tee.y, 0.9));
      scene.add(pole, flag, label, tee);
      labels.holes.push(label);
    }
    for (const p of C.pois) {
      const sp = textSprite(THREE, p.name, {});
      sp.position.copy(W(p.x, p.y, p.h + 3));
      scene.add(sp);
      labels.pois.push(sp);
    }

    const ro = new ResizeObserver(() => resize(player));
    player.three = { renderer, scene, camera, labels, water: waterMat, ro };
    if (player.data) {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 10), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      ball.visible = false;
      scene.add(ball);
      player.three.ball = ball;
      player.three.groups = new Map();
    }
    ro.observe(player.container);
    resize(player);
  }

  // Textura de fachada de 3 × 3 m: pared y una ventana.
  function facade(THREE, wallColor, glass) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = wallColor;
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = glass;
    g.fillRect(18, 14, 28, 26);
    g.fillStyle = 'rgba(0,0,0,0.12)';
    g.fillRect(0, 60, 64, 4);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.encoding = THREE.sRGBEncoding;
    return t;
  }

  function hipRoof(THREE, p, top, mat, uv, cx, cz) {
    const area = polyArea(p);
    const c = p.reduce((a, q) => [a[0] + q[0] / p.length, a[1] + q[1] / p.length], [0, 0]);
    const rise = Math.min(2.6, 0.2 * Math.sqrt(area));
    const pos = [];
    const uvs = [];
    const ccw = p.reduce((a, q, i) => a + (p[(i + 1) % p.length][0] - q[0]) * (p[(i + 1) % p.length][1] + q[1]), 0) > 0;
    for (let i = 0; i < p.length; i++) {
      let a = p[i];
      let b = p[(i + 1) % p.length];
      if (!ccw) [a, b] = [b, a];
      for (const [q, y] of [[a, top], [c, top + rise], [b, top]]) {
        pos.push(q[0] - cx, y, q[1] - cz);
        uvs.push(...uv(q[0], q[1]));
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat);
    m.material.side = THREE.DoubleSide;
    return m;
  }

  function skyTexture(THREE) {
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 256;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0, '#7fa9cc');
    grd.addColorStop(0.55, '#cfe0e8');
    grd.addColorStop(1, '#e8eee8');
    g.fillStyle = grd;
    g.fillRect(0, 0, 2, 256);
    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    return t;
  }

  // Etiqueta siempre de cara a la cámara: número de hoyo (círculo) o nombre de una instalación (píldora).
  function textSprite(THREE, text, { round, size }) {
    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    const font = round ? "800 66px 'Barlow Condensed', 'Arial Narrow', sans-serif" : "700 44px 'Barlow', system-ui, sans-serif";
    g.font = font;
    const w = round ? 128 : Math.ceil(g.measureText(text).width) + 56;
    c.width = w;
    c.height = round ? 128 : 76;
    g.font = font;
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#0f3a24';
    g.lineWidth = round ? 8 : 5;
    g.beginPath();
    if (round) g.arc(64, 64, 56, 0, Math.PI * 2);
    else {
      const r = 34;
      g.moveTo(r + 3, 3);
      g.arcTo(w - 3, 3, w - 3, 73, r);
      g.arcTo(w - 3, 73, 3, 73, r);
      g.arcTo(3, 73, 3, 3, r);
      g.arcTo(3, 3, w - 3, 3, r);
    }
    g.fill();
    g.stroke();
    g.fillStyle = '#0f3a24';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, w / 2, round ? 68 : 40);
    const tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    // tamaño fijo en pantalla: legible de lejos y sin taparlo todo de cerca
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
    const h = round ? (size ? size * 0.008 : 0.05) : 0.042;
    sp.scale.set((h * c.width) / c.height, h, 1);
    sp.center.set(0.5, 0);
    sp.renderOrder = 10;
    return sp;
  }

  /*
   * Encuadre sin perder información. La ficha tapa la parte de abajo del vídeo (y las herramientas, la de arriba):
   * el centro de la imagen se lleva al hueco libre (desplazando la proyección) y la cámara se aleja, en su misma
   * dirección, hasta que todos los puntos importantes del plano (salida, llegada, vuelo, bandera) caben en ese hueco.
   */
  function freeArea(player) {
    const c = player.container;
    // offsetTop/offsetHeight: sin las animaciones de entrada (transform), que harían temblar la cámara
    const r = { width: c.clientWidth, height: c.clientHeight };
    let top = 10;
    let bottom = r.height - 10;
    for (const el of c.querySelectorAll('.tour-tools:not([hidden]), .replay-full, .tour-full')) {
      if (el.offsetParent === c && el.offsetTop < r.height / 3) top = Math.max(top, el.offsetTop + el.offsetHeight + 6);
    }
    const cap = c.querySelector('.tour-cap');
    if (cap && cap.textContent.trim() && !c.classList.contains('free-cam')) bottom = Math.min(bottom, cap.offsetTop - 6);
    const minH = r.height * 0.38; // con fichas muy altas (móvil) se acepta algo de solape antes que una franja mínima
    if (bottom - top < minH) bottom = Math.min(r.height - 10, top + minH);
    return { W: r.width, H: r.height, top, bottom };
  }

  const _v = { a: null };
  function frameShot(player, s) {
    const { camera } = player.three;
    const area = freeArea(player);
    if (!area.W || !area.H) return;
    // centro óptico en el centro del hueco libre
    const d = area.H / 2 - (area.top + area.bottom) / 2;
    if (Math.abs(d) > 1 && !player.free) camera.setViewOffset(area.W, area.H + 2 * Math.abs(d), 0, d > 0 ? 2 * d : 0, area.W, area.H);
    else camera.clearViewOffset();
    if (!s.fit || !s.fit.length || player.free) return;
    const THREE = global.THREE;
    const v = _v.a || (_v.a = new THREE.Vector3());
    const hy = ((area.bottom - area.top) / area.H) * 0.9; // medio alto del hueco en coordenadas normalizadas
    const hx = 0.88;
    const dir = s.pos.clone().sub(s.look);
    const fits = () => {
      camera.position.copy(s.pos);
      camera.lookAt(s.look);
      camera.updateMatrixWorld();
      for (const p of s.fit) {
        v.copy(p).applyMatrix4(camera.matrixWorldInverse);
        if (v.z > -1) return false; // detrás de la cámara
        v.applyMatrix4(camera.projectionMatrix);
        if (Math.abs(v.x) > hx || Math.abs(v.y) > hy) return false;
      }
      return true;
    };
    const base = dir.length();
    const max = s.maxPull || 6;
    for (let i = 0; i < 16 && !fits() && dir.length() < base * max; i++) {
      dir.multiplyScalar(1.12);
      s.pos.copy(s.look).add(dir);
    }
    // la niebla se aleja con la cámara para que lo encuadrado no quede borroso
    const fog = player.three.scene.fog;
    if (fog) {
      const dist = dir.length();
      fog.near = Math.max(650, dist * 0.9);
      fog.far = Math.max(1500, dist * 2.6);
    }
  }

  function resize(player) {
    const { renderer, camera } = player.three;
    const r = player.container.getBoundingClientRect();
    renderer.setSize(r.width, r.height, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = r.width / Math.max(1, r.height);
    camera.updateProjectionMatrix();
    if (!player.playing) render(player);
  }

  // ---------- guion de cámara ----------

  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  function segmentAt(player, t) {
    const { segs } = player;
    let i = segs.findIndex((s) => t < s.t0 + s.dur);
    if (i < 0) i = segs.length - 1;
    const s = segs[i];
    return { seg: i, s, k: GC.clamp((t - s.t0) / s.dur, 0, 1) };
  }

  function shot(player, t) {
    const THREE = global.THREE;
    const { model, W } = player;
    const { seg, s, k } = segmentAt(player, t);
    if (s.kind === 'play') return replayCam(player, seg, s, t - s.t0);
    if (s.kind === 'rintro') return replayOverview(player, seg, s.holes, k, true);
    if (s.kind === 'routro') return replayOverview(player, seg, s.holes, k, false);
    if (s.kind === 'intro' || s.kind === 'outro') {
      // vuelo alrededor del campo
      const center = new THREE.Vector3(0, 12, 20);
      const a = s.kind === 'intro' ? -2.2 + k * 1.3 : -0.9 + k * 0.8;
      const rad = s.kind === 'intro' ? 560 - k * 150 : 450 + k * 170;
      const hgt = s.kind === 'intro' ? 320 - k * 120 : 220 + k * 150;
      // todas las banderas a la vista
      const fit = model.holes.map((ho) => W(ho.pin.x, ho.pin.y, 15));
      return { pos: new THREE.Vector3(Math.cos(a) * rad, hgt, Math.sin(a) * rad), look: center, seg, sub: 0, fit, maxPull: 1.5 };
    }
    if (s.kind === 'club') {
      // una parada por instalación, girando despacio alrededor
      const n = model.club.length;
      const sub = Math.min(n - 1, Math.floor(k * n));
      const kk = k * n - sub;
      const st = model.club[sub];
      let ang = -2.4 + sub * 1.1 + kk * 0.55;
      if (st.from) ang = Math.atan2(st.from.y - st.at.y, st.from.x - st.at.x) + (kk - 0.5) * 0.5; // desde detrás de los puestos
      const p = { x: st.at.x + Math.cos(ang) * st.radius, y: st.at.y + Math.sin(ang) * st.radius };
      return { pos: W(p.x, p.y, st.height - kk * 6), look: W(st.at.x, st.at.y, 3), seg, sub, fit: (st.fit || []).map((q) => W(q[0], q[1], q[2])), maxPull: 2 };
    }
    const ho = model.holes[s.i];
    const L = GC.dist(ho.tee, ho.pin) || 1;
    const u = { x: (ho.pin.x - ho.tee.x) / L, y: (ho.pin.y - ho.tee.y) / L };
    const back = Math.max(40, L * 0.28);
    const e = ease(k);
    // de detrás del tee a la entrada del green
    const from = { x: ho.tee.x - u.x * back, y: ho.tee.y - u.y * back };
    const to = { x: ho.pin.x - u.x * Math.min(70, L * 0.45), y: ho.pin.y - u.y * Math.min(70, L * 0.45) };
    const px = from.x + (to.x - from.x) * e;
    const py = from.y + (to.y - from.y) * e;
    const lift = (42 + L * 0.15) * (1 - e) + 30 * e;
    const lookPt = { x: ho.tee.x + (ho.pin.x - ho.tee.x) * (0.55 + 0.45 * e), y: ho.tee.y + (ho.pin.y - ho.tee.y) * (0.55 + 0.45 * e) };
    // el green siempre; el tee mientras la cámara está detrás de él; y el número del hoyo sobre la bandera
    const fit = [W(ho.pin.x, ho.pin.y, 16), W(ho.pin.x, ho.pin.y, 0)];
    return { pos: W(px, py, lift), look: W(lookPt.x, lookPt.y, 2), seg, sub: 0, fit, maxPull: 1.6 };
  }

  function render(player) {
    if (!player.three) return;
    const { renderer, scene, camera, labels } = player.three;
    const s = shot(player, player.t);
    frameShot(player, s);
    const key = s.seg + ':' + s.sub;
    if (player.camPos && player.t - (player.lastT || 0) < 0.5 && player.camKey !== key) {
      // cambio de plano: deslizamiento rápido en lugar de corte seco
      player.camPos.lerp(s.pos, 0.12);
      player.camLook.lerp(s.look, 0.12);
      if (player.camPos.distanceTo(s.pos) < 3) player.camKey = key;
    } else {
      player.camPos = s.pos.clone();
      player.camLook = s.look.clone();
      player.camKey = key;
    }
    player.lastT = player.t;
    const kind = player.segs[s.seg].kind;
    labels.pois.forEach((l) => (l.visible = kind === 'intro' || kind === 'club' || kind === 'outro'));
    const only = kind === 'play' ? player.model.holes.indexOf(player.segs[s.seg].ho) : -1;
    labels.holes.forEach((l, i) => (l.visible = kind !== 'club' && (only < 0 || i === only)));
    if (player.data) drawReplay(player, s);
    if (player.free) {
      const f = player.free;
      const cp = Math.cos(f.pitch);
      camera.position.set(f.target.x + f.dist * cp * Math.sin(f.yaw), f.target.y + f.dist * Math.sin(f.pitch), f.target.z + f.dist * cp * Math.cos(f.yaw));
      camera.lookAt(f.target);
    } else {
      camera.position.copy(player.camPos);
      camera.lookAt(player.camLook);
    }
    if (player.data) keepBadgesInside(player);
    renderer.render(scene, camera);
    updateUi(player, s.seg, s.sub);
  }

  function loop(player) {
    if (!player.playing || player.disposed) return;
    if (!player.container.isConnected) {
      // se ha salido de la portada: queda en pausa
      player.playing = false;
      player.container.classList.replace('playing', 'paused');
      return;
    }
    const now = performance.now();
    player.t += Math.min(0.1, (now - player.last) / 1000);
    player.last = now;
    if (player.t >= player.duration) {
      player.t = player.duration;
      player.playing = false;
      render(player);
      player.container.classList.remove('playing');
      player.container.classList.add('ended');
      if (player.onEnd) player.onEnd();
      return;
    }
    render(player);
    requestAnimationFrame(() => loop(player));
  }

  function updateUi(player, seg, sub) {
    const c = player.container;
    const s = player.segs[seg];
    const key = seg + ':' + sub;
    if (player.uiKey !== key) {
      player.uiKey = key;
      if (player.onSegment) player.onSegment(s.kind === 'play' ? s.hd.n : null);
      if (s.kind === 'intro') caption(player, intro(player.model));
      else if (s.kind === 'rintro' || s.kind === 'routro') caption(player, s.cap);
      else if (s.kind === 'play') caption(player, s.steps[sub].cap);
      else if (s.kind === 'club') caption(player, player.model.club[sub].cap);
      else if (s.kind === 'outro') caption(player, {
        eyebrow: 'Golf Sotoverde', title: 'Buena vuelta', line: 'Apunta tus golpes hoyo a hoyo con Mis vueltas',
        chips: ['18 hoyos', 'Par 60'], tip: '',
      });
      else {
        const ho = player.model.holes[s.i];
        const i = ho.info;
        caption(player, {
          eyebrow: `Hoyo ${ho.raw.number} de ${player.model.holes.length}`,
          title: `Hoyo ${ho.raw.number}`,
          line: `Par ${i.par} · ${i.meters} m · Hándicap ${i.si}`,
          chips: i.chips,
          tip: i.tip,
        });
      }
    }
    const k = GC.clamp((player.t - s.t0) / s.dur, 0, 1);
    c.classList.toggle('in-play', s.kind === 'play');
    c.querySelectorAll('.tour-prog span').forEach((el, idx) => {
      const fill = idx < seg ? 1 : idx === seg ? k : 0;
      el.firstChild.style.transform = `scaleX(${fill})`;
      el.classList.toggle('on', idx === seg);
    });
    c.querySelector('.tour-prog').setAttribute('aria-valuenow', String(Math.round((100 * player.t) / player.duration)));
    const tg = c.querySelector('[data-a="toggle"]');
    tg.textContent = player.playing ? '❚❚' : '▶';
    tg.setAttribute('aria-label', player.playing ? 'Pausa' : 'Reproducir');
  }

  function caption(player, d) {
    const el = player.container.querySelector('.tour-cap');
    const lie = d.lie ? `<span class="t-lie lie-${d.lie.k}"><img alt="" src="${lieIconUrl(d.lie.k)}">${d.lie.name}</span>` : '';
    el.innerHTML = `<span class="eyebrow">${d.eyebrow}</span><div class="t-head"><b class="t-title">${d.title}</b>${lie}</div>
      <div class="t-line">${d.line}</div>
      ${d.chips.length ? `<div class="t-chips">${d.chips.map((c) => `<span>${c}</span>`).join('')}</div>` : ''}
      ${d.tip ? `<p class="t-tip">${d.tip}</p>` : ''}`;
    el.classList.remove('in');
    void el.offsetWidth;
    el.classList.add('in');
  }

  function seekSeg(player, seg) {
    const i = GC.clamp(seg, 0, player.segs.length - 1);
    player.t = Math.min(player.duration - 0.01, player.segs[i].t0);
    player.camPos = null;
    player.container.classList.remove('ended', 'paused');
    if (!player.three) {
      start(player);
      return;
    }
    if (!player.playing) {
      player.playing = true;
      player.last = performance.now();
      player.container.classList.add('playing');
      loop(player);
    }
  }

  function action(player, a) {
    const { seg } = segmentAt(player, player.t);
    if (a === 'toggle') {
      if (player.playing) {
        player.playing = false;
        player.container.classList.replace('playing', 'paused');
        render(player);
      } else start(player);
    } else if (player.data && (a === 'next' || a === 'prev')) stepShot(player, a === 'next' ? 1 : -1);
    else if (a === 'next') seekSeg(player, seg + 1);
    else if (a === 'prev') seekSeg(player, seg - 1);
  }

  // ---------- iconos del lie (calle, rough, búnker, green, agua, fuera, tee) ----------

  // Dibuja el icono en un círculo de diámetro s con esquina superior izquierda en (x, y).
  function drawLieIcon(g, lie, x, y, s) {
    const k = s / 128;
    g.save();
    g.translate(x, y);
    g.scale(k, k);
    g.beginPath();
    g.arc(64, 64, 60, 0, Math.PI * 2);
    g.save();
    g.clip();
    const ball = (bx, by, r = 13) => {
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.beginPath();
      g.ellipse(bx + 3, by + r * 0.8, r, r * 0.45, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(bx, by, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(0,0,0,0.12)';
      for (const [dx, dy] of [[-4, -3], [3, -5], [5, 2], [-2, 4], [-6, 3]]) {
        g.beginPath();
        g.arc(bx + dx, by + dy, 1.6, 0, Math.PI * 2);
        g.fill();
      }
    };
    if (lie === 'fairway' || lie === 'tee') {
      // césped segado a franjas
      for (let i = -4; i < 8; i++) {
        g.fillStyle = i % 2 ? '#6fbf4a' : '#86d35d';
        g.beginPath();
        g.moveTo(i * 24, 0);
        g.lineTo(i * 24 + 24, 0);
        g.lineTo(i * 24 + 24 + 60, 128);
        g.lineTo(i * 24 + 60, 128);
        g.fill();
      }
      if (lie === 'tee') {
        g.fillStyle = '#d9a35b';
        g.beginPath();
        g.moveTo(52, 70);
        g.lineTo(76, 70);
        g.lineTo(68, 78);
        g.lineTo(66, 108);
        g.lineTo(62, 108);
        g.lineTo(60, 78);
        g.fill();
        ball(64, 56, 15);
      } else ball(64, 66, 15);
    } else if (lie === 'rough') {
      g.fillStyle = '#3f7f2f';
      g.fillRect(0, 0, 128, 128);
      ball(64, 72, 15);
      // hierba alta por delante de la bola
      const rand = GC.rng(5);
      for (let i = 0; i < 42; i++) {
        const bx = rand() * 128;
        const by = 40 + rand() * 95;
        g.strokeStyle = rand() < 0.5 ? '#2c6322' : '#5aa040';
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(bx, by);
        g.quadraticCurveTo(bx + 4, by - 16, bx + (rand() - 0.5) * 14, by - 26 - rand() * 14);
        g.stroke();
      }
    } else if (lie === 'sand') {
      g.fillStyle = '#ecd59a';
      g.fillRect(0, 0, 128, 128);
      g.strokeStyle = 'rgba(160,120,60,0.45)';
      g.lineWidth = 3;
      for (let i = 0; i < 9; i++) {
        g.beginPath();
        g.moveTo(-10, 14 + i * 14);
        g.bezierCurveTo(40, 4 + i * 14, 80, 26 + i * 14, 140, 12 + i * 14);
        g.stroke();
      }
      ball(64, 70, 15);
    } else if (lie === 'green') {
      g.fillStyle = '#9ee07a';
      g.fillRect(0, 0, 128, 128);
      g.fillStyle = '#7cc95c';
      g.beginPath();
      g.arc(64, 64, 40, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#1d2b20';
      g.beginPath();
      g.ellipse(58, 90, 13, 6, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#f4f4f4';
      g.fillRect(56, 28, 4, 62);
      g.fillStyle = '#d8322a';
      g.beginPath();
      g.moveTo(60, 28);
      g.lineTo(90, 38);
      g.lineTo(60, 48);
      g.fill();
      ball(86, 92, 10);
    } else if (lie === 'water') {
      g.fillStyle = '#2f86c9';
      g.fillRect(0, 0, 128, 128);
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.lineWidth = 6;
      g.lineCap = 'round';
      for (const yy of [44, 68, 92]) {
        g.beginPath();
        for (let xx = 10; xx <= 118; xx += 4) {
          const yv = yy + Math.sin(xx / 9) * 5;
          if (xx === 10) g.moveTo(xx, yv);
          else g.lineTo(xx, yv);
        }
        g.stroke();
      }
    } else if (lie === 'ob') {
      g.fillStyle = '#56704a';
      g.fillRect(0, 0, 128, 128);
      g.fillStyle = '#ffffff';
      g.fillRect(56, 22, 16, 92);
      g.fillStyle = '#1f2a22';
      g.fillRect(56, 22, 16, 10);
      g.strokeStyle = '#d8322a';
      g.lineWidth = 6;
      g.beginPath();
      g.moveTo(24, 24);
      g.lineTo(104, 104);
      g.moveTo(104, 24);
      g.lineTo(24, 104);
      g.stroke();
    } else {
      g.fillStyle = '#6fbf4a';
      g.fillRect(0, 0, 128, 128);
      ball(64, 64, 15);
    }
    g.restore();
    g.lineWidth = 6;
    g.strokeStyle = '#ffffff';
    g.beginPath();
    g.arc(64, 64, 60, 0, Math.PI * 2);
    g.stroke();
    g.restore();
  }

  const iconCache = {};
  function lieIconUrl(lie) {
    if (!iconCache[lie]) {
      const c = document.createElement('canvas');
      c.width = c.height = 96;
      drawLieIcon(c.getContext('2d'), lie, 0, 0, 96);
      iconCache[lie] = c.toDataURL('image/png');
    }
    return iconCache[lie];
  }

  // Marca en 3D donde quedó la bola: el icono del lie con el número del golpe.
  function lieSprite(THREE, lie, n) {
    const c = document.createElement('canvas');
    c.width = c.height = 160;
    const g = c.getContext('2d');
    drawLieIcon(g, lie, 8, 24, 128);
    g.fillStyle = '#0f3a24';
    g.strokeStyle = '#ffffff';
    g.lineWidth = 6;
    g.beginPath();
    g.arc(124, 36, 30, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = '#ffffff';
    g.font = "800 40px 'Barlow Condensed', 'Arial Narrow', sans-serif";
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(n), 124, 39);
    const tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sp.scale.set(5.2, 5.2, 1);
    sp.renderOrder = 11;
    return sp;
  }

  /*
   * Etiqueta de un golpe con tamaño constante en pantalla (se lee igual de cerca que de lejos): icono del lie,
   * número del golpe y, en la versión completa, «PW · 41 m». Se apoya sobre su punto (center 0.5, 0).
   */
  function badgeSprite(THREE, { lie, n, text }) {
    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    const H = 96;
    const font = "800 46px 'Barlow Condensed', 'Arial Narrow', sans-serif";
    g.font = font;
    const tw = text ? Math.ceil(g.measureText(text).width) + 26 : 0;
    const W = 8 + 80 + 6 + 46 + (text ? tw : 8) + 8;
    c.width = W;
    c.height = H + 18;
    g.font = font;
    // píldora con piquito hacia el punto
    const r = H / 2;
    g.fillStyle = 'rgba(255,255,255,0.96)';
    g.strokeStyle = 'rgba(15,58,36,0.9)';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(r, 2);
    g.lineTo(W - r, 2);
    g.arc(W - r, r, r - 2, -Math.PI / 2, Math.PI / 2);
    g.lineTo(W / 2 + 12, H - 2);
    g.lineTo(W / 2, H + 14);
    g.lineTo(W / 2 - 12, H - 2);
    g.lineTo(r, H - 2);
    g.arc(r, r, r - 2, Math.PI / 2, -Math.PI / 2);
    g.closePath();
    g.fill();
    g.stroke();
    drawLieIcon(g, lie, 8, 8, 80);
    g.fillStyle = '#0f3a24';
    g.beginPath();
    g.arc(8 + 80 + 6 + 23, r, 23, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = "800 34px 'Barlow Condensed', 'Arial Narrow', sans-serif";
    g.fillText(String(n), 8 + 80 + 6 + 23, r + 2);
    if (text) {
      g.fillStyle = '#0f3a24';
      g.textAlign = 'left';
      g.font = font;
      g.fillText(text, 8 + 80 + 6 + 46 + 12, r + 3);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = 4;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
    const h = 0.075; // ~9 % del alto de la pantalla
    sp.scale.set((h * c.width) / c.height, h, 1);
    sp.center.set(0.5, 0);
    sp.renderOrder = 12;
    return sp;
  }

  // Punto de la bola de tamaño constante (se ve aunque la cámara esté lejos).
  function ballDot(THREE) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.beginPath();
    g.arc(32, 32, 30, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(32, 32, 20, 0, Math.PI * 2);
    g.fill();
    const tex = new THREE.CanvasTexture(c);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
    sp.scale.set(0.024, 0.024, 1);
    sp.renderOrder = 13;
    return sp;
  }

  // ---------- repetición de una vuelta o de un hoyo, con los golpes dibujados ----------

  const RP = { rintro: 5.5, approach: 2.4, shot: 4.2, drop: 2.4, putts: 3.2, end: 3.2, card: 5, routro: 5.5 };
  // Fases de un golpe (fracción del tramo): preparación detrás de la bola, vuelo y plano final del golpe entero.
  const PRE = 0.12;
  const FLY_END = 0.6;
  const LIE_COLOR = { fairway: 0xffffff, rough: 0xf0d77a, sand: 0xf6e7b6, green: 0xb9f58f, water: 0x4aa8e8, ob: 0xff5a45, tee: 0xffffff };

  /*
   * data: { intro?, outro?: caption, holes: [{ n, header, end: caption, steps: [{ kind: 'shot'|'drop'|'putts',
   *   from, to, path?, lie?, cap }] }] } con los puntos en metros del hoyo (como en campos/*.json).
   */
  function replay(container, data, opts = {}) {
    const model = GC.COURSE_3D ? courseModel() : holesModel();
    const segs = [];
    const holes = [];
    data.holes.forEach((hd) => {
      const ho = model.holes.find((x) => x.raw.number === hd.n);
      if (!ho) return;
      holes.push(ho);
      const steps = [{ kind: 'approach', dur: RP.approach, cap: hd.header }];
      hd.steps.forEach((st) => steps.push({
        ...st, dur: RP[st.kind], A: ho.to(st.from), B: ho.to(st.to), P: st.path && st.path.length > 1 ? st.path.map(ho.to) : null,
      }));
      steps.push({ kind: 'end', dur: hd.steps.length ? RP.end : RP.card, cap: hd.end });
      let t = 0;
      steps.forEach((st) => {
        st.t0 = t;
        t += st.dur;
      });
      segs.push({ kind: 'play', ho, hd, steps, dur: t, title: `Hoyo ${hd.n}` });
    });
    if (data.intro) segs.unshift({ kind: 'rintro', dur: RP.rintro, cap: data.intro, holes, title: 'Resumen' });
    if (data.outro) segs.push({ kind: 'routro', dur: RP.routro, cap: data.outro, holes, title: 'Final' });
    let t = 0;
    segs.forEach((s) => {
      s.t0 = t;
      t += s.dur;
    });
    const mins = t / 60;
    return makePlayer(container, model, segs, t, {
      ...opts, data, button: opts.button || 'Resumen 3D',
      sub: `${mins < 1 ? `${Math.round(t)} s` : `${Math.round(mins)} min`} · ${holes.length} hoyo${holes.length === 1 ? '' : 's'}`,
      first: data.intro || (segs[0] && segs[0].steps ? segs[0].steps[0].cap : { eyebrow: '', title: '', line: '', chips: [] }),
    });
  }

  // Trayectoria en 3D: la línea trazada (o recta) en planta y una parábola encima; los putts van por el suelo.
  function flightCurve(player, st, putt) {
    const THREE = global.THREE;
    const { W } = player;
    const n = 48;
    let plan;
    if (st.P) {
      // repartir la línea trazada en n puntos por longitud, empezando y acabando en la bola
      const pts = [st.A].concat(st.P, [st.B]);
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + GC.dist(pts[i - 1], pts[i]));
      const L = cum[cum.length - 1] || 1;
      plan = [];
      for (let i = 0, j = 0; i < n; i++) {
        const d = (L * i) / (n - 1);
        while (j < pts.length - 2 && cum[j + 1] < d) j++;
        const f = (d - cum[j]) / (cum[j + 1] - cum[j] || 1);
        plan.push({ x: pts[j].x + (pts[j + 1].x - pts[j].x) * f, y: pts[j].y + (pts[j + 1].y - pts[j].y) * f });
      }
    } else {
      // sin trazo: recta con la curva del vuelo habitual (st.bow, metros a la derecha en el punto medio)
      const d0 = GC.dist(st.A, st.B) || 1;
      const rx = -(st.B.y - st.A.y) / d0;
      const ry = (st.B.x - st.A.x) / d0;
      plan = Array.from({ length: n }, (_, i) => {
        const t = i / (n - 1);
        const b = (st.bow || 0) * Math.sin(Math.PI * t);
        return { x: st.A.x + (st.B.x - st.A.x) * t + rx * b, y: st.A.y + (st.B.y - st.A.y) * t + ry * b };
      });
    }
    const d = GC.dist(st.A, st.B);
    const apex = putt ? 0 : st.apex != null ? st.apex : d < 35 ? Math.max(1.5, d * 0.22) : Math.min(34, 6 + d * 0.13);
    const ya = W(st.A.x, st.A.y).y;
    const yb = W(st.B.x, st.B.y).y;
    return plan.map((p, i) => {
      const t = i / (n - 1);
      const tt = t < 0.58 ? (t / 0.58) * 0.5 : 0.5 + ((t - 0.58) / 0.42) * 0.5; // el vértice, algo pasada la mitad
      const ground = W(p.x, p.y).y;
      const y = putt ? ground + 0.25 : Math.max(ground + 0.3, ya + (yb - ya) * t + apex * Math.sin(Math.PI * tt));
      return new THREE.Vector3(W(p.x, p.y).x, y, W(p.x, p.y).z);
    });
  }

  function replayGroup(player, seg) {
    const THREE = global.THREE;
    const { scene, groups } = player.three;
    if (groups.has(seg)) return groups.get(seg);
    const s = player.segs[seg];
    const group = new THREE.Group();
    let k = 0;
    const items = s.steps.map((st) => {
      if (st.kind !== 'shot' && st.kind !== 'drop' && st.kind !== 'putts') return null;
      if (st.kind !== 'putts') k++;
      const putt = st.kind === 'putts';
      const pts = st.kind === 'drop' ? [player.W(st.A.x, st.A.y, 0.4), player.W(st.B.x, st.B.y, 0.4)] : flightCurve(player, st, putt);
      const it = { pts, tubes: [], marker: null, full: null, mini: null, shadow: null };
      if (st.kind !== 'putts' && GC.dist(st.A, st.B) > 0.5) {
        // sombra de la trayectoria en el suelo (discontinua): ayuda a leer hacia dónde fue
        const ground = pts.map((p) => new THREE.Vector3(p.x, 0, p.z)).map((p) => {
          const wx = p.x + player.model.width / 2;
          const wz = p.z + player.model.depth / 2;
          return new THREE.Vector3(p.x, (player.model.heightAt(wx, wz) - player.model.base) * EXAG + 0.25, p.z);
        });
        const geo = new THREE.BufferGeometry().setFromPoints(ground);
        const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0x0b1f12, dashSize: 1.6, gapSize: 1.1, transparent: true, opacity: 0.55, depthWrite: false }));
        line.computeLineDistances();
        line.renderOrder = 4;
        it.shadow = line;
        group.add(line);
      }
      if (st.kind !== 'drop' && GC.dist(st.A, st.B) > 0.5) {
        const curve = new THREE.CatmullRomCurve3(pts);
        const color = putt ? 0xffffff : st.lie === 'water' || st.lie === 'ob' ? 0xff6b55 : 0xfff1a6;
        const dd = GC.dist(st.A, st.B);
        const core = putt ? 0.06 : GC.clamp(dd * 0.0022, 0.07, 0.3);
        for (const [r, op] of putt ? [[core, 0.95]] : [[core, 0.95], [core * 2.6, 0.16]]) {
          const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 96, r, 6, false),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: op, depthWrite: false }));
          tube.renderOrder = 5;
          it.tubes.push(tube);
          group.add(tube);
        }
      }
      {
        const end = player.W(st.B.x, st.B.y, 0.25);
        const rs = GC.clamp(GC.dist(st.A, st.B) * 0.012, 0.25, 1);
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.9 * rs, 1.5 * rs, 24), new THREE.MeshBasicMaterial({
          color: LIE_COLOR[st.lie] || 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.copy(end);
        const top = end.clone().add(new THREE.Vector3(0, Math.max(0.8, 3 * rs), 0));
        const stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([end, top]), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
        const num = putt ? 'P' : String(k);
        it.full = badgeSprite(THREE, { lie: putt ? 'green' : st.lie, n: num, text: st.label || '' });
        it.mini = badgeSprite(THREE, { lie: putt ? 'green' : st.lie, n: num, text: '' });
        it.full.position.copy(top);
        it.mini.position.copy(top);
        it.mini.scale.multiplyScalar(0.8);
        it.marker = new THREE.Group();
        it.marker.add(ring, stem, it.full, it.mini);
        group.add(it.marker);
      }
      return it;
    });
    // golpes del mismo hoyo en otras vueltas, en azul tenue (se ven con «Otras vueltas»)
    const others = new THREE.Group();
    for (const o of s.hd.others || []) {
      for (const sh of o.shots) {
        const st = { A: s.ho.to(sh.from), B: s.ho.to(sh.to), P: sh.path && sh.path.length > 1 ? sh.path.map(s.ho.to) : null };
        if (GC.dist(st.A, st.B) < 1) continue;
        const pts = flightCurve(player, st, false);
        const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 64, 0.22, 5, false),
          new THREE.MeshBasicMaterial({ color: sh.lie === 'water' || sh.lie === 'ob' ? 0xff9c8c : 0x9fd0ff, transparent: true, opacity: 0.6, depthWrite: false }));
        tube.renderOrder = 4;
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 6), new THREE.MeshBasicMaterial({ color: 0x9fd0ff }));
        dot.position.copy(player.W(st.B.x, st.B.y, 0.5));
        others.add(tube, dot);
      }
    }
    others.visible = !!player.showOthers;
    group.add(others);
    scene.add(group);
    const g = { group, items, others };
    groups.set(seg, g);
    return g;
  }

  function stepAt(s, lt) {
    let j = s.steps.findIndex((st) => lt < st.t0 + st.dur);
    if (j < 0) j = s.steps.length - 1;
    return { j, st: s.steps[j], k: GC.clamp((lt - s.steps[j].t0) / s.steps[j].dur, 0, 1) };
  }

  // Las etiquetas cerca del borde se desplazan hacia dentro (el palito sigue marcando el punto).
  function keepBadgesInside(player) {
    const THREE = global.THREE;
    const { camera, groups } = player.three;
    const g = groups.get(segmentAt(player, player.t).seg);
    if (!g) return;
    const v = new THREE.Vector3();
    camera.updateMatrixWorld();
    for (const it of g.items) {
      if (!it || !it.marker || !it.marker.visible) continue;
      for (const sp of [it.full, it.mini]) {
        if (!sp.visible) continue;
        v.copy(sp.position).project(camera);
        const halfW = sp.scale.x / 2 / (Math.tan((camera.fov * Math.PI) / 360) * camera.aspect); // medio ancho en coordenadas normalizadas
        const over = Math.max(0, v.x + halfW - 0.97) - Math.max(0, -0.97 - (v.x - halfW));
        sp.center.x = GC.clamp(0.5 + over / (2 * halfW || 1), 0.06, 0.94);
      }
    }
  }

  // Avance del vuelo (0-1) dentro del tramo de un golpe.
  const flyK = (st, k) => (st.kind === 'drop' ? GC.clamp(k / 0.5, 0, 1) : GC.clamp((k - PRE) / (FLY_END - PRE), 0, 1));

  function drawReplay(player, sh) {
    const THREE = global.THREE;
    const { groups, ball } = player.three;
    if (!player.three.dot) {
      player.three.dot = ballDot(THREE);
      player.three.scene.add(player.three.dot);
    }
    const dot = player.three.dot;
    const s = player.segs[sh.seg];
    groups.forEach((g, key) => (g.group.visible = key === sh.seg));
    if (s.kind !== 'play') {
      ball.visible = dot.visible = false;
      return;
    }
    const g = replayGroup(player, sh.seg);
    g.group.visible = true;
    g.others.visible = !!player.showOthers;
    const { j, k } = stepAt(s, player.t - s.t0);
    // la etiqueta completa: la del golpe en curso (o la del último al ver el hoyo entero)
    const lastShot = s.steps.reduce((a, st, i) => (g.items[i] && i <= j ? i : a), -1);
    s.steps.forEach((st, i) => {
      const it = g.items[i];
      if (!it) return;
      const f = i < j ? 1 : i > j ? 0 : flyK(st, k);
      const dim = i < j && s.steps[j].kind !== 'end' ? 0.3 : 1; // los golpes ya vistos, más tenues
      it.tubes.forEach((tube, ti) => {
        const n = tube.geometry.index.count;
        tube.geometry.setDrawRange(0, Math.floor((n * f) / 36) * 36);
        tube.visible = f > 0 && !(ti > 0 && dim < 1);
        tube.material.opacity = (ti ? 0.16 : 0.95) * dim;
      });
      if (it.shadow) {
        it.shadow.geometry.setDrawRange(0, Math.max(2, Math.floor(it.pts.length * f)));
        it.shadow.visible = f > 0;
      }
      if (it.marker) {
        it.marker.visible = f >= 1;
        const full = i === lastShot && s.steps[j].kind !== 'end'; // en la vista del hoyo entero, solo las compactas
        it.full.visible = full;
        it.mini.visible = !full;
      }
    });
    // la bola: volando en el golpe actual; si no, donde quedó el último golpe (o en el tee)
    const cur = s.steps[j];
    const it = g.items[j];
    let ballPos = null;
    if (it && cur.kind === 'drop') ballPos = k < 0.25 ? it.pts[0] : it.pts[1];
    else if (it) {
      const q = flyK(cur, k) * (it.pts.length - 1);
      const a = Math.floor(q);
      ballPos = it.pts[a].clone().lerp(it.pts[Math.min(it.pts.length - 1, a + 1)], q - a);
    } else {
      const prev = s.steps.filter((st, i) => i < j && g.items[i]).pop();
      const first = s.steps.find((st) => st.A);
      const p = prev ? prev.B : first ? first.A : null;
      if (p) ballPos = player.W(p.x, p.y, 0.6);
    }
    const show = !!ballPos && !(cur.kind === 'end' && s.hd.holed);
    ball.visible = dot.visible = show;
    if (ballPos) {
      ball.position.copy(ballPos);
      dot.position.copy(ballPos);
    }
    player.ballPos = ballPos;
  }

  function replayCam(player, seg, s, lt) {
    const { W } = player;
    const { j, st, k } = stepAt(s, lt);
    const ho = s.ho;
    if (st.kind === 'shot' || st.kind === 'drop' || st.kind === 'putts') {
      const THREE = global.THREE;
      const A = st.A;
      const B = st.kind === 'drop' && GC.dist(st.A, st.B) < 1 ? ho.pin : st.B;
      const d = Math.max(8, GC.dist(A, B));
      const u = { x: (B.x - A.x) / d, y: (B.y - A.y) / d };
      const r = { x: -u.y, y: u.x };
      const it = player.three && player.three.groups && player.three.groups.get(seg) ? player.three.groups.get(seg).items[j] : null;
      const apex = it && it.pts.length > 2 ? it.pts.reduce((a, p) => (p.y > a.y ? p : a), it.pts[0]) : W((A.x + B.x) / 2, (A.y + B.y) / 2, 4);
      const endFit = [W(A.x, A.y, 1), W(st.B.x, st.B.y, 1), W(st.B.x, st.B.y, 9), apex];
      if (st.kind === 'putts') endFit.push(W(ho.pin.x, ho.pin.y, 4));
      // 1) detrás de la bola, bajo, mirando hacia donde va
      const back = st.kind === 'putts' ? 14 + d * 0.8 : 16 + d * 0.18;
      const low = st.kind === 'putts' ? 8 + d * 0.2 : 9 + d * 0.1;
      const camA = W(A.x - u.x * back, A.y - u.y * back, low);
      const lookA = W(A.x + u.x * Math.min(d, 60) * 0.5, A.y + u.y * Math.min(d, 60) * 0.5, 2);
      // 3) plano final: desde un lado y algo atrás, alto, con el golpe entero a la vista
      const side = (st.bow || 0) > 0 ? -1 : 1;
      const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
      const dc = Math.max(d, 18);
      const camC = W(mid.x - u.x * dc * 0.55 + r.x * side * dc * 0.45, mid.y - u.y * dc * 0.55 + r.y * side * dc * 0.45, 8 + dc * 0.35);
      const lookC = W(mid.x + u.x * d * 0.12, mid.y + u.y * d * 0.12, 2);
      if (st.kind === 'putts' || st.kind === 'drop') {
        // putts y drops: desde un lado y en alto, con la bola y su destino en el mismo plano
        const pd = Math.max(d, st.kind === 'drop' ? 14 : 3);
        const pos = W(A.x - u.x * pd * 0.9 + r.x * pd * 1.6, A.y - u.y * pd * 0.9 + r.y * pd * 1.6, 6 + pd * 1.2);
        const to = st.kind === 'drop' ? st.B : ho.pin;
        return { pos, look: W((A.x + to.x) / 2, (A.y + to.y) / 2, 0.5), seg, sub: j, fit: endFit, maxPull: 3 };
      }
      if (k < PRE) return { pos: camA, look: lookA, seg, sub: j, fit: [W(A.x, A.y, 1)], maxPull: 2 };
      if (k < FLY_END && st.kind !== 'drop') {
        // 2) en vuelo: la cámara sube hacia el plano final y sigue a la bola
        const e = ease((k - PRE) / (FLY_END - PRE));
        const pos = camA.clone().lerp(camC, e * 0.85);
        const ballP = player.ballPos ? player.ballPos.clone() : lookA;
        const look = ballP.lerp(lookC, 0.25 + 0.35 * e);
        return { pos, look, seg, sub: j, fit: [player.ballPos ? player.ballPos.clone() : lookA, W(st.B.x, st.B.y, 1)], maxPull: 3 };
      }
      const e = ease(GC.clamp((k - FLY_END) / (1 - FLY_END), 0, 1));
      const pos = camA.clone().lerp(camC, 0.85 + 0.15 * e);
      return { pos, look: lookC, seg, sub: j, fit: endFit };
    }
    // presentación y cierre del hoyo: vista de todo el hoyo desde detrás del tee
    const L = GC.dist(ho.tee, ho.pin) || 1;
    const u = { x: (ho.pin.x - ho.tee.x) / L, y: (ho.pin.y - ho.tee.y) / L };
    const mid = { x: (ho.tee.x + ho.pin.x) / 2, y: (ho.tee.y + ho.pin.y) / 2 };
    const e = ease(k);
    const back = st.kind === 'end' ? L * (0.55 - 0.1 * e) + 30 : L * (0.75 - 0.25 * e) + 30;
    const lift = st.kind === 'end' ? L * 0.55 + 35 : L * (0.5 - 0.15 * e) + 35;
    const side = st.kind === 'end' ? (L * 0.2 + 15) * (e - 0.5) : 0;
    const pos = W(mid.x - u.x * back - u.y * side, mid.y - u.y * back + u.x * side, lift);
    // todo el hoyo: tee, bandera y cada bola del hoyo
    const fit = [W(ho.tee.x, ho.tee.y, 1), W(ho.pin.x, ho.pin.y, 9)];
    for (const x of s.steps) if (x.B) fit.push(W(x.B.x, x.B.y, 5));
    return { pos, look: W(mid.x + u.x * L * 0.08, mid.y + u.y * L * 0.08, 0), seg, sub: j, fit };
  }

  // Resumen: vuelo alto sobre los hoyos jugados.
  function replayOverview(player, seg, holes, k, opening) {
    const pts = holes.flatMap((ho) => [ho.tee, ho.pin]);
    const c = pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length }), { x: 0, y: 0 });
    const span = Math.max(150, ...pts.map((p) => GC.dist(p, c))) * 1.25;
    const a = (opening ? -2.0 : -0.6) + k * 0.7;
    const pos = player.W(c.x + Math.cos(a) * span, c.y + Math.sin(a) * span, span * 0.7);
    return { pos, look: player.W(c.x, c.y, 0), seg, sub: 0, fit: pts.map((p) => player.W(p.x, p.y, 4)) };
  }

  function pause(player) {
    if (!player.playing) return;
    player.playing = false;
    player.container.classList.replace('playing', 'paused');
    render(player);
  }

  GC.STROKE_INDEX = STROKE_INDEX;
  // Ir a un instante concreto y dibujarlo (pruebas y capturas).
  function seek(player, t) {
    player.t = GC.clamp(t, 0, player.duration);
    player.camPos = null;
    render(player);
    render(player); // la cámara usa la posición de la bola del fotograma anterior
  }

  GC.Tour = { mount, replay, dispose, pause, seek, holeInfo, courseModel, lieIconUrl };
})(typeof window !== 'undefined' ? window : globalThis);
