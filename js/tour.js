/*
 * Recorrido 3D del campo para la portada: un "vídeo" generado en el navegador con three.js.
 * Relieve real (MDT05 del IGN), textura compuesta con los 18 hoyos, árboles en 3D y banderas.
 * La cámara sobrevuela el campo y visita cada hoyo del tee al green con su ficha.
 */
(function (global) {
  'use strict';
  const GC = (global.GC = global.GC || {});

  const THREE_URLS = ['https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js', 'vendor/three.min.js'];
  // Hándicap de cada hoyo (tarjeta del club).
  const STROKE_INDEX = { 1: 16, 2: 9, 3: 8, 4: 13, 5: 11, 6: 3, 7: 18, 8: 6, 9: 2, 10: 10, 11: 17, 12: 12, 13: 15, 14: 1, 15: 14, 16: 4, 17: 5, 18: 7 };
  // Lo que no se deduce de la recta tee-bandera: el hoyo 6 gira en el plano del club.
  const NOTES = { 6: ['Dog-leg'] };
  const EXAG = 1.6; // exageración vertical del relieve
  const INTRO = 8;
  const PER_HOLE = 6.5;
  const OUTRO = 5;

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

  function courseModel() {
    const C = GC.COURSE_3D;
    const [X0, Y1] = C.origin;
    const heights = C.dm.map((v) => C.base + v / 10);
    const heightAt = (x, y) => {
      const fx = GC.clamp((x - C.cell / 2) / C.cell, 0, C.cols - 1);
      const fy = GC.clamp((y - C.cell / 2) / C.cell, 0, C.rows - 1);
      const i = Math.min(Math.floor(fx), C.cols - 2);
      const j = Math.min(Math.floor(fy), C.rows - 2);
      const u = fx - i;
      const v = fy - j;
      const at = (a, b) => heights[b * C.cols + a];
      return at(i, j) * (1 - u) * (1 - v) + at(i + 1, j) * u * (1 - v) + at(i, j + 1) * (1 - u) * v + at(i + 1, j + 1) * u * v;
    };
    const holes = (GC.COURSE_HOLES || []).slice().sort((a, b) => a.number - b.number).map((raw) => {
      const h = GC.prepareHole(raw, 'amarillas');
      const ox = raw.geo.origin[0] - X0;
      const oy = Y1 - raw.geo.origin[1];
      const to = (p) => ({ x: p.x + ox, y: p.y + oy });
      return { raw, h, ox, oy, to, tee: to(h.tee), pin: to(h.pin), info: holeInfo(raw, h) };
    });
    const mins = Math.min(...heights);
    return { C, X0, Y1, heightAt, holes, base: mins, width: (C.cols - 1) * C.cell, depth: (C.rows - 1) * C.cell };
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

  // ---------- textura del campo (vista cenital de los 18 hoyos) ----------

  function courseTexture(model, pxPerM) {
    const { C, holes } = model;
    const W = Math.round(model.width * pxPerM);
    const H = Math.round(model.depth * pxPerM);
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.scale(pxPerM, pxPerM);
    ctx.translate(-C.cell / 2, -C.cell / 2); // la malla va de centro a centro de celda
    // alrededores
    ctx.fillStyle = '#c3bf9c';
    ctx.fillRect(0, 0, model.width + C.cell, model.depth + C.cell);
    const rand = GC.rng(7);
    for (let i = 0; i < 9000; i++) {
      ctx.fillStyle = rand() < 0.5 ? 'rgba(120,110,70,0.18)' : 'rgba(230,225,190,0.18)';
      ctx.fillRect(rand() * model.width, rand() * model.depth, 2 + rand() * 4, 2 + rand() * 4);
    }
    // campo
    const ring = new Path2D();
    C.ring.forEach(([x, y], i) => (i ? ring.lineTo(x, y) : ring.moveTo(x, y)));
    ring.closePath();
    ctx.fillStyle = '#5b9446';
    ctx.fill(ring);
    ctx.save();
    ctx.clip(ring);
    for (let i = 0; i < 14000; i++) {
      ctx.fillStyle = rand() < 0.5 ? 'rgba(30,80,25,0.18)' : 'rgba(160,215,110,0.14)';
      ctx.fillRect(rand() * model.width, rand() * model.depth, 1 + rand() * 2.5, 1 + rand() * 2.5);
    }
    ctx.restore();
    const each = (fn) => holes.forEach((ho) => {
      ctx.save();
      ctx.translate(ho.ox, ho.oy);
      fn(ho.h);
      ctx.restore();
    });
    // por capas para que ningún hoyo tape el green o el agua de otro
    each((h) => h.fairways.forEach((p) => { ctx.fillStyle = '#7cb35a'; ctx.fill(p.path); }));
    each((h) => h.fairways.forEach((p) => {
      ctx.save();
      ctx.clip(p.path);
      ctx.translate(h.tee.x, h.tee.y);
      ctx.rotate(h.angle);
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      for (let x = -400; x < 400; x += 16) ctx.fillRect(x, -400, 8, 800);
      ctx.restore();
    }));
    each((h) => { if (h.teeBox) { ctx.fillStyle = '#93c86e'; ctx.fill(h.teeBox.path); } });
    each((h) => { if (h.green) { ctx.strokeStyle = '#86bf63'; ctx.lineWidth = 3; ctx.stroke(h.green.path); ctx.fillStyle = '#a6d983'; ctx.fill(h.green.path); } });
    each((h) => h.bunkers.forEach((p) => { ctx.fillStyle = '#f1e2ae'; ctx.fill(p.path); ctx.strokeStyle = 'rgba(150,120,60,0.6)'; ctx.lineWidth = 0.8; ctx.stroke(p.path); }));
    each((h) => h.water.forEach((p) => { ctx.fillStyle = '#3a7fae'; ctx.fill(p.path); ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 0.8; ctx.stroke(p.path); }));
    // límite del campo
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.stroke(ring);
    return cv;
  }

  // Árboles de todos los hoyos sin duplicados (los marcos de los hoyos se solapan).
  function courseTrees(model) {
    const seen = new Set();
    const out = [];
    for (const ho of model.holes) {
      for (const t of ho.h.trees) {
        const p = ho.to(t);
        const key = `${Math.round(p.x / 3)}:${Math.round(p.y / 3)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ x: p.x, y: p.y, r: t.r });
      }
    }
    return out;
  }

  // ---------- reproductor ----------

  function mount(container, opts = {}) {
    const model = courseModel();
    const player = {
      container, model, playing: false, t: 0, started: false, onEnd: opts.onEnd,
      duration: INTRO + model.holes.length * PER_HOLE + OUTRO,
    };
    container.innerHTML = `
      <canvas class="tour-poster" aria-hidden="true"></canvas>
      <div class="tour-gl"></div>
      <div class="tour-shade"></div>
      <div class="tour-cap" aria-live="polite"></div>
      <button class="tour-play" aria-label="Ver el recorrido en 3D"><span class="tri"></span><b>Recorrido 3D</b><small>${Math.round(player.duration / 60)} min · 18 hoyos</small></button>
      <div class="tour-bar" hidden>
        <button class="tb" data-a="prev" aria-label="Hoyo anterior">‹‹</button>
        <button class="tb" data-a="toggle" aria-label="Pausa">❚❚</button>
        <button class="tb" data-a="next" aria-label="Hoyo siguiente">››</button>
        <div class="tour-prog" role="slider" aria-label="Progreso del recorrido" aria-valuemin="0" aria-valuemax="100">${
          ['I'].concat(model.holes.map((ho) => ho.raw.number)).map((k, i) => `<span data-seg="${i}" title="${i ? 'Hoyo ' + k : 'Introducción'}"><i></i></span>`).join('')}</div>
      </div>`;
    drawPoster(player);
    container.querySelector('.tour-play').onclick = () => start(player);
    container.querySelectorAll('.tour-bar .tb').forEach((b) => (b.onclick = () => action(player, b.dataset.a)));
    container.querySelectorAll('.tour-prog span').forEach((s) => (s.onclick = () => seekSeg(player, Number(s.dataset.seg))));
    caption(player, intro(model));
    return player;
  }

  function intro(model) {
    const meters = model.holes.reduce((a, ho) => a + ho.info.meters, 0);
    const par = model.holes.reduce((a, ho) => a + ho.info.par, 0);
    const p3 = model.holes.filter((ho) => ho.info.par === 3).length;
    const p4 = model.holes.filter((ho) => ho.info.par === 4).length;
    const water = model.holes.filter((ho) => ho.info.chips.some((c) => /agua/i.test(c))).length;
    return {
      eyebrow: 'Golf Sotoverde · Arroyo de la Encomienda',
      title: 'El campo',
      line: `${model.holes.length} hoyos · par ${par} · ${meters.toLocaleString('es-ES')} m desde amarillas`,
      chips: [`${p3} pares 3`, `${p4} pares 4`, `${model.holes.length - p3 - p4} par 5`, `${water} hoyos con agua`],
      tip: 'Un recorrido corto y técnico: aquí manda la precisión con los hierros.',
    };
  }

  function drawPoster(player) {
    const cv = player.container.querySelector('.tour-poster');
    const r = player.container.getBoundingClientRect();
    const dpr = Math.min(global.devicePixelRatio || 1, 2);
    cv.width = Math.max(1, Math.round(r.width * dpr));
    cv.height = Math.max(1, Math.round(r.height * dpr));
    const tex = courseTexture(player.model, 1.2);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#c3bf9c';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const s = Math.min(cv.width / tex.width, cv.height / tex.height) * 1.12;
    ctx.drawImage(tex, (cv.width - tex.width * s) / 2, (cv.height - tex.height * s) / 2, tex.width * s, tex.height * s);
    player.texCache = tex;
  }

  async function start(player) {
    const c = player.container;
    c.classList.add('loading');
    try {
      await loadThree();
    } catch (e) {
      c.classList.remove('loading');
      caption(player, { eyebrow: 'Recorrido 3D', title: 'No disponible', line: 'No se pudo cargar el motor 3D. Revisa la conexión y vuelve a intentarlo.', chips: [], tip: '' });
      return;
    }
    if (!player.three) build(player);
    c.classList.remove('loading', 'paused', 'ended');
    c.classList.add('playing');
    c.querySelector('.tour-bar').hidden = false;
    player.playing = true;
    player.last = performance.now();
    if (player.t >= player.duration) player.t = 0;
    loop(player);
  }

  function build(player) {
    const THREE = global.THREE;
    const { model } = player;
    const host = player.container.querySelector('.tour-gl');
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = skyTexture(THREE);
    scene.fog = new THREE.Fog(0xdde8e6, 700, 1700);
    const camera = new THREE.PerspectiveCamera(48, 1, 1, 4000);
    scene.add(new THREE.HemisphereLight(0xf2f7ff, 0x40603a, 0.95));
    const sun = new THREE.DirectionalLight(0xfff3dc, 0.75);
    sun.position.set(-300, 400, -250);
    scene.add(sun);

    // terreno
    const { C } = model;
    const geo = new THREE.PlaneGeometry(model.width, model.depth, C.cols - 1, C.rows - 1);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, (C.base + C.dm[i] / 10 - model.base) * EXAG);
    geo.computeVertexNormals();
    geo.rotateX(-Math.PI / 2);
    const tex = new THREE.CanvasTexture(courseTexture(model, 2.4));
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex }));
    scene.add(ground);
    // un zócalo bajo el terreno para que no se vea el canto
    const skirt = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshLambertMaterial({ color: 0xa9ab86 }));
    skirt.rotation.x = -Math.PI / 2;
    skirt.position.y = -2;
    scene.add(skirt);

    const W = (x, y, lift = 0) => new THREE.Vector3(x - C.cell / 2 - model.width / 2,
      (model.heightAt(x, y) - model.base) * EXAG + lift, y - C.cell / 2 - model.depth / 2);
    player.W = W;

    // árboles
    const trees = courseTrees(model);
    const crown = new THREE.IcosahedronGeometry(1, 1);
    const mat = new THREE.MeshLambertMaterial({ color: 0x2f6b2a, flatShading: true });
    const inst = new THREE.InstancedMesh(crown, mat, trees.length);
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    const rand = GC.rng(11);
    trees.forEach((t, i) => {
      const p = W(t.x, t.y, t.r * 1.1);
      const s = t.r * 0.95;
      m4.makeScale(s, s * (1.1 + rand() * 0.3), s).setPosition(p);
      inst.setMatrixAt(i, m4);
      col.setHSL(0.27 + rand() * 0.06, 0.38, 0.26 + rand() * 0.09);
      inst.setColorAt(i, col);
    });
    scene.add(inst);

    // banderas y números
    for (const ho of model.holes) {
      const base = W(ho.pin.x, ho.pin.y);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 12, 6), new THREE.MeshLambertMaterial({ color: 0xffffff }));
      pole.position.copy(base).add(new THREE.Vector3(0, 6, 0));
      scene.add(pole);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(5, 3.2), new THREE.MeshLambertMaterial({ color: 0xd8322a, side: THREE.DoubleSide }));
      flag.position.copy(base).add(new THREE.Vector3(2.5, 10.4, 0));
      scene.add(flag);
      const label = numberSprite(THREE, ho.raw.number);
      label.position.copy(base).add(new THREE.Vector3(0, 18, 0));
      scene.add(label);
      const tee = new THREE.Mesh(new THREE.SphereGeometry(1.4, 10, 8), new THREE.MeshLambertMaterial({ color: 0xf2cf3c }));
      tee.position.copy(W(ho.tee.x, ho.tee.y, 1.4));
      scene.add(tee);
    }

    player.three = { renderer, scene, camera };
    const ro = new ResizeObserver(() => resize(player));
    ro.observe(player.container);
    resize(player);
  }

  function skyTexture(THREE) {
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 256;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0, '#8fb7d6');
    grd.addColorStop(0.6, '#d7e6ea');
    grd.addColorStop(1, '#eef2e8');
    g.fillStyle = grd;
    g.fillRect(0, 0, 2, 256);
    return new THREE.CanvasTexture(c);
  }

  function numberSprite(THREE, n) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(64, 64, 56, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 8;
    g.strokeStyle = '#0f3a24';
    g.stroke();
    g.fillStyle = '#0f3a24';
    g.font = "800 66px 'Barlow Condensed', 'Arial Narrow', sans-serif";
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(n), 64, 68);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
    sp.scale.set(9, 9, 1);
    return sp;
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
    const n = player.model.holes.length;
    if (t < INTRO) return { seg: 0, k: t / INTRO };
    const u = t - INTRO;
    const i = Math.floor(u / PER_HOLE);
    if (i < n) return { seg: i + 1, k: (u - i * PER_HOLE) / PER_HOLE };
    return { seg: n + 1, k: Math.min(1, (u - n * PER_HOLE) / OUTRO) };
  }

  function shot(player, t) {
    const THREE = global.THREE;
    const { model, W } = player;
    const { seg, k } = segmentAt(player, t);
    const center = new THREE.Vector3(0, 10, 0);
    if (seg === 0 || seg > model.holes.length) {
      // vuelo alrededor del campo
      const a = seg === 0 ? -2.2 + k * 1.3 : -0.9 + k * 0.8;
      const rad = seg === 0 ? 560 - k * 140 : 460 + k * 160;
      const hgt = seg === 0 ? 330 - k * 120 : 230 + k * 150;
      return { pos: new THREE.Vector3(Math.cos(a) * rad, hgt, Math.sin(a) * rad), look: center, seg };
    }
    const ho = model.holes[seg - 1];
    const L = GC.dist(ho.tee, ho.pin) || 1;
    const u = { x: (ho.pin.x - ho.tee.x) / L, y: (ho.pin.y - ho.tee.y) / L };
    const back = Math.max(40, L * 0.28);
    const e = ease(k);
    // de detrás del tee a la entrada del green
    const from = { x: ho.tee.x - u.x * back, y: ho.tee.y - u.y * back };
    const to = { x: ho.pin.x - u.x * Math.min(70, L * 0.45), y: ho.pin.y - u.y * Math.min(70, L * 0.45) };
    const px = from.x + (to.x - from.x) * e;
    const py = from.y + (to.y - from.y) * e;
    const lift = (45 + L * 0.16) * (1 - e) + 36 * e;
    const pos = W(px, py, lift);
    const lookPt = { x: ho.tee.x + (ho.pin.x - ho.tee.x) * (0.55 + 0.45 * e), y: ho.tee.y + (ho.pin.y - ho.tee.y) * (0.55 + 0.45 * e) };
    // transición suave desde el plano anterior en los primeros instantes
    return { pos, look: W(lookPt.x, lookPt.y, 2), seg };
  }

  function render(player) {
    if (!player.three) return;
    const { renderer, scene, camera } = player.three;
    const s = shot(player, player.t);
    if (player.camPos && player.t - (player.lastT || 0) < 0.5 && player.camSeg !== s.seg) {
      // cambio de hoyo: deslizamiento rápido en lugar de corte seco
      player.camPos.lerp(s.pos, 0.12);
      player.camLook.lerp(s.look, 0.12);
      if (player.camPos.distanceTo(s.pos) < 3) player.camSeg = s.seg;
    } else {
      player.camPos = s.pos.clone();
      player.camLook = s.look.clone();
      player.camSeg = s.seg;
    }
    player.lastT = player.t;
    camera.position.copy(player.camPos);
    camera.lookAt(player.camLook);
    renderer.render(scene, camera);
    updateUi(player, s.seg);
  }

  function loop(player) {
    if (!player.playing) return;
    if (!player.container.isConnected) {
      // se ha salido de la portada: queda en pausa
      player.playing = false;
      player.container.classList.replace('playing', 'paused');
      updateUi(player, segmentAt(player, player.t).seg);
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

  function updateUi(player, seg) {
    const c = player.container;
    const n = player.model.holes.length;
    if (player.uiSeg !== seg) {
      player.uiSeg = seg;
      if (seg === 0) caption(player, intro(player.model));
      else if (seg > n) caption(player, {
        eyebrow: 'Golf Sotoverde', title: 'Buena vuelta', line: 'Apunta tus golpes hoyo a hoyo con Mis vueltas',
        chips: ['18 hoyos', 'Par 60'], tip: '',
      });
      else {
        const ho = player.model.holes[seg - 1];
        const i = ho.info;
        caption(player, {
          eyebrow: `Hoyo ${ho.raw.number} de ${n}`,
          title: `Hoyo ${ho.raw.number}`,
          line: `Par ${i.par} · ${i.meters} m · Hándicap ${i.si}`,
          chips: i.chips,
          tip: i.tip,
        });
      }
    }
    const { seg: s, k } = segmentAt(player, player.t);
    c.querySelectorAll('.tour-prog span').forEach((el, idx) => {
      const fill = idx < s ? 1 : idx === s ? k : 0;
      el.firstChild.style.transform = `scaleX(${fill})`;
      el.classList.toggle('on', idx === s);
    });
    const prog = c.querySelector('.tour-prog');
    prog.setAttribute('aria-valuenow', String(Math.round((100 * player.t) / player.duration)));
    c.querySelector('[data-a="toggle"]').textContent = player.playing ? '❚❚' : '▶';
    c.querySelector('[data-a="toggle"]').setAttribute('aria-label', player.playing ? 'Pausa' : 'Reproducir');
  }

  function caption(player, d) {
    const el = player.container.querySelector('.tour-cap');
    el.innerHTML = `<span class="eyebrow">${d.eyebrow}</span><b class="t-title">${d.title}</b>
      <div class="t-line">${d.line}</div>
      ${d.chips.length ? `<div class="t-chips">${d.chips.map((c) => `<span>${c}</span>`).join('')}</div>` : ''}
      ${d.tip ? `<p class="t-tip">${d.tip}</p>` : ''}`;
    el.classList.remove('in');
    void el.offsetWidth;
    el.classList.add('in');
  }

  function segStart(player, seg) {
    return seg === 0 ? 0 : INTRO + (seg - 1) * PER_HOLE;
  }

  function seekSeg(player, seg) {
    player.t = Math.min(player.duration - 0.01, segStart(player, Math.max(0, seg)));
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
    } else if (a === 'next') seekSeg(player, seg + 1);
    else if (a === 'prev') seekSeg(player, seg - 1);
  }

  GC.Tour = { mount, holeInfo, courseModel };
})(typeof window !== 'undefined' ? window : globalThis);
