// Comprobaciones básicas de los hoyos de ejemplo y de la geometría.
// Uso: node tests/check-holes.js
'use strict';
const assert = require('assert');
const path = require('path');

require(path.join(__dirname, '..', 'js', 'core.js'));
require(path.join(__dirname, '..', 'js', 'holes.js'));
const GC = globalThis.GC;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('ok   ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL ' + name + '\n     ' + e.message);
  }
}

check('pointInPoly: cuadrado', () => {
  const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert(GC.pointInPoly(sq, 5, 5));
  assert(!GC.pointInPoly(sq, 15, 5));
});

check('cámara: ida y vuelta mundo ↔ pantalla', () => {
  const cam = { x: 40, y: 80, zoom: 3.5, rot: 0.7 };
  const view = { cx: 200, cy: 300 };
  const p = { x: 12.5, y: -4 };
  const back = GC.screenToWorld(cam, view, GC.worldToScreen(cam, view, p));
  assert(Math.abs(back.x - p.x) < 1e-9 && Math.abs(back.y - p.y) < 1e-9);
});

check('rotación del hoyo: la bandera queda arriba', () => {
  const h = GC.prepareHole(GC.BUILTIN_HOLES[2]);
  const cam = { x: h.tee.x, y: h.tee.y, zoom: 1, rot: GC.holeRotation(h) };
  const s = GC.worldToScreen(cam, { cx: 0, cy: 0 }, h.pin);
  assert(Math.abs(s.x) < 1e-6 && s.y < 0, JSON.stringify(s));
});

for (const raw of GC.BUILTIN_HOLES) {
  check(`${raw.id}: estructura válida`, () => assert.deepStrictEqual(GC.validateHole(raw), []));
  const h = GC.prepareHole(raw);
  check(`${raw.id}: bandera en el green`, () => assert.strictEqual(h.surfaceAt(h.pin.x, h.pin.y), 'green'));
  check(`${raw.id}: tee jugable`, () => assert.strictEqual(h.surfaceAt(h.tee.x, h.tee.y), 'tee'));
  check(`${raw.id}: ningún árbol tapa tee ni green`, () => {
    for (const t of h.trees) {
      assert(GC.dist(t, h.tee) > t.r + 4, `árbol en ${t.x},${t.y} sobre el tee`);
      assert(!h.green || !GC.polyContains(h.green, t.x, t.y), `árbol en ${t.x},${t.y} dentro del green`);
    }
  });
  check(`${raw.id}: el par cuadra con la longitud`, () => {
    const expected = h.length <= 200 ? 3 : h.length <= 420 ? 4 : 5;
    assert.strictEqual(h.par, expected, `longitud ${h.length} m`);
  });
}

if (failures) {
  console.log(`\n${failures} comprobación(es) fallida(s)`);
  process.exit(1);
}
console.log('\nTodo correcto');
