/*
 * Hoyos de ejemplo. Son trazados ilustrativos para probar el juego,
 * NO réplicas medidas de ningún campo real. Para replicar un hoyo real
 * usa el editor (editor.html) sobre una foto satélite y exporta el JSON.
 *
 * Formato (todo en metros, y hacia abajo):
 *   tee/pin: {x, y}
 *   fairways, bunkers, water: listas de polígonos [[x, y], ...]
 *   green: un polígono [[x, y], ...]
 *   trees: [{x, y, r}]
 *   greenSlope: {angle (brújula, hacia dónde cae), strength 0..1}
 *   wind (opcional): {speed km/h, angle brújula hacia donde sopla}; si falta, es aleatorio
 */
(function (global) {
  'use strict';
  const GC = (global.GC = global.GC || {});

  const r1 = (v) => Math.round(v * 10) / 10;

  // Elipse como polígono.
  function ellipse(cx, cy, rx, ry, rotDeg = 0, n = 12) {
    const rot = (rotDeg * Math.PI) / 180;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = Math.cos(a) * rx;
      const y = Math.sin(a) * ry;
      pts.push([r1(cx + x * Math.cos(rot) - y * Math.sin(rot)), r1(cy + x * Math.sin(rot) + y * Math.cos(rot))]);
    }
    return pts;
  }

  // Calle a partir de una línea central [[x, y, ancho], ...].
  function ribbon(center) {
    const left = [];
    const right = [];
    center.forEach((p, i) => {
      const a = center[Math.max(0, i - 1)];
      const b = center[Math.min(center.length - 1, i + 1)];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const nx = -(b[1] - a[1]) / len;
      const ny = (b[0] - a[0]) / len;
      const w = p[2] / 2;
      left.push([r1(p[0] + nx * w), r1(p[1] + ny * w)]);
      right.push([r1(p[0] - nx * w), r1(p[1] - ny * w)]);
    });
    return left.concat(right.reverse());
  }

  function treeLine(x0, y0, x1, y1, n, r, jitterSeed) {
    const rand = GC.rng(jitterSeed);
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : i / (n - 1);
      out.push({
        x: r1(x0 + (x1 - x0) * t + (rand() - 0.5) * 6),
        y: r1(y0 + (y1 - y0) * t + (rand() - 0.5) * 6),
        r: r1(r * (0.8 + rand() * 0.4)),
      });
    }
    return out;
  }

  GC.EXAMPLE_HOLES = [
    {
      id: 'ejemplo-1',
      name: 'La Curva',
      number: 1,
      par: 4,
      width: 190,
      height: 345,
      tee: { x: 92, y: 322 },
      pin: { x: 138, y: 40 },
      fairways: [ribbon([[86, 262, 28], [94, 215, 34], [106, 160, 36], [120, 112, 34], [131, 78, 30]])],
      green: ellipse(137, 42, 15, 12, -10),
      bunkers: [
        ellipse(132, 150, 6, 9, 15, 10),
        ellipse(119, 58, 7, 4, -30, 10),
        ellipse(155, 28, 6, 3.5, 30, 10),
      ],
      water: [],
      trees: [
        ...treeLine(52, 300, 70, 95, 9, 8, 11),
        ...treeLine(150, 300, 168, 110, 8, 8, 12),
        ...treeLine(100, 18, 175, 12, 4, 7, 13),
      ],
      greenSlope: { angle: 210, strength: 0.45 },
    },
    {
      id: 'ejemplo-2',
      name: 'El Lago',
      number: 2,
      par: 3,
      width: 150,
      height: 205,
      tee: { x: 74, y: 188 },
      pin: { x: 80, y: 40 },
      fairways: [ellipse(78, 72, 20, 9, 0, 12)],
      green: ellipse(79, 42, 14, 12, 8),
      bunkers: [ellipse(60, 47, 4.5, 7.5, 10, 10), ellipse(86, 25, 9, 3.5, -8, 10)],
      water: [ellipse(76, 118, 44, 28, -6, 14)],
      trees: [
        ...treeLine(18, 40, 22, 175, 6, 8, 21),
        ...treeLine(130, 35, 132, 175, 6, 8, 22),
        { x: 42, y: 18, r: 7 },
        { x: 115, y: 20, r: 8 },
      ],
      greenSlope: { angle: 160, strength: 0.6 },
    },
    {
      id: 'ejemplo-3',
      name: 'El Bosque',
      number: 3,
      par: 4,
      width: 240,
      height: 330,
      tee: { x: 172, y: 312 },
      pin: { x: 54, y: 46 },
      fairways: [ribbon([[170, 268, 26], [168, 205, 34], [162, 152, 36], [142, 112, 34], [108, 86, 30], [78, 72, 26]])],
      green: ellipse(55, 48, 13, 12, 20),
      bunkers: [ellipse(73, 62, 6, 3.5, -20, 10), ellipse(38, 58, 4, 7, 15, 10), ellipse(178, 128, 5, 8, 25, 10)],
      water: [ellipse(212, 150, 18, 38, 10, 14)],
      trees: [
        { x: 112, y: 205, r: 10 },
        { x: 96, y: 180, r: 9 },
        { x: 124, y: 172, r: 8 },
        { x: 82, y: 150, r: 10 },
        { x: 104, y: 150, r: 7 },
        { x: 70, y: 205, r: 9 },
        { x: 120, y: 240, r: 8 },
        { x: 60, y: 120, r: 8 },
        ...treeLine(200, 300, 205, 210, 5, 8, 31),
        ...treeLine(120, 30, 210, 40, 6, 8, 32),
      ],
      greenSlope: { angle: 80, strength: 0.35 },
    },
  ];

  // Hoyos reales del campo (js/campos.js) primero y después los ejemplos.
  GC.BUILTIN_HOLES = (GC.COURSE_HOLES || []).concat(GC.EXAMPLE_HOLES);

  GC.shapes = { ellipse, ribbon, treeLine };
})(typeof window !== 'undefined' ? window : globalThis);
