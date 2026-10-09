(() => {
  'use strict';

  /* ---------- Configuration ---------- */
  const TEXT = 'I LOVE YOU';
  const FONT_STACK = 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const OUTLINE_STEPS = 1440;
  const HEART_HALF_WIDTH = 16, HEART_HALF_HEIGHT = 14.5;   // unit-space extents used for radial depth

  const INTRO_DELAY_MAX = 0.9;      // seconds over which particles start travelling
  const HEARTBEAT_START = 2.5;      // seconds, when the first beat lands
  const CAPTION_AT = 3.2;
  const BEAT_PERIOD = 1.5;
  const BEAT_EXPAND = 0.034;        // fractional radius growth on the strong beat
  const RIPPLE_DELAY = 0.075;       // seconds for the pulse to travel centre -> edge
  const BEAT_BINS = 24;

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;

  const canvas = document.getElementById('scene');
  const ctx = canvas.getContext('2d');
  const caption = document.getElementById('caption');
  const measureCtx = document.createElement('canvas').getContext('2d');

  /* ---------- Shared state ---------- */
  const view = { w: 0, h: 0, dpr: 1, cx: 0, cy: 0, scale: 1, heartW: 0, heartH: 0, fontPx: 5 };
  const mouse = { x: -9999, y: -9999, sx: -9999, sy: -9999, active: false, strength: 0 };
  const beatBins = new Float32Array(BEAT_BINS);
  let outline = null;               // Float64Array [x0,y0,x1,y1...] in centred heart units
  let sprites = null;               // { small, main }
  let heartGlow = null;
  let stars = [];
  let time = 0, captionShown = false;

  // Particle struct-of-arrays
  let count = 0;
  let px, py, vx, vy, offX, offY, baseAlpha, phase, delay, radial, spriteIdx, binIdx, drawAlpha, drawBeat;
  let startX, startY;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const smoothstep = (e0, e1, v) => { const t = clamp((v - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

  /* ---------- Heart generation ---------- */
  function buildOutline() {
    const raw = new Float64Array(OUTLINE_STEPS * 2);
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < OUTLINE_STEPS; i++) {
      const t = (i / OUTLINE_STEPS) * Math.PI * 2;
      const s = Math.sin(t);
      const x = 16 * s * s * s;
      const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
      raw[i * 2] = x; raw[i * 2 + 1] = y;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const midY = (minY + maxY) / 2;
    for (let i = 0; i < OUTLINE_STEPS; i++) raw[i * 2 + 1] -= midY;
    outline = raw;
    view.unitH = maxY - minY;
  }

  // Horizontal spans [a,b] of the heart interior at height y
  function scanRow(y) {
    const xs = [];
    for (let i = 0; i < OUTLINE_STEPS; i++) {
      const j = (i + 1) % OUTLINE_STEPS;
      const y0 = outline[i * 2 + 1], y1 = outline[j * 2 + 1];
      if ((y0 <= y) !== (y1 <= y)) {
        const x0 = outline[i * 2], x1 = outline[j * 2];
        xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
      }
    }
    xs.sort((a, b) => a - b);
    const spans = [];
    for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i], xs[i + 1]]);
    return spans;
  }

  function signedArea() {
    let a = 0;
    for (let i = 0; i < OUTLINE_STEPS; i++) {
      const j = (i + 1) % OUTLINE_STEPS;
      a += outline[i * 2] * outline[j * 2 + 1] - outline[j * 2] * outline[i * 2 + 1];
    }
    return a;
  }

  /* Returns particle targets in unit space: interior rows, contour, and a dense core */
  function generateTargets() {
    const { scale, fontPx } = view;
    const mainW = sprites.main.textW / scale, mainH = fontPx / scale;
    const smallW = sprites.small.textW / scale, smallH = fontPx * 0.62 / scale;
    const targets = [];   // [ux, uy, spriteIdx, alpha]
    const rowH = mainH * 1.02, gap = mainW * 0.1;

    // 1. Interior: typeset rows, each fitted flush to the contour
    const halfH = view.unitH / 2;
    for (let y = -halfH + rowH * 0.5; y < halfH; y += rowH) {
      for (const [a, b] of scanRow(y)) {
        const len = b - a;
        if (len < mainW) continue;
        const n = Math.floor((len - mainW) / (mainW + gap)) + 1;
        const step = n > 1 ? (len - mainW) / (n - 1) : 0;
        for (let k = 0; k < n; k++) {
          const ux = n > 1 ? a + mainW / 2 + k * step : (a + b) / 2;
          targets.push([ux, y, 1, 0.5 + Math.random() * 0.3]);
        }
      }
    }
    const interiorCount = targets.length;

    // 2. Contour: arc-length spacing adapted to text proportions, tucked just inside the curve
    const orient = signedArea() > 0 ? 1 : -1;
    let acc = 0;
    for (let i = 0; i < OUTLINE_STEPS; i++) {
      const j = (i + 1) % OUTLINE_STEPS;
      const dx = outline[j * 2] - outline[i * 2], dy = outline[j * 2 + 1] - outline[i * 2 + 1];
      const segLen = Math.hypot(dx, dy);
      const tx = dx / segLen, ty = dy / segLen;
      const spacing = 1 / Math.hypot(tx / smallW, ty / smallH);
      acc += segLen;
      if (acc >= spacing) {
        acc = 0;
        const nx = -ty * orient, ny = tx * orient;
        const inset = 0.9 * (Math.abs(nx) * smallW / 2 + Math.abs(ny) * smallH / 2);
        targets.push([outline[j * 2] + nx * inset, outline[j * 2 + 1] + ny * inset, 0, 0.85 + Math.random() * 0.15]);
      }
    }

    // 3. Core: extra small particles, denser towards the centre
    const coreWanted = Math.round(interiorCount * 0.2);
    let placed = 0, attempts = 0;
    while (placed < coreWanted && attempts++ < coreWanted * 12) {
      const ux = (Math.random() * 2 - 1) * HEART_HALF_WIDTH;
      const uy = (Math.random() * 2 - 1) * halfH;
      const r = Math.hypot(ux / HEART_HALF_WIDTH, uy / HEART_HALF_HEIGHT);
      if (Math.random() > Math.exp(-r * r * 1.8)) continue;
      if (!scanRow(uy).some(([a, b]) => ux > a && ux < b)) continue;
      targets.push([ux, uy, 0, 0.35 + Math.random() * 0.25]);
      placed++;
    }
    return targets;
  }

  /* ---------- Sprites (pre-rendered glowing text) ---------- */
  function createSprite(fontSize) {
    const dpr = view.dpr, font = `800 ${fontSize}px ${FONT_STACK}`;
    measureCtx.font = font;
    const spacing = fontSize * 0.16, chars = [...TEXT];
    const widths = chars.map(c => measureCtx.measureText(c).width);
    const textW = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
    const pad = Math.ceil(fontSize * 1.1);
    const w = textW + pad * 2, h = fontSize + pad * 2;

    const c = document.createElement('canvas');
    c.width = Math.ceil(w * dpr); c.height = Math.ceil(h * dpr);
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.font = font; g.textBaseline = 'middle'; g.textAlign = 'left';

    const draw = () => {
      let x = pad;
      chars.forEach((ch, i) => { g.fillText(ch, x, h / 2 + fontSize * 0.04); x += widths[i] + spacing; });
    };
    g.shadowColor = 'rgba(255, 18, 52, 0.95)';
    g.shadowBlur = fontSize * 0.8 * dpr;
    g.fillStyle = 'rgba(255, 238, 232, 0.9)';
    draw();
    g.shadowBlur = 0; g.shadowColor = 'transparent';
    g.fillStyle = '#fff4ef';
    draw();
    return { canvas: c, w, h, textW };
  }

  function buildHeartGlow() {
    const q = 0.5, blur = Math.max(28, view.heartH * 0.09);
    const margin = Math.ceil(blur * 2.6);
    const gw = Math.ceil(view.heartW + margin * 2), gh = Math.ceil(view.heartH + margin * 2);
    const c = document.createElement('canvas');
    c.width = Math.ceil(gw * q); c.height = Math.ceil(gh * q);
    const g = c.getContext('2d');
    g.scale(q, q);
    // Draw the stroke far off-canvas so only its blurred shadow lands on the sprite
    g.shadowColor = 'rgba(255, 12, 48, 1)';
    g.shadowBlur = blur * q;
    g.shadowOffsetX = c.width;
    g.strokeStyle = '#ff0a30';
    g.lineWidth = blur * 0.55;
    g.lineJoin = 'round';
    g.beginPath();
    for (let i = 0; i < OUTLINE_STEPS; i++) {
      const x = gw / 2 + outline[i * 2] * view.scale - gw;
      const y = gh / 2 + outline[i * 2 + 1] * view.scale;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.closePath(); g.stroke();
    heartGlow = { canvas: c, w: gw, h: gh };
  }

  /* ---------- Particle set-up ---------- */
  function buildParticles() {
    const targets = generateTargets();
    count = targets.length;
    const f32 = () => new Float32Array(count);
    px = f32(); py = f32(); vx = f32(); vy = f32(); offX = f32(); offY = f32();
    baseAlpha = f32(); phase = f32(); delay = f32(); radial = f32();
    drawAlpha = f32(); drawBeat = f32(); startX = f32(); startY = f32();
    spriteIdx = new Uint8Array(count); binIdx = new Uint8Array(count);

    const settled = reducedMotion || time > 4;
    const reach = Math.max(view.w, view.h);
    for (let i = 0; i < count; i++) {
      const [ux, uy, sIdx, alpha] = targets[i];
      offX[i] = ux * view.scale; offY[i] = uy * view.scale;
      spriteIdx[i] = sIdx; baseAlpha[i] = alpha; phase[i] = Math.random() * Math.PI * 2;
      const r = Math.min(1, Math.hypot(ux / HEART_HALF_WIDTH, uy / HEART_HALF_HEIGHT));
      radial[i] = r; binIdx[i] = Math.min(BEAT_BINS - 1, Math.floor(r * BEAT_BINS));
      // contour assembles first, the core fills in last
      delay[i] = settled ? -10 : Math.random() * (INTRO_DELAY_MAX * 0.6) + (1 - r) * (INTRO_DELAY_MAX * 0.4);

      if (settled) {
        px[i] = view.cx + offX[i]; py[i] = view.cy + offY[i];
      } else {
        const angle = Math.random() * Math.PI * 2, dist = reach * (0.3 + Math.random() * 0.55);
        px[i] = view.cx + Math.cos(angle) * dist; py[i] = view.cy + Math.sin(angle) * dist;
        vx[i] = -Math.sin(angle) * 90; vy[i] = Math.cos(angle) * 90;   // slight swirl
      }
    }
  }

  function buildStars() {
    stars = Array.from({ length: 38 }, () => ({
      x: Math.random(), y: Math.random(), r: 0.4 + Math.random() * 0.7,
      a: 0.05 + Math.random() * 0.15, speed: 0.3 + Math.random() * 0.8, ph: Math.random() * 6.28
    }));
  }

  /* ---------- Responsive resizing ---------- */
  function resize() {
    const w = innerWidth, h = innerHeight;
    if (w === view.w && Math.abs(h - view.h) < 120 && view.w) return;  // ignore mobile toolbar jitter
    view.dpr = Math.min(devicePixelRatio || 1, 2);
    view.w = w; view.h = h;
    canvas.width = Math.round(w * view.dpr); canvas.height = Math.round(h * view.dpr);

    if (!outline) buildOutline();
    const portrait = w < 640;
    const widthUnits = 32.4;
    view.scale = Math.min((w * (portrait ? 0.86 : 0.78)) / widthUnits, (h * 0.66) / view.unitH);
    view.heartW = widthUnits * view.scale; view.heartH = view.unitH * view.scale;
    view.fontPx = clamp(Math.min(w, h) * 0.0068, 3.6, 6.4);
    view.cx = w / 2;
    view.cy = h / 2 - Math.min(26, h * 0.035);

    sprites = { main: createSprite(view.fontPx), small: createSprite(view.fontPx * 0.62) };
    buildHeartGlow();
    buildParticles();
    buildStars();
    caption.style.top = Math.round(view.cy + view.heartH / 2 + Math.max(30, view.heartH * 0.08)) + 'px';
  }

  /* ---------- Heartbeat ---------- */
  // Fast attack, slower release: exp(-((x)/width)^2) with different widths either side
  const pulse = x => { const k = x < 0 ? x / 0.045 : x / 0.11; return Math.exp(-k * k); };

  // lub (strong) -> return -> dub (weaker) -> return -> slight contraction -> pause
  function beatAt(t) {
    if (t < 0) return 0;
    const u = t % BEAT_PERIOD;
    const dip = -0.08 * Math.exp(-Math.pow((u - 0.74) / 0.17, 2));
    return pulse(u - 0.14) + 0.55 * pulse(u - 0.46) + dip;
  }

  function updateBeat() {
    const t = time - HEARTBEAT_START;
    const amp = reducedMotion ? 0.4 : 1;
    for (let b = 0; b < BEAT_BINS; b++) {
      beatBins[b] = beatAt(t - (b / BEAT_BINS) * RIPPLE_DELAY) * amp;
    }
  }

  /* ---------- Particle physics + mouse ---------- */
  function updateMouse(dt) {
    const follow = 1 - Math.exp(-dt * 16);
    if (mouse.sx < -9000) { mouse.sx = mouse.x; mouse.sy = mouse.y; }
    mouse.sx += (mouse.x - mouse.sx) * follow;
    mouse.sy += (mouse.y - mouse.sy) * follow;
    mouse.strength += ((mouse.active ? 1 : 0) - mouse.strength) * (1 - Math.exp(-dt * 6));
  }

  function updateParticles(dt) {
    const radius = view.heartH * 0.17, radiusSq = radius * radius;
    const force = 1800 * mouse.strength;
    const wobble = view.heartH * 0.0011;
    const t = time;

    for (let i = 0; i < count; i++) {
      const lt = t - delay[i];
      if (lt < 0) { drawAlpha[i] = 0; continue; }

      const b = beatBins[binIdx[i]];
      const expand = 1 + BEAT_EXPAND * b * (0.6 + 0.4 * radial[i]);
      const tx = view.cx + offX[i] * expand + Math.sin(t * 0.8 + phase[i]) * wobble;
      const ty = view.cy + offY[i] * expand + Math.cos(t * 0.65 + phase[i] * 1.3) * wobble;

      // Spring gets stiffer once the heart has formed
      const k = 11 + 46 * smoothstep(1.3, 2.3, lt);
      const c = 2 * 0.72 * Math.sqrt(k);
      let ax = (tx - px[i]) * k - vx[i] * c;
      let ay = (ty - py[i]) * k - vy[i] * c;

      if (force > 0) {
        const dx = px[i] - mouse.sx, dy = py[i] - mouse.sy, d2 = dx * dx + dy * dy;
        if (d2 < radiusSq && d2 > 0.01) {
          const d = Math.sqrt(d2), f = (1 - d / radius) ** 2 * force;
          ax += (dx / d) * f; ay += (dy / d) * f;
        }
      }
      vx[i] += ax * dt; vy[i] += ay * dt;
      px[i] += vx[i] * dt; py[i] += vy[i] * dt;

      drawAlpha[i] = baseAlpha[i] * smoothstep(0, 0.9, lt) * (1 + 0.4 * Math.max(0, b));
      drawBeat[i] = b;
    }
  }

  /* ---------- Rendering ---------- */
  function render() {
    const { w, h, dpr, cx, cy } = view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#020002';
    ctx.fillRect(0, 0, w, h);

    // Background stars
    ctx.fillStyle = '#ffe9e4';
    for (const s of stars) {
      ctx.globalAlpha = s.a * (0.55 + 0.45 * Math.sin(time * s.speed + s.ph));
      ctx.fillRect(s.x * w, s.y * h, s.r, s.r);
    }

    const assembled = reducedMotion ? 1 : smoothstep(1.2, 3.2, time);
    const beat = Math.max(0, beatBins[0]);

    ctx.globalCompositeOperation = 'lighter';

    // Ambient atmosphere: breathes with the beat, darkens in the pause
    const glowRadius = view.heartH * (0.8 + 0.07 * beat);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowRadius);
    grad.addColorStop(0, 'rgba(150, 6, 28, 1)');
    grad.addColorStop(0.55, 'rgba(70, 2, 14, 0.5)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.globalAlpha = assembled * (0.07 + 0.17 * beat);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Neon rim around the silhouette
    const pulseScale = 1 + BEAT_EXPAND * beatBins[0];
    ctx.globalAlpha = assembled * clamp(0.22 + 0.5 * beat, 0, 1);
    ctx.drawImage(heartGlow.canvas, cx - heartGlow.w * pulseScale / 2, cy - heartGlow.h * pulseScale / 2,
      heartGlow.w * pulseScale, heartGlow.h * pulseScale);

    // Text particles
    const list = [sprites.small, sprites.main];
    for (let i = 0; i < count; i++) {
      const a = drawAlpha[i];
      if (a <= 0.004) continue;
      const sp = list[spriteIdx[i]];
      const k = 1 + 0.07 * Math.max(0, drawBeat[i]);
      const dw = sp.w * k, dh = sp.h * k;
      ctx.globalAlpha = a > 1 ? 1 : a;
      ctx.drawImage(sp.canvas, px[i] - dw / 2, py[i] - dh / 2, dw, dh);
    }
  }

  /* ---------- Input ---------- */
  function bindPointer() {
    if (!finePointer) return;
    addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse') return;
      mouse.x = e.clientX; mouse.y = e.clientY; mouse.active = true;
    }, { passive: true });
    document.documentElement.addEventListener('pointerleave', () => { mouse.active = false; });
    addEventListener('blur', () => { mouse.active = false; });
  }

  /* ---------- Heartbeat sound ---------- */
const soundBtn = document.getElementById('sound');
const audio = { ctx: null, master: null, noise: null, enabled: false, lastCycle: -1 };

function createNoiseBuffer(ac) {
  const buffer = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.08), ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

// One soft thump: pitch-dropping sine + a harmonic so small speakers can hear it + a muffled click
function thump(when, strength, pitch) {
  const ac = audio.ctx;
  const body = ac.createGain(), tone = ac.createGain();
  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass'; filter.frequency.value = 420;

  const sub = ac.createOscillator();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(pitch * 1.9, when);
  sub.frequency.exponentialRampToValueAtTime(pitch, when + 0.09);

  const harmonic = ac.createOscillator();
  harmonic.type = 'triangle';
  harmonic.frequency.setValueAtTime(pitch * 3.8, when);
  harmonic.frequency.exponentialRampToValueAtTime(pitch * 2, when + 0.08);
  tone.gain.value = 0.3;

  body.gain.setValueAtTime(0.0001, when);
  body.gain.exponentialRampToValueAtTime(strength, when + 0.012);
  body.gain.exponentialRampToValueAtTime(0.0001, when + 0.26);

  sub.connect(body); harmonic.connect(tone); tone.connect(body);
  body.connect(filter); filter.connect(audio.master);
  sub.start(when); harmonic.start(when);
  sub.stop(when + 0.3); harmonic.stop(when + 0.3);

  const click = ac.createBufferSource();
  const clickFilter = ac.createBiquadFilter(), clickGain = ac.createGain();
  click.buffer = audio.noise;
  clickFilter.type = 'lowpass'; clickFilter.frequency.value = 200;
  clickGain.gain.setValueAtTime(strength * 0.5, when);
  clickGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
  click.connect(clickFilter); clickFilter.connect(clickGain); clickGain.connect(audio.master);
  click.start(when);
}

// Schedules each lub-dub slightly ahead, locked to the visual beat timeline
function scheduleBeatSound() {
  if (!audio.enabled) return;
  const cycle = Math.floor((time - HEARTBEAT_START + 0.3) / BEAT_PERIOD);
  if (cycle < 0 || cycle <= audio.lastCycle) return;
  audio.lastCycle = cycle;
  const cycleStart = audio.ctx.currentTime + (HEARTBEAT_START + cycle * BEAT_PERIOD - time);
  thump(cycleStart + 0.13, 0.9, 52);   // lub
  thump(cycleStart + 0.45, 0.5, 62);   // dub, weaker and a touch higher
}

function setSound(on) {
  if (on && !audio.ctx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    audio.ctx = new AudioCtx();
    audio.master = audio.ctx.createGain();
    audio.master.gain.value = 0.9;          // overall volume
    audio.master.connect(audio.ctx.destination);
    audio.noise = createNoiseBuffer(audio.ctx);
  }
  if (on) audio.ctx.resume();
  audio.enabled = on;
  audio.lastCycle = Math.max(-1, Math.floor((time - HEARTBEAT_START + 0.3) / BEAT_PERIOD));
  soundBtn.textContent = on ? 'sound on' : 'sound off';
  soundBtn.setAttribute('aria-pressed', String(on));
}

soundBtn.addEventListener('click', () => setSound(!audio.enabled));
addEventListener('keydown', e => { if (e.key === 'm' || e.key === 'M') setSound(!audio.enabled); });

  /* ---------- Main loop ---------- */
  let lastFrame = performance.now();
  function frame(now) {
    const dt = Math.min((now - lastFrame) / 1000, 1 / 30);
    lastFrame = now; time += dt;

    updateBeat();
    updateMouse(dt);
    updateParticles(dt);
    render();

    if (!captionShown && time > (reducedMotion ? 0.2 : CAPTION_AT)) {
      captionShown = true; caption.classList.add('visible');
    }
    requestAnimationFrame(frame);
  }

  resize();
  bindPointer();
  let resizePending = false;
  addEventListener('resize', () => {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(() => { resizePending = false; resize(); });
  });
  requestAnimationFrame(t => { lastFrame = t; requestAnimationFrame(frame); });
})();