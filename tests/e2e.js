/*
 * Pruebas de la app en un navegador real (Playwright + Chromium):
 *   node tests/e2e.js
 * Requiere `playwright` (npm i -D playwright && npx playwright install chromium) salvo donde ya venga instalado.
 * Levanta un servidor estático propio; la base de datos y la IA de claude.ai se simulan en la página.
 * Los datos de las vueltas son inventados.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' };
let failures = 0;
const check = (cond, what) => {
  console.log(`${cond ? '  ok ' : '  FALLO'} ${what}`);
  if (!cond) failures++;
};

function serve() {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, () => ok(server)));
}

const course = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, `campos/sotoverde-${String(n).padStart(2, '0')}.json`), 'utf8'));
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

// Vuelta con golpes en el mapa (hoyos 1-3) e importada de tarjeta (inventada).
function fixtures() {
  const h1 = course(1);
  const h3 = course(3);
  const t3 = h3.tees.amarillas;
  const mid = lerp(t3, h3.pin, 0.65);
  const mapped = {
    id: 'vprueba', v: 1, course: 'sotoverde', date: '2026-10-20T10:00:00.000Z', tees: 'amarillas', route: '18',
    holes: Array.from({ length: 18 }, (_, i) => i + 1), cur: 0, finished: false, createdAt: 'x', updatedAt: '2026-10-20T10:00:00.000Z',
    scores: {
      1: { entries: [{ t: 's', x: h1.pin.x + 4, y: h1.pin.y + 2, c: 'pw', l: 'green' }], putts: 2, done: true, ts: 1 },
      3: { entries: [{ t: 's', x: mid.x, y: mid.y, c: 'dr', l: 'fairway' }, { t: 's', x: h3.pin.x - 2, y: h3.pin.y + 3, c: 'h9', l: 'green' }], putts: 1, done: true, ts: 1 },
    },
  };
  const scores = {};
  const card = [3, 4, 5, 3, 4, 5, 3, 4, 4, 3, 3, 4, 3, 6, 3, 5, 4, 3];
  card.forEach((k, i) => (scores[i + 1] = { entries: [], putts: 0, done: true, total: k }));
  const imported = {
    id: 'tprueba', v: 1, course: 'sotoverde', source: 'tarjeta', date: '2026-09-01T12:00:00', tees: 'amarillas', route: '18',
    holes: Array.from({ length: 18 }, (_, i) => i + 1), cur: 0, finished: true, scores, event: 'PRUEBA INVENTADA',
    official: { gross: 69, stableford: 36, playingHcp: 9 }, createdAt: 'x', updatedAt: '2026-09-01T12:00:00',
  };
  return { mapped, imported };
}

// Base de datos y usuario de claude.ai simulados (sobreviven a recargas en sessionStorage).
function mockClaude({ withDb, withSample }) {
  const store = JSON.parse(sessionStorage.getItem('mockdb') || '{}');
  const keep = () => sessionStorage.setItem('mockdb', JSON.stringify(store));
  window.__mock = { store, fail: false, writes: 0, prompts: [] };
  const snap = (id, v) => ({ id, exists: !!v, data: () => (v ? JSON.parse(JSON.stringify(v)) : undefined), metadata: { hasPendingWrites: false } });
  const ref = (key) => ({
    id: key.split('/').pop(),
    async get() { return snap(key.split('/').pop(), store[key]); },
    async set(d) {
      if (window.__mock.fail) throw { code: 'unavailable', message: 'sin conexión' };
      store[key] = JSON.parse(JSON.stringify(d));
      window.__mock.writes++;
      keep();
    },
    async delete() { delete store[key]; keep(); },
  });
  const col = (p) => ({
    doc: (id) => ref(`${p}/${id}`),
    async get() {
      const docs = Object.keys(store).filter((k) => k.startsWith(p + '/')).map((k) => snap(k.split('/').pop(), store[k]));
      return { docs, size: docs.length, empty: !docs.length };
    },
    onSnapshot(next) {
      window.__mock.emit = (key) => next({ docs: [], docChanges: () => [{ type: 'modified', doc: snap(key.split('/').pop(), store[key]) }], metadata: {} });
      return () => {};
    },
  });
  const sample = async (input, opts) => {
    window.__mock.prompts.push(input);
    const text = 'Buen golpe: sigue así.';
    opts.onText({ text, delta: text });
    return { text, truncated: false };
  };
  sample.json = async (input) => {
    window.__mock.prompts.push(input);
    return { club: 'h7', toPin: 25, distance: null, side: 'derecha', lie: 'rough' };
  };
  window.claude = {
    use: async (name) => {
      if (name === 'db') return withDb ? { collection: col, doc: (k) => ref(k) } : null;
      if (name === 'user') return withDb ? { id: async () => 'u_prueba' } : null;
      if (name === 'sample') return withSample ? sample : null;
      if (name === 'mcp' && withSample) {
        return {
          callTool: async (server, tool, input) => {
            window.__mock.mcp = { server, tool, input };
            return { content: [], payload: { currentConditions: { temperatureValue: 8.4, now: '1:00', phrase: 'Despejado', extended: { wind: 'ONO 14 km/h', windValue: 14 } } } };
          },
        };
      }
      return null;
    },
  };
}

async function main() {
  const server = await serve();
  const base = `http://localhost:${server.address().port}/index.html`;
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const { mapped, imported } = fixtures();

  async function page({ local = [], withDb = false, withSample = false, viewport = { width: 390, height: 844 }, ctx = null } = {}) {
    const context = ctx || (await browser.newContext({ viewport }));
    const p = await context.newPage();
    p.errors = [];
    p.requests = [];
    p.on('pageerror', (e) => p.errors.push(e.message));
    p.on('request', (r) => p.requests.push(r.url()));
    await p.addInitScript(([local, withDb, withSample, mock]) => {
      if (local.length && !sessionStorage.getItem('seeded')) {
        localStorage.setItem('sotoverde-vueltas', JSON.stringify(local));
        sessionStorage.setItem('seeded', '1');
      }
      if (withDb || withSample) new Function('o', `(${mock})(o)`)({ withDb, withSample });
    }, [local, withDb, withSample, mockClaude.toString()]);
    await p.goto(base);
    return p;
  }

  console.log('Portada');
  {
    const p = await page();
    await p.waitForSelector('#tour .tour-play');
    check(!p.requests.some((u) => u.includes('campo3d.js')), 'no descarga los datos 3D hasta reproducir');
    check(p.errors.length === 0, 'sin errores');
    await p.context().close();
  }

  console.log('Anotar un hoyo');
  {
    const p = await page();
    await p.waitForSelector('#start:not([disabled])');
    await p.click('#start');
    await p.waitForSelector('#map canvas');
    await p.waitForTimeout(400);
    const box = await (await p.$('#map canvas')).boundingBox();
    const pin = await p.evaluate(() => window.__vuelta.pinScreen());
    await p.mouse.click(box.x + pin.x + 4, box.y + pin.y + 10);
    await p.click('#commit');
    await p.waitForTimeout(400);
    await p.click('#p-plus');
    await p.click('#finish');
    await p.waitForTimeout(400);
    const r = await p.evaluate(() => window.__vuelta.rounds[0]);
    check(r.scores[1].done && r.scores[1].entries.length === 1 && r.scores[1].putts === 1, 'golpe, putt y hoyo terminado');
    check(p.errors.length === 0, 'sin errores');
    await p.context().close();
  }

  console.log('Dictar un golpe');
  {
    const p = await page({ withSample: true });
    await p.waitForSelector('#start:not([disabled])');
    await p.click('#start');
    await p.waitForSelector('#dictate');
    await p.click('#dictate');
    await p.fill('#dictate-text', 'hierro 7, rough a la derecha, me quedan 25');
    await p.click('#dictate-form [type="submit"]');
    await p.waitForTimeout(500);
    const g = await p.evaluate(() => {
      const ui = window.__vuelta.ui;
      return ui && ui.ghost ? { club: ui.selectedClub, lie: window.__vuelta.lieAt(ui.ghost) } : null;
    });
    check(g && g.club === 'h7' && g.lie === 'rough', `la IA coloca la bola y el palo (${JSON.stringify(g)})`);
    check(p.errors.length === 0, 'sin errores');
    await p.context().close();
  }

  console.log('Tiempo real');
  {
    const p = await page({ withSample: true });
    await p.waitForSelector('[data-c="f-live"]');
    await p.click('[data-c="f-live"]');
    await p.waitForTimeout(400);
    const temp = await p.locator('.cond-grid .stepper .val').first().textContent();
    const wind = await p.locator('.cond-grid .stepper .val').nth(1).textContent();
    const dir = await p.locator('[data-c="f-from"][aria-pressed="true"]').textContent();
    check(temp === '8°' && wind === '14' && dir === 'NO', `rellena temperatura, viento y dirección (${temp}, ${wind}, ${dir})`);
    check(p.errors.length === 0, 'sin errores');
    await p.context().close();
  }

  console.log('Fusión de vueltas');
  {
    const p = await page();
    await p.waitForFunction(() => window.__vuelta);
    const m = await p.evaluate(() => {
      const base = { id: 'x', date: 'd', holes: [1, 2], scores: {}, updatedAt: '1' };
      const remote = { ...base, updatedAt: '2', scores: { 1: { entries: [], putts: 3, done: true, ts: 10 }, 2: { entries: [], putts: 2, done: true, ts: 50 } }, chat: [{ role: 'user', content: 'a', at: '1' }] };
      const local = { ...base, updatedAt: '3', scores: { 1: { entries: [], putts: 1, done: true, ts: 40 } }, chat: [{ role: 'user', content: 'b', at: '2' }] };
      return window.__vuelta.mergeRounds(remote, local);
    });
    check(m.scores[1].putts === 1 && m.scores[2].putts === 2, 'cada hoyo se queda con su versión más reciente');
    check(m.chat.length === 2, 'los comentarios se unen');
    await p.context().close();
  }

  console.log('Guardado sin conexión y desde dos dispositivos');
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await page({ withDb: true, ctx });
    await p.evaluate((r) => {
      window.__mock.store['data/users/u_prueba/vprueba'] = r;
      sessionStorage.setItem('mockdb', JSON.stringify(window.__mock.store));
    }, mapped);
    await p.reload();
    await p.waitForSelector('.round-row[data-id="vprueba"]');
    // sin conexión: el cambio queda pendiente en el móvil
    await p.evaluate(() => { window.__mock.fail = true; });
    await p.click('.round-row[data-id="vprueba"] [data-act="card"]');
    await p.click('tr.link[data-i="1"]');
    await p.waitForSelector('#map canvas');
    await p.waitForTimeout(300);
    const box = await (await p.$('#map canvas')).boundingBox();
    const pin = await p.evaluate(() => window.__vuelta.pinScreen());
    await p.mouse.click(box.x + pin.x + 3, box.y + pin.y + 12);
    await p.click('#commit');
    await p.waitForTimeout(1200);
    const pending = await p.evaluate(() => JSON.parse(localStorage.getItem('sotoverde-vueltas-pendiente-u_prueba') || '{}'));
    check(pending.vprueba && pending.vprueba.scores[2] && pending.vprueba.scores[2].entries.length === 1, 'sin conexión, el golpe queda guardado en el móvil');
    // mientras tanto, otro dispositivo apunta el hoyo 5
    await p.evaluate(() => {
      const d = window.__mock.store['data/users/u_prueba/vprueba'];
      d.scores[5] = { entries: [], putts: 2, done: false, ts: Date.now() + 1 };
      d.updatedAt = new Date().toISOString();
      sessionStorage.setItem('mockdb', JSON.stringify(window.__mock.store));
    });
    // vuelve la cobertura (al recargar la página)
    await p.evaluate(() => { window.__mock.fail = false; });
    await p.reload();
    await p.waitForSelector('.round-row[data-id="vprueba"]');
    await p.waitForTimeout(1500);
    const saved = await p.evaluate(() => window.__mock.store['data/users/u_prueba/vprueba']);
    check(saved.scores[2] && saved.scores[2].entries.length === 1, 'al volver la conexión se envía lo pendiente');
    check(saved.scores[5] && saved.scores[5].putts === 2, 'no pisa lo apuntado en otro dispositivo');
    check(saved.scores[1] && saved.scores[3], 'conserva el resto de hoyos');
    const left = await p.evaluate(() => JSON.parse(localStorage.getItem('sotoverde-vueltas-pendiente-u_prueba') || '{}'));
    check(!left.vprueba, 'y deja de estar pendiente');
    check(p.errors.length === 0, 'sin errores');
    await ctx.close();
  }

  console.log('Tarjeta importada');
  {
    const p = await page({ local: [imported] });
    await p.waitForSelector('.round-row[data-id="tprueba"]');
    await p.click('.round-row[data-id="tprueba"] [data-act="edit"]');
    await p.waitForSelector('.stepper.sm');
    const before = (await p.locator('.big-score').textContent()).trim();
    await p.click('button[data-h="1"][data-d="-1"]');
    const after = (await p.locator('.big-score').textContent()).trim();
    check(before.startsWith('69') && after.startsWith('68'), `editar golpes cambia el total (${before} → ${after})`);
    const stat = await p.locator('.stat').first().textContent();
    check(/oficial 36/.test(stat), 'el Stableford se recalcula y recuerda el oficial');
    check(p.errors.length === 0, 'sin errores');
    await p.context().close();
  }

  console.log('Mi progreso');
  {
    const p = await page({ local: [imported, mapped] });
    await p.waitForSelector('#progress');
    await p.click('#progress');
    await p.waitForSelector('#holes svg');
    check((await p.locator('#holes g[tabindex]').count()) === 18, 'barra de cada hoyo jugado');
    check((await p.locator('#club-pick button').count()) >= 2, 'palos con golpes en el mapa para la dispersión');
    await p.click('#hole-pick button[data-n="3"]');
    check(/2 golpes apuntados/.test(await p.locator('#shotmap-info').textContent()), 'mapa de golpes del hoyo');
    check(p.errors.length === 0, 'sin errores');
    await p.context().close();
  }

  console.log('Resumen 3D y comentarios');
  {
    const p = await page({ local: [mapped], withSample: true });
    await p.waitForSelector('.round-row .r3d');
    await p.click('.round-row .r3d');
    await p.waitForSelector('#replay.playing', { timeout: 30000 });
    check(p.requests.some((u) => u.includes('campo3d.js')), 'carga los datos 3D al reproducir');
    const on = () => p.locator('#replay .tour-prog span.on').getAttribute('title');
    const box = await p.locator('#replay').boundingBox();
    const y = box.y + box.height * 0.4;
    await p.mouse.move(box.x + box.width * 0.8, y);
    await p.mouse.down();
    await p.mouse.move(box.x + box.width * 0.2, y + 5, { steps: 5 });
    await p.mouse.up();
    await p.waitForTimeout(500);
    check((await on()) === 'Hoyo 1', 'deslizar pasa al hoyo siguiente');
    await p.fill('.coach textarea', 'Salí bien del tee');
    await p.click('.coach [type="submit"]');
    await p.waitForTimeout(800);
    const chat = await p.evaluate(() => JSON.parse(localStorage.getItem('sotoverde-vueltas'))[0].chat || []);
    check(chat.length === 2 && chat[0].hole === 1, 'el comentario se guarda con su hoyo y con la respuesta');
    check(p.errors.length === 0, 'sin errores');
    await p.context().close();
  }

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} comprobaciones fallidas` : '\nTodo correcto');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
