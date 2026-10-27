/*
 * Núcleo compartido por el juego, el editor y el menú:
 * geometría, superficies, palos, almacenamiento y dibujo del hoyo.
 *
 * Coordenadas del hoyo: metros, origen arriba a la izquierda,
 * x hacia la derecha e y hacia abajo (como los píxeles de una imagen).
 * Ángulos de brújula: 0 = arriba (norte), 90 = derecha (este).
 */
(function (global) {
  'use strict';
  const GC = (global.GC = global.GC || {});

  // ---------- Constantes de juego ----------

  GC.CUP_RADIUS = 0.22;      // radio de captura del hoyo (m), algo generoso
  GC.CAPTURE_SPEED = 2.2;    // velocidad máxima (m/s) para que la bola entre
  GC.PERFECT_ZONE = 0.07;    // |aguja| por debajo de esto = golpe perfecto
  GC.MAX_PUTT = 30;          // distancia máxima de un putt en llano (m)
  GC.MAX_SLOPE = 0.3;        // aceleración máxima por pendiente del green (m/s²)
  GC.MAX_STROKES = 10;       // a partir de aquí se levanta la bola

  GC.SURFACES = {
    tee:     { name: 'Tee',      friction: 1.6, landRoll: 1.0,  carry: 1.0,  scatter: 1.0, kick: 1.0 },
    fairway: { name: 'Calle',    friction: 1.6, landRoll: 1.0,  carry: 1.0,  scatter: 1.0, kick: 1.0 },
    green:   { name: 'Green',    friction: 0.6, landRoll: 0.7,  carry: 1.0,  scatter: 1.0, kick: 0.5 },
    // rough corto (semirough): en Sotoverde casi todo lo que no es calle está segado bajo
    rough:   { name: 'Rough',    friction: 2.2, landRoll: 0.35, carry: 0.85, scatter: 1.6, kick: 0.8 },
    sand:    { name: 'Búnker',   friction: 14,  landRoll: 0.05, carry: 0.6,  scatter: 2.0, kick: 0 },
    water:   { name: 'Agua',     friction: 99,  landRoll: 0,    carry: 0,    scatter: 1.0 },
    ob:      { name: 'Fuera',    friction: 99,  landRoll: 0,    carry: 0,    scatter: 1.0 },
  };

  // max: vuelo máximo (m). spread: desvío lateral (grados) con la aguja en el extremo.
  // roll: rodadura tras botar, como fracción del vuelo. apex: altura máxima / vuelo.
  // needle: velocidad relativa de la aguja de precisión.
  GC.CLUBS = [
    { id: 'driver', name: 'Driver',     max: 230, spread: 9,   roll: 0.14, apex: 0.11, needle: 1.25 },
    { id: 'wood3',  name: 'Madera 3',   max: 205, spread: 7.5, roll: 0.12, apex: 0.12, needle: 1.15 },
    { id: 'hybrid', name: 'Híbrido',    max: 180, spread: 6.5, roll: 0.10, apex: 0.13, needle: 1.05 },
    { id: 'iron5',  name: 'Hierro 5',   max: 160, spread: 5.5, roll: 0.08, apex: 0.14, needle: 1.0 },
    { id: 'iron7',  name: 'Hierro 7',   max: 140, spread: 5,   roll: 0.06, apex: 0.16, needle: 0.95 },
    { id: 'iron9',  name: 'Hierro 9',   max: 115, spread: 4.5, roll: 0.05, apex: 0.18, needle: 0.9 },
    { id: 'pw',     name: 'Pitching',   max: 95,  spread: 4,   roll: 0.04, apex: 0.2,  needle: 0.85 },
    { id: 'sw',     name: 'Sand wedge', max: 70,  spread: 4,   roll: 0.03, apex: 0.24, needle: 0.8, sand: true },
    { id: 'putter', name: 'Putter',     max: GC.MAX_PUTT, putter: true },
  ];

  GC.clubRange = function (club, surface) {
    if (club.putter) return GC.MAX_PUTT;
    let carry = (GC.SURFACES[surface] || GC.SURFACES.rough).carry;
    if (surface === 'sand' && club.sand) carry = 0.9;
    return club.max * carry;
  };

  GC.scoreName = function (strokes, par) {
    if (strokes === 1) return '¡Hoyo en uno!';
    const d = strokes - par;
    if (d <= -3) return '¡Albatros!';
    if (d === -2) return '¡Eagle!';
    if (d === -1) return '¡Birdie!';
    if (d === 0) return 'Par';
    if (d === 1) return 'Bogey';
    if (d === 2) return 'Doble bogey';
    if (d === 3) return 'Triple bogey';
    return '+' + d;
  };

  // ---------- Geometría ----------

  GC.dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  GC.clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // Vector unitario a partir de un ángulo de brújula (0 = arriba).
  GC.compassVec = (deg) => {
    const r = (deg * Math.PI) / 180;
    return { x: Math.sin(r), y: -Math.cos(r) };
  };

  GC.toPoint = (p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p.x, y: p.y });

  // Suaviza un polígono cerrado (algoritmo de Chaikin).
  GC.chaikin = function (pts, iterations) {
    let out = pts.map(GC.toPoint);
    for (let k = 0; k < iterations; k++) {
      const next = [];
      for (let i = 0; i < out.length; i++) {
        const a = out[i];
        const b = out[(i + 1) % out.length];
        next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
        next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
      }
      out = next;
    }
    return out;
  };

  GC.pointInPoly = function (pts, x, y) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i];
      const b = pts[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };

  // Polígono preparado: puntos suavizados, caja envolvente y Path2D para dibujar.
  GC.makePoly = function (raw, smooth = 3) {
    const pts = GC.chaikin(raw, raw.length >= 3 ? smooth : 0);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    let path = null;
    if (typeof Path2D !== 'undefined') {
      path = new Path2D();
      pts.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
      path.closePath();
    }
    return { pts, minX, minY, maxX, maxY, path };
  };

  GC.polyContains = (poly, x, y) =>
    x >= poly.minX && x <= poly.maxX && y >= poly.minY && y <= poly.maxY && GC.pointInPoly(poly.pts, x, y);

  // Generador pseudoaleatorio con semilla, para que los árboles salgan siempre iguales.
  GC.rng = function (seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // ---------- Preparación del hoyo ----------

  // teeKey: barras de salida opcionales (raw.tees), p. ej. "amarillas" o "rojas".
  GC.prepareHole = function (raw, teeKey) {
    const teeRaw = (teeKey && raw.tees && raw.tees[teeKey]) || raw.tee;
    const h = {
      raw,
      id: raw.id,
      name: raw.name || 'Hoyo',
      number: raw.number || 1,
      par: raw.par || 4,
      width: raw.width,
      height: raw.height,
      tee: GC.toPoint(teeRaw),
      teeKey: teeKey && raw.tees && raw.tees[teeKey] ? teeKey : null,
      teeBox: raw.teeBox && raw.teeBox.length >= 3 ? GC.makePoly(raw.teeBox, 1) : null,
      teeMarks: raw.tees ? Object.entries(raw.tees).map(([k, t]) => ({ key: k, x: t.x, y: t.y })) : [],
      pin: GC.toPoint(raw.pin),
      fairways: (raw.fairways || []).filter((p) => p.length >= 3).map((p) => GC.makePoly(p)),
      green: raw.green && raw.green.length >= 3 ? GC.makePoly(raw.green) : null,
      bunkers: (raw.bunkers || []).filter((p) => p.length >= 3).map((p) => GC.makePoly(p)),
      water: (raw.water || []).filter((p) => p.length >= 3).map((p) => GC.makePoly(p)),
      trees: (raw.trees || []).map((t, i) => GC.makeTree(t, i)),
    };
    const s = raw.greenSlope || { angle: 0, strength: 0 };
    const sv = GC.compassVec(s.angle || 0);
    const k = GC.clamp(s.strength || 0, 0, 1) * GC.MAX_SLOPE;
    h.slope = { x: sv.x * k, y: sv.y * k, angle: s.angle || 0, strength: s.strength || 0 };
    h.angle = Math.atan2(h.pin.y - h.tee.y, h.pin.x - h.tee.x);
    h.length = Math.round(GC.dist(h.tee, h.pin));
    h.elev = GC.makeElevation(raw.elevation);
    h.heightAt = (x, y) => (h.elev ? h.elev.heightAt(x, y) : 0);
    h.gradAt = (x, y) => (h.elev ? h.elev.gradAt(x, y) : { x: 0, y: 0 });

    h.surfaceAt = function (x, y) {
      if (x < 0 || y < 0 || x > h.width || y > h.height) return 'ob';
      for (const p of h.water) if (GC.polyContains(p, x, y)) return 'water';
      for (const p of h.bunkers) if (GC.polyContains(p, x, y)) return 'sand';
      if (h.green && GC.polyContains(h.green, x, y)) return 'green';
      for (const p of h.fairways) if (GC.polyContains(p, x, y)) return 'fairway';
      if (h.teeBox && GC.polyContains(h.teeBox, x, y)) return 'tee';
      if (Math.hypot(x - h.tee.x, y - h.tee.y) < 6) return 'tee';
      return 'rough';
    };
    h.treeAt = function (x, y) {
      for (const t of h.trees) if (Math.hypot(x - t.x, y - t.y) < t.r) return t;
      return null;
    };
    return h;
  };

  // Rejilla de alturas {cell, cols, rows, base, data[]} → altura y pendiente interpoladas.
  GC.makeElevation = function (e) {
    if (!e || !e.data || e.data.length !== e.cols * e.rows) return null;
    const { cell, cols, rows, data } = e;
    const at = (i, j) => data[GC.clamp(j, 0, rows - 1) * cols + GC.clamp(i, 0, cols - 1)];
    const heightAt = (x, y) => {
      const fx = GC.clamp(x / cell, 0, cols - 1);
      const fy = GC.clamp(y / cell, 0, rows - 1);
      const i = Math.min(Math.floor(fx), cols - 2);
      const j = Math.min(Math.floor(fy), rows - 2);
      const u = fx - i;
      const v = fy - j;
      return (
        at(i, j) * (1 - u) * (1 - v) + at(i + 1, j) * u * (1 - v) +
        at(i, j + 1) * (1 - u) * v + at(i + 1, j + 1) * u * v
      );
    };
    const d = cell / 2;
    const gradAt = (x, y) => ({
      x: (heightAt(x + d, y) - heightAt(x - d, y)) / (2 * d),
      y: (heightAt(x, y + d) - heightAt(x, y - d)) / (2 * d),
    });
    let min = Infinity;
    let max = -Infinity;
    for (const v of data) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    return { cell, cols, rows, base: e.base || 0, min, max, heightAt, gradAt, shade: null };
  };

  GC.makeTree = function (t, i) {
    const rand = GC.rng(Math.round(t.x * 131 + t.y * 977 + i * 7919));
    const blobs = [];
    const n = 5 + Math.floor(rand() * 4);
    for (let k = 0; k < n; k++) {
      const a = rand() * Math.PI * 2;
      const d = rand() * t.r * 0.45;
      blobs.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: t.r * (0.45 + rand() * 0.25) });
    }
    return { x: t.x, y: t.y, r: t.r, blobs, tint: rand() };
  };

  // ---------- Cámara ----------
  // cam = { x, y, zoom (px por metro), rot (rad) }, view = { cx, cy } centro en pantalla.

  GC.worldToScreen = function (cam, view, p) {
    const dx = p.x - cam.x;
    const dy = p.y - cam.y;
    const c = Math.cos(cam.rot);
    const s = Math.sin(cam.rot);
    return { x: view.cx + (dx * c - dy * s) * cam.zoom, y: view.cy + (dx * s + dy * c) * cam.zoom };
  };

  GC.screenToWorld = function (cam, view, p) {
    const rx = (p.x - view.cx) / cam.zoom;
    const ry = (p.y - view.cy) / cam.zoom;
    const c = Math.cos(cam.rot);
    const s = Math.sin(cam.rot);
    return { x: cam.x + rx * c + ry * s, y: cam.y - rx * s + ry * c };
  };

  GC.applyCamera = function (ctx, cam, view) {
    ctx.translate(view.cx, view.cy);
    ctx.rotate(cam.rot);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);
  };

  // Calcula centro y zoom para que los puntos quepan en un rectángulo de pantalla.
  GC.fitCamera = function (points, rot, rect, minSpan, minZoom, maxZoom) {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      const rx = p.x * c - p.y * s;
      const ry = p.x * s + p.y * c;
      minX = Math.min(minX, rx); maxX = Math.max(maxX, rx);
      minY = Math.min(minY, ry); maxY = Math.max(maxY, ry);
    }
    const w = Math.max(maxX - minX, minSpan);
    const hgt = Math.max(maxY - minY, minSpan);
    const zoom = GC.clamp(Math.min(rect.w / w, rect.h / hgt), minZoom, maxZoom);
    const mx = (minX + maxX) / 2;
    const my = (minY + maxY) / 2;
    // deshacer la rotación del centro
    return { x: mx * c + my * s, y: -mx * s + my * c, zoom, rot };
  };

  GC.holeCorners = (h) => [
    { x: 0, y: 0 }, { x: h.width, y: 0 }, { x: 0, y: h.height }, { x: h.width, y: h.height },
  ];

  // Rotación para que la línea tee → bandera quede vertical, con el green arriba.
  GC.holeRotation = (h) => -Math.PI / 2 - h.angle;

  // ---------- Dibujo del hoyo (en coordenadas de mundo) ----------

  const COLORS = {
    forest: '#2a5a24',
    rough: '#3f8f33',
    fairway: '#68bf46',
    fairwayStripe: '#77cb54',
    firstCut: '#55a83b',
    fringe: '#7acb56',
    green: '#92e26a',
    sand: '#efdca2',
    sandEdge: '#cdb170',
    water: '#2f93da',
    waterDeep: '#1f6fb8',
  };
  GC.COLORS = COLORS;

  const TEE_COLORS = { blancas: '#ffffff', amarillas: '#f6d84a', azules: '#3b7bea', rojas: '#e8312f' };
  GC.TEE_COLORS = TEE_COLORS;

  let roughPattern = null;
  function getRoughPattern(ctx) {
    if (roughPattern || typeof document === 'undefined') return roughPattern;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = COLORS.rough;
    g.fillRect(0, 0, 128, 128);
    const rand = GC.rng(42);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = rand() < 0.5 ? 'rgba(20,70,20,0.25)' : 'rgba(140,210,100,0.18)';
      g.fillRect(rand() * 128, rand() * 128, 1 + rand() * 2, 2 + rand() * 4);
    }
    roughPattern = ctx.createPattern(c, 'repeat');
    if (roughPattern.setTransform && typeof DOMMatrix !== 'undefined') {
      roughPattern.setTransform(new DOMMatrix().scale(1 / 8));
    }
    return roughPattern;
  }

  function stripes(ctx, h, width, color, extraAngle) {
    const diag = Math.hypot(h.width, h.height);
    ctx.save();
    ctx.translate(h.width / 2, h.height / 2);
    ctx.rotate(h.angle + (extraAngle || 0));
    ctx.fillStyle = color;
    for (let x = -diag; x < diag; x += width * 2) ctx.fillRect(x, -diag, width, diag * 2);
    ctx.restore();
  }

  GC.renderHole = function (ctx, h, time, opts = {}) {
    // bosque / fuera de límites
    ctx.fillStyle = COLORS.forest;
    ctx.fillRect(-2000, -2000, h.width + 4000, h.height + 4000);

    // rough
    ctx.fillStyle = getRoughPattern(ctx) || COLORS.rough;
    ctx.fillRect(0, 0, h.width, h.height);

    // estacas de fuera de límites
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 0.6;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(0, 0, h.width, h.height);
    ctx.restore();

    // calles
    for (const p of h.fairways) {
      ctx.strokeStyle = COLORS.firstCut;
      ctx.lineWidth = 4;
      ctx.stroke(p.path);
    }
    for (const p of h.fairways) {
      ctx.fillStyle = COLORS.fairway;
      ctx.fill(p.path);
      ctx.save();
      ctx.clip(p.path);
      stripes(ctx, h, 9, COLORS.fairwayStripe);
      ctx.restore();
    }

    // tee: zona de salida real si existe; si no, un rectángulo orientado al hoyo
    if (h.teeBox) {
      ctx.strokeStyle = COLORS.firstCut;
      ctx.lineWidth = 2;
      ctx.stroke(h.teeBox.path);
      ctx.fillStyle = COLORS.fairwayStripe;
      ctx.fill(h.teeBox.path);
    } else {
      ctx.save();
      ctx.translate(h.tee.x, h.tee.y);
      ctx.rotate(h.angle);
      ctx.fillStyle = COLORS.firstCut;
      ctx.fillRect(-7, -5, 14, 10);
      ctx.fillStyle = COLORS.fairwayStripe;
      ctx.fillRect(-6, -4, 12, 8);
      ctx.restore();
    }
    const marks = h.teeMarks.length ? h.teeMarks : [{ key: 'amarillas', x: h.tee.x, y: h.tee.y }];
    for (const m of marks) {
      ctx.save();
      ctx.translate(m.x, m.y);
      ctx.rotate(h.angle);
      ctx.fillStyle = TEE_COLORS[m.key] || '#ffffff';
      for (const y of [-2.5, 2.5]) {
        ctx.beginPath();
        ctx.arc(0, y, 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // green
    if (h.green) {
      ctx.strokeStyle = COLORS.fringe;
      ctx.lineWidth = 3.5;
      ctx.stroke(h.green.path);
      ctx.fillStyle = COLORS.green;
      ctx.fill(h.green.path);
      ctx.save();
      ctx.clip(h.green.path);
      stripes(ctx, h, 3, 'rgba(255,255,255,0.07)', Math.PI / 4);
      stripes(ctx, h, 3, 'rgba(255,255,255,0.07)', -Math.PI / 4);
      if (opts.showSlope && h.slope.strength > 0) drawSlope(ctx, h, time);
      ctx.restore();
    }

    // búnkeres
    for (const p of h.bunkers) {
      ctx.strokeStyle = 'rgba(30,80,25,0.55)';
      ctx.lineWidth = 1.6;
      ctx.stroke(p.path);
      ctx.fillStyle = COLORS.sand;
      ctx.fill(p.path);
      ctx.save();
      ctx.clip(p.path);
      ctx.translate(0.8, 0.8);
      ctx.strokeStyle = 'rgba(170,135,60,0.45)';
      ctx.lineWidth = 2.2;
      ctx.stroke(p.path);
      ctx.restore();
    }

    // agua
    for (const p of h.water) {
      ctx.strokeStyle = '#2b6b34';
      ctx.lineWidth = 2;
      ctx.stroke(p.path);
      const g = ctx.createLinearGradient(p.minX, p.minY, p.maxX, p.maxY);
      g.addColorStop(0, COLORS.water);
      g.addColorStop(1, COLORS.waterDeep);
      ctx.fillStyle = g;
      ctx.fill(p.path);
      ctx.save();
      ctx.clip(p.path);
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 0.5;
      for (let y = p.minY; y < p.maxY; y += 5) {
        ctx.beginPath();
        for (let x = p.minX; x <= p.maxX; x += 2) {
          const yy = y + Math.sin(x * 0.25 + time * 1.5 + y) * 0.8;
          x === p.minX ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 0.6;
      ctx.stroke(p.path);
      ctx.restore();
    }

    if (h.elev) drawRelief(ctx, h);

    // árboles: primero las sombras, luego las copas
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    for (const t of h.trees) {
      ctx.beginPath();
      ctx.ellipse(t.x + t.r * 0.35, t.y + t.r * 0.35, t.r, t.r * 0.9, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const t of h.trees) {
      ctx.fillStyle = t.tint < 0.5 ? '#25611f' : '#2d6b1f';
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = t.tint < 0.5 ? '#348a2c' : '#3f8f2a';
      for (const b of t.blobs) {
        ctx.beginPath();
        ctx.arc(t.x + b.x, t.y + b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(160,230,110,0.35)';
      for (const b of t.blobs.slice(0, 3)) {
        ctx.beginPath();
        ctx.arc(t.x + b.x - b.r * 0.3, t.y + b.y - b.r * 0.3, b.r * 0.45, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  // Sombreado del relieve (luz del noroeste, relieve exagerado para que se aprecie).
  function drawRelief(ctx, h) {
    const e = h.elev;
    if (!e.shade && typeof document !== 'undefined') {
      const step = 1; // metros por píxel del sombreado
      const w = Math.ceil(h.width / step);
      const hg = Math.ceil(h.height / step);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = hg;
      const g = c.getContext('2d');
      const img = g.createImageData(w, hg);
      const exag = 2;
      const light = { x: -0.5, y: -0.5, z: 0.7 };
      const ll = Math.hypot(light.x, light.y, light.z);
      for (let j = 0; j < hg; j++) {
        for (let i = 0; i < w; i++) {
          const gr = e.gradAt(i * step, j * step);
          const nx = -gr.x * exag;
          const ny = -gr.y * exag;
          const nl = Math.hypot(nx, ny, 1);
          const flat = light.z / ll;
          const lit = (nx * light.x + ny * light.y + light.z) / (nl * ll) - flat;
          const k = (j * w + i) * 4;
          const v = lit > 0 ? 255 : 0;
          img.data[k] = img.data[k + 1] = img.data[k + 2] = v;
          img.data[k + 3] = Math.min(60, Math.abs(lit) * 500);
        }
      }
      g.putImageData(img, 0, 0);
      e.shade = { canvas: c, step };
    }
    if (!e.shade) return;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(e.shade.canvas, 0, 0, e.shade.canvas.width * e.shade.step, e.shade.canvas.height * e.shade.step);
    ctx.restore();
  }

  // Flechas animadas que muestran la caída del green.
  function drawSlope(ctx, h, time) {
    const g = h.green;
    const ang = Math.atan2(h.slope.y, h.slope.x);
    const cx = (g.minX + g.maxX) / 2;
    const cy = (g.minY + g.maxY) / 2;
    const span = Math.hypot(g.maxX - g.minX, g.maxY - g.minY);
    const step = 2.2;
    const offset = ((time * (0.6 + h.slope.strength * 1.6)) % step + step) % step;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.strokeStyle = `rgba(255,255,255,${0.2 + h.slope.strength * 0.35})`;
    ctx.lineWidth = 0.18;
    ctx.lineCap = 'round';
    const size = 0.35 + h.slope.strength * 0.35;
    for (let x = -span; x < span; x += step) {
      for (let y = -span; y < span; y += step) {
        const px = x + offset + ((Math.round(y / step) & 1) * step) / 2;
        ctx.beginPath();
        ctx.moveTo(px - size, y - size);
        ctx.lineTo(px, y);
        ctx.lineTo(px - size, y + size);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Bandera en coordenadas de pantalla (siempre vertical).
  GC.drawFlag = function (ctx, sx, sy, scale, time, cupPx) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.beginPath();
    ctx.ellipse(sx, sy, Math.max(cupPx, 3), Math.max(cupPx, 3) * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();
    const hgt = 46 * scale;
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 3 * scale;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + hgt * 0.45, sy + hgt * 0.12);
    ctx.stroke();
    ctx.strokeStyle = '#f4f4f4';
    ctx.lineWidth = 2.5 * scale;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx, sy - hgt);
    ctx.stroke();
    const wave = Math.sin(time * 6) * 3 * scale;
    ctx.fillStyle = '#e8312f';
    ctx.beginPath();
    ctx.moveTo(sx, sy - hgt);
    ctx.quadraticCurveTo(sx + 12 * scale, sy - hgt + 2 * scale + wave, sx + 24 * scale, sy - hgt + 7 * scale + wave);
    ctx.quadraticCurveTo(sx + 12 * scale, sy - hgt + 12 * scale - wave, sx, sy - hgt + 15 * scale);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  // ---------- Plano topográfico ----------

  // Curvas de nivel (marching squares sobre una malla de 1 m). Altitudes absolutas.
  GC.contours = function (h, interval = 1) {
    const e = h.elev;
    if (!e) return [];
    if (e.contours && e.contours.interval === interval) return e.contours.levels;
    const nx = Math.floor(h.width);
    const ny = Math.floor(h.height);
    const z = new Float32Array((nx + 1) * (ny + 1));
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) z[j * (nx + 1) + i] = e.base + e.heightAt(i, j);
    const levels = [];
    const lo = Math.ceil((e.base + e.min) / interval) * interval;
    const hi = Math.floor((e.base + e.max) / interval) * interval;
    for (let L = lo; L <= hi + 1e-9; L += interval) {
      const segs = [];
      const cross = (x0, y0, a, x1, y1, b) => {
        const t = (L - a) / (b - a);
        return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
      };
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const a = z[j * (nx + 1) + i];
          const b = z[j * (nx + 1) + i + 1];
          const c = z[(j + 1) * (nx + 1) + i + 1];
          const d = z[(j + 1) * (nx + 1) + i];
          const pts = [];
          if (a < L !== b < L) pts.push(cross(i, j, a, i + 1, j, b));
          if (b < L !== c < L) pts.push(cross(i + 1, j, b, i + 1, j + 1, c));
          if (c < L !== d < L) pts.push(cross(i + 1, j + 1, c, i, j + 1, d));
          if (d < L !== a < L) pts.push(cross(i, j + 1, d, i, j, a));
          for (let k = 0; k + 1 < pts.length; k += 2) segs.push(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]);
        }
      }
      if (segs.length) levels.push({ level: Math.round(L * 100) / 100, segs: new Float32Array(segs) });
    }
    e.contours = { interval, levels };
    return levels;
  };

  // Color de la tinta hipsométrica: un solo tono, claro abajo y oscuro arriba.
  GC.PLAN_RAMP = [
    [0, [238, 242, 222]],
    [0.5, [190, 205, 150]],
    [1, [112, 132, 72]],
  ];
  GC.planTint = function (t) {
    const r = GC.PLAN_RAMP;
    t = GC.clamp(t, 0, 1);
    let k = 0;
    while (k < r.length - 2 && t > r[k + 1][0]) k++;
    const [t0, c0] = r[k];
    const [t1, c1] = r[k + 1];
    const u = (t - t0) / (t1 - t0);
    return c0.map((v, i) => Math.round(v + (c1[i] - v) * u));
  };

  GC.renderPlan = function (ctx, h, zoom) {
    const e = h.elev;
    ctx.fillStyle = '#d9ddd0';
    ctx.fillRect(-2000, -2000, h.width + 4000, h.height + 4000);
    if (e) {
      if (!e.tint && typeof document !== 'undefined') {
        const w = Math.ceil(h.width);
        const hg = Math.ceil(h.height);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = hg;
        const g = c.getContext('2d');
        const img = g.createImageData(w, hg);
        for (let j = 0; j < hg; j++) {
          for (let i = 0; i < w; i++) {
            const col = GC.planTint((e.heightAt(i, j) - e.min) / (e.max - e.min || 1));
            const k = (j * w + i) * 4;
            img.data[k] = col[0];
            img.data[k + 1] = col[1];
            img.data[k + 2] = col[2];
            img.data[k + 3] = 255;
          }
        }
        g.putImageData(img, 0, 0);
        e.tint = c;
      }
      if (e.tint) ctx.drawImage(e.tint, 0, 0, e.tint.width, e.tint.height);
    } else {
      ctx.fillStyle = 'rgb(238,242,222)';
      ctx.fillRect(0, 0, h.width, h.height);
    }

    const px = 1 / zoom; // un píxel de pantalla en metros
    const outline = (path, fill, stroke, width) => {
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill(path);
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width * px;
      ctx.stroke(path);
    };
    for (const p of h.fairways) outline(p.path, 'rgba(70,150,50,0.28)', 'rgba(40,110,30,0.9)', 1.5);
    for (const p of h.water) outline(p.path, 'rgba(60,140,210,0.75)', 'rgba(30,90,160,1)', 1.5);
    for (const p of h.bunkers) outline(p.path, 'rgba(240,215,150,0.95)', 'rgba(160,125,50,1)', 1);
    if (h.green) outline(h.green.path, 'rgba(90,190,70,0.55)', 'rgba(30,110,30,1)', 2);
    if (h.teeBox) outline(h.teeBox.path, 'rgba(90,190,70,0.45)', 'rgba(30,110,30,1)', 1.5);
    ctx.strokeStyle = 'rgba(30,80,30,0.7)';
    ctx.lineWidth = px;
    for (const t of h.trees) {
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // curvas de nivel cada metro; maestras cada 5 m
    for (const lv of GC.contours(h, 1)) {
      const major = Math.abs(lv.level % 5) < 1e-6;
      ctx.strokeStyle = major ? 'rgba(90,60,25,0.85)' : 'rgba(110,80,40,0.45)';
      ctx.lineWidth = (major ? 1.6 : 0.8) * px;
      ctx.beginPath();
      const s = lv.segs;
      for (let k = 0; k < s.length; k += 4) {
        ctx.moveTo(s[k], s[k + 1]);
        ctx.lineTo(s[k + 2], s[k + 3]);
      }
      ctx.stroke();
    }

    ctx.save();
    ctx.strokeStyle = 'rgba(40,40,40,0.6)';
    ctx.lineWidth = px;
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.strokeRect(0, 0, h.width, h.height);
    ctx.restore();
  };

  // Puntos donde rotular las curvas maestras: separados entre sí y cerca del eje del hoyo.
  GC.contourLabels = function (h, every = 5, minGap = 45) {
    const out = [];
    const ax = h.pin.x - h.tee.x;
    const ay = h.pin.y - h.tee.y;
    const len = Math.hypot(ax, ay) || 1;
    for (const lv of GC.contours(h, 1)) {
      if (Math.abs(lv.level % every) > 1e-6) continue;
      const cands = [];
      const s = lv.segs;
      for (let k = 0; k < s.length; k += 4) {
        const x = (s[k] + s[k + 2]) / 2;
        const y = (s[k + 1] + s[k + 3]) / 2;
        if (x < 8 || y < 8 || x > h.width - 8 || y > h.height - 8) continue;
        const off = Math.abs((x - h.tee.x) * ay - (y - h.tee.y) * ax) / len;
        cands.push({ x, y, off });
      }
      cands.sort((a, b) => a.off - b.off);
      const mine = [];
      for (const c of cands) {
        if (mine.length >= 3) break;
        if (mine.every((m) => Math.hypot(m.x - c.x, m.y - c.y) > minGap)) mine.push(c);
      }
      mine.forEach((m) => out.push({ x: m.x, y: m.y, level: lv.level }));
    }
    return out;
  };

  // Perfil de alturas entre dos puntos: [{d, z}] con z absoluta.
  GC.profile = function (h, a, b, step = 2) {
    const len = GC.dist(a, b);
    const n = Math.max(2, Math.ceil(len / step));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      pts.push({ d: len * t, z: (h.elev ? h.elev.base : 0) + h.heightAt(x, y), x, y });
    }
    return pts;
  };

  GC.altitude = (h, p) => (h.elev ? h.elev.base + h.heightAt(p.x, p.y) : null);

  // Miniatura del hoyo (menú).
  GC.renderThumb = function (canvas, raw, teeKey) {
    const h = GC.prepareHole(raw, teeKey);
    const ctx = canvas.getContext('2d');
    const rot = GC.holeRotation(h);
    const cam = GC.fitCamera(GC.holeCorners(h), rot, { w: canvas.width - 8, h: canvas.height - 8 }, 10, 0.01, 100);
    const view = { cx: canvas.width / 2, cy: canvas.height / 2 };
    ctx.save();
    GC.applyCamera(ctx, cam, view);
    GC.renderHole(ctx, h, 0);
    ctx.restore();
    const p = GC.worldToScreen(cam, view, h.pin);
    GC.drawFlag(ctx, p.x, p.y, 0.45, 0, 2);
    const t = GC.worldToScreen(cam, view, h.tee);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(t.x, t.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  };

  // ---------- Almacenamiento de hoyos propios ----------

  const STORE_KEY = 'golfclash-sotoverde-hoyos';

  GC.store = {
    list() {
      try {
        return JSON.parse(localStorage.getItem(STORE_KEY)) || [];
      } catch (e) {
        return [];
      }
    },
    write(list) {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(list));
        return true;
      } catch (e) {
        return false;
      }
    },
    get(id) {
      return GC.store.list().find((h) => h.id === id) || null;
    },
    save(hole) {
      const list = GC.store.list().filter((h) => h.id !== hole.id);
      list.push(hole);
      return GC.store.write(list);
    },
    remove(id) {
      return GC.store.write(GC.store.list().filter((h) => h.id !== id));
    },
  };

  GC.findHole = function (id) {
    return (GC.BUILTIN_HOLES || []).find((h) => h.id === id) || GC.store.get(id);
  };

  // "campo" (por defecto: hoyos reales y ejemplos), "mios", "todos" o ids separados por comas.
  GC.resolveHoleList = function (param) {
    const builtin = GC.BUILTIN_HOLES || [];
    if (!param || param === 'campo') return builtin;
    if (param === 'mios') return GC.store.list();
    if (param === 'todos') return builtin.concat(GC.store.list());
    return param.split(',').map(GC.findHole).filter(Boolean);
  };

  // Comprueba que un objeto tiene la forma mínima de un hoyo.
  GC.validateHole = function (h) {
    const errors = [];
    if (!h || typeof h !== 'object') return ['No es un objeto de hoyo'];
    if (!h.id) errors.push('Falta "id"');
    if (!(h.width > 0) || !(h.height > 0)) errors.push('Faltan "width"/"height" en metros');
    if (!h.tee || h.tee.x == null) errors.push('Falta el tee');
    if (!h.pin || h.pin.x == null) errors.push('Falta la bandera');
    if (!h.green || h.green.length < 3) errors.push('Falta el green');
    return errors;
  };
})(typeof window !== 'undefined' ? window : globalThis);
