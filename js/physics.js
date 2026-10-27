/*
 * Física simplificada del golpe: vuelo con viento, bote y rodadura con pendiente.
 * Sin dependencias del DOM para poder probarla con Node.
 */
(function (global) {
  'use strict';
  const GC = (global.GC = global.GC || {});

  const WIND_FACTOR = 0.35;
  GC.ROLL_GRAVITY = 9.81 * (5 / 7); // aceleración de una bola rodando por unidad de pendiente
  GC.BOUNCE_KICK = 14; // m/s cuesta abajo por unidad de pendiente al botar en una ladera
  GC.MAX_KICK = 5;

  // Aceleración que el terreno da a la bola en (x, y) según la superficie.
  GC.slopeAccel = function (h, x, y, surf) {
    if (surf === 'green') return { x: h.slope.x, y: h.slope.y };
    if (!h.elev || surf === 'sand') return { x: 0, y: 0 };
    const g = h.gradAt(x, y);
    return { x: -GC.ROLL_GRAVITY * g.x, y: -GC.ROLL_GRAVITY * g.y };
  };

  // Velocidad tras el bote: la rodadura del golpe más el rebote hacia el lado bajo de la ladera.
  GC.landingVelocity = function (h, pos, dir, rollSpeed, surf) {
    const info = GC.SURFACES[surf];
    let vx = dir.x * rollSpeed;
    let vy = dir.y * rollSpeed;
    if (h.elev && surf !== 'green' && info.kick) {
      const g = h.gradAt(pos.x, pos.y);
      let kx = -g.x * GC.BOUNCE_KICK * info.kick;
      let ky = -g.y * GC.BOUNCE_KICK * info.kick;
      const k = Math.hypot(kx, ky);
      if (k > GC.MAX_KICK) {
        kx *= GC.MAX_KICK / k;
        ky *= GC.MAX_KICK / k;
      }
      vx += kx;
      vy += ky;
    }
    return { x: vx, y: vy };
  };

  // Distancia que "juega" un golpe: la recta más el desnivel (1 m de subida ≈ 1 m más).
  GC.playsLike = (h, from, to) => GC.dist(from, to) + (h.heightAt(to.x, to.y) - h.heightAt(from.x, from.y));

  // Vector de viento en m/s a partir de {speed km/h, angle brújula}.
  GC.windVector = (wind) => {
    const v = GC.compassVec(wind.angle);
    const ms = wind.speed / 3.6;
    return { x: v.x * ms, y: v.y * ms };
  };

  GC.randomWind = (rand = Math.random) => ({
    speed: Math.round(rand() * 24),
    angle: Math.round(rand() * 360),
  });

  /*
   * Golpe completo (no putt).
   * power 0..1 (1 = la bola cae en la diana), needle -1..1 (0 = centro).
   * spin: -1 efecto atrás, 0 normal, 1 efecto adelante.
   */
  GC.computeShot = function (h, ball, target, club, power, needle, wind, spin) {
    const lie = h.surfaceAt(ball.x, ball.y);
    const lieInfo = GC.SURFACES[lie] || GC.SURFACES.rough;
    const dx = target.x - ball.x;
    const dy = target.y - ball.y;
    const perfect = Math.abs(needle) < GC.PERFECT_ZONE;
    const miss = perfect ? 0 : Math.abs(needle);

    let carry = Math.hypot(dx, dy) * GC.clamp(power, 0, 1);
    carry *= 1 - 0.12 * miss;
    const devDeg = perfect ? 0 : needle * club.spread * lieInfo.scatter;
    const angle = Math.atan2(dy, dx) + (devDeg * Math.PI) / 180;

    const landing0 = { x: ball.x + Math.cos(angle) * carry, y: ball.y + Math.sin(angle) * carry };
    const flightTime = 2 + carry / 45;
    const wv = GC.windVector(wind);
    const drift = { x: wv.x * flightTime * WIND_FACTOR, y: wv.y * flightTime * WIND_FACTOR };
    const landing = { x: landing0.x + drift.x, y: landing0.y + drift.y };

    // dirección real de llegada (incluye el viento)
    const ldx = landing.x - ball.x;
    const ldy = landing.y - ball.y;
    const len = Math.hypot(ldx, ldy) || 1;

    return {
      start: { x: ball.x, y: ball.y },
      landing0,
      landing,
      drift,
      carry,
      perfect,
      dir: { x: ldx / len, y: ldy / len },
      apex: Math.max(4, carry * club.apex),
      duration: 0.9 + carry / 170,
      rollDistance: carry * club.roll * (1 + 0.8 * spin),
    };
  };

  // Posición y altura de la bola en vuelo, t de 0 a 1.
  GC.flightPosition = function (shot, t) {
    return {
      x: shot.start.x + (shot.landing0.x - shot.start.x) * t + shot.drift.x * t * t,
      y: shot.start.y + (shot.landing0.y - shot.start.y) * t + shot.drift.y * t * t,
      h: shot.apex * 4 * t * (1 - t),
    };
  };

  // Velocidad inicial para recorrer `distance` metros con la fricción dada.
  GC.speedFor = (distance, friction) => Math.sqrt(2 * friction * Math.abs(distance));

  // Velocidad de un putt: potencia 0..1 con curva suave para controlar los cortos.
  GC.puttDistance = (power) => GC.MAX_PUTT * Math.pow(GC.clamp(power, 0, 1), 1.5);

  GC.startRoll = function (pos, dir, speed) {
    return GC.startRollV(pos, { x: dir.x * speed, y: dir.y * speed });
  };

  GC.startRollV = (pos, v) => ({ x: pos.x, y: pos.y, vx: v.x, vy: v.y, time: 0, lipped: false, result: null });

  /*
   * Avanza la rodadura dt segundos. Rellena roll.result con:
   *   'holed' | 'water' | 'ob' | 'stopped'
   */
  GC.stepRoll = function (h, roll, dt) {
    const sub = 1 / 240;
    let left = dt;
    while (left > 0 && !roll.result) {
      const step = Math.min(sub, left);
      left -= step;
      roll.time += step;

      const surf = h.surfaceAt(roll.x, roll.y);
      if (surf === 'water' || surf === 'ob') {
        roll.result = surf;
        return roll;
      }
      const info = GC.SURFACES[surf];
      let speed = Math.hypot(roll.vx, roll.vy);
      if (speed > 0) {
        const dec = Math.min(speed, info.friction * step);
        roll.vx -= (roll.vx / speed) * dec;
        roll.vy -= (roll.vy / speed) * dec;
      }
      // en el green manda el plano ajustado (el MDT de 5 m es demasiado grueso para él)
      const acc = GC.slopeAccel(h, roll.x, roll.y, surf);
      roll.vx += acc.x * step;
      roll.vy += acc.y * step;
      roll.x += roll.vx * step;
      roll.y += roll.vy * step;
      speed = Math.hypot(roll.vx, roll.vy);

      const dPin = Math.hypot(roll.x - h.pin.x, roll.y - h.pin.y);
      if (dPin < GC.CUP_RADIUS) {
        if (speed < GC.CAPTURE_SPEED) {
          roll.x = h.pin.x;
          roll.y = h.pin.y;
          roll.vx = roll.vy = 0;
          roll.result = 'holed';
          return roll;
        }
        if (!roll.lipped) {
          // escupe: la bola se desvía y pierde velocidad
          roll.lipped = true;
          const a = (Math.random() < 0.5 ? -1 : 1) * (0.3 + Math.random() * 0.4);
          const c = Math.cos(a);
          const s = Math.sin(a);
          const vx = roll.vx * c - roll.vy * s;
          const vy = roll.vx * s + roll.vy * c;
          roll.vx = vx * 0.75;
          roll.vy = vy * 0.75;
        }
      } else if (dPin > GC.CUP_RADIUS * 3) {
        roll.lipped = false;
      }

      // se para si va despacio y la pendiente no puede con el rozamiento de la hierba
      if ((speed < 0.04 && Math.hypot(acc.x, acc.y) < info.friction) || roll.time > 25) {
        roll.vx = roll.vy = 0;
        roll.result = 'stopped';
      }
    }
    return roll;
  };

  // Simula una rodadura completa (útil para pruebas).
  GC.simulateRoll = function (h, roll) {
    while (!roll.result) GC.stepRoll(h, roll, 0.1);
    return roll;
  };
})(typeof window !== 'undefined' ? window : globalThis);
