/**
 * GrimDM — Canvas Instrument Gauges
 * Multi-ring vitals, stat radar, DM heartbeat, creature radar
 * Adapted from fleet instrument gallery with dark fairy tale palette
 */

// --- DPR-aware canvas setup ---
function dpr(canvas) {
  const d = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * d || canvas.height !== h * d) {
    canvas.width = w * d;
    canvas.height = h * d;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(d, 0, 0, d, 0, 0);
  return { ctx, w, h };
}

function rgba(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// --- Color palette (fairy tale, from GrimDM CSS vars) ---
const HP_COLOR = '#c94040';
const XP_COLOR = '#c9a84c';
const MANA_COLOR = '#4a7ab4';
const RADAR_FILL = 'rgba(122,90,170,0.15)';
const RADAR_STROKE = '#c9a84c';
const HB_THINKING = '#7a5aaa';
const HB_SPEAKING = '#c9a84c';
const HB_LISTENING = '#4a9a5c';
const TEXT_PRIMARY = '#e8e4df';
const TEXT_DIM = '#7a7672';
const BG_TRACK = 'rgba(255,255,255,0.04)';

// ============================================================
// 1. VITAL LED STRIPS — HP, XP, Mana as segmented bars
// ============================================================

function lerp(a, b, t) { return a + (b - a) * t; }

function lerpColor(a, b, t) {
  const ar = parseInt(a.slice(1, 3), 16), ag = parseInt(a.slice(3, 5), 16), ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16), bg = parseInt(b.slice(3, 5), 16), bb = parseInt(b.slice(5, 7), 16);
  return `rgb(${Math.round(lerp(ar, br, t))},${Math.round(lerp(ag, bg, t))},${Math.round(lerp(ab, bb, t))})`;
}

// HP color: green (full) → amber (mid) → red (low)
const HP_GREEN = '#4a9a5c';
const HP_AMBER = '#c9a84c';
const HP_RED = '#c94040';

function hpSegmentColor(segPct) {
  // segPct = position in bar (0 = left/low, 1 = right/high)
  if (segPct < 0.4) return lerpColor(HP_RED, HP_AMBER, segPct / 0.4);
  return lerpColor(HP_AMBER, HP_GREEN, (segPct - 0.4) / 0.6);
}

// Animation state
const vitalState = {
  hp: 20, maxHp: 20, xp: 0, mana: 20, maxMana: 20,
  aHp: 20, aXp: 0, aMana: 20,
  pulsePhase: 0,
  animId: null,
  canvases: null,
};

export function drawVitalStrips(hpCanvas, xpCanvas, manaCanvas, hp, maxHp, xp, mana, maxMana) {
  vitalState.hp = hp;
  vitalState.maxHp = maxHp || 20;
  vitalState.xp = xp;
  vitalState.mana = mana;
  vitalState.maxMana = maxMana || 20;
  vitalState.canvases = { hp: hpCanvas, xp: xpCanvas, mana: manaCanvas };

  if (!vitalState.animId) {
    vitalState.animId = requestAnimationFrame(animateVitalStrips);
  }
}

// Legacy compat — redirect to strips if canvases are set
export function drawVitalRings(_canvas, hp, maxHp, xp, mana, maxMana) {
  if (vitalState.canvases) {
    drawVitalStrips(vitalState.canvases.hp, vitalState.canvases.xp, vitalState.canvases.mana, hp, maxHp, xp, mana, maxMana);
  }
}

function animateVitalStrips() {
  const s = vitalState;
  const ease = 0.1;

  s.aHp += (s.hp - s.aHp) * ease;
  s.aXp += (s.xp - s.aXp) * ease;
  s.aMana += (s.mana - s.aMana) * ease;
  s.pulsePhase += 0.05;

  if (s.canvases) {
    const hpPct = s.maxHp > 0 ? s.aHp / s.maxHp : 0;
    const lowHp = s.hp / s.maxHp < 0.3;
    renderLedStrip(s.canvases.hp, hpPct, 'hp', lowHp ? s.pulsePhase : null);
    renderLedStrip(s.canvases.xp, Math.min(1, s.aXp / 200), 'xp', null);
    renderLedStrip(s.canvases.mana, s.maxMana > 0 ? s.aMana / s.maxMana : 0, 'mana', null);
  }

  const settled =
    Math.abs(s.aHp - s.hp) < 0.1 &&
    Math.abs(s.aXp - s.xp) < 0.1 &&
    Math.abs(s.aMana - s.mana) < 0.1;
  const lowHp = s.maxHp > 0 && s.hp / s.maxHp < 0.3;

  if (!settled || lowHp) {
    s.animId = requestAnimationFrame(animateVitalStrips);
  } else {
    s.animId = null;
  }
}

function renderLedStrip(canvas, pct, type, pulsePhase) {
  const { ctx, w, h } = dpr(canvas);
  ctx.clearRect(0, 0, w, h);

  const segs = 24;
  const gap = 2;
  const pad = 1;
  const segW = (w - pad * 2 - (segs - 1) * gap) / segs;
  const segH = h - 4;
  const yOff = 2;
  pct = Math.max(0, Math.min(1, pct));
  const lit = Math.round(pct * segs);

  for (let i = 0; i < segs; i++) {
    const x = pad + i * (segW + gap);
    const segPct = i / (segs - 1); // position in bar

    if (i < lit) {
      let c;
      if (type === 'hp') c = hpSegmentColor(segPct);
      else if (type === 'xp') c = XP_COLOR;
      else c = MANA_COLOR;

      // Pulse glow on low HP
      if (pulsePhase !== null && type === 'hp') {
        const pulse = 0.5 + 0.5 * Math.sin(pulsePhase * 4);
        ctx.shadowBlur = 4 + 4 * pulse;
        ctx.shadowColor = HP_RED;
        ctx.fillStyle = rgba(HP_RED, 0.6 + 0.4 * pulse);
      } else {
        ctx.shadowBlur = 3;
        ctx.shadowColor = c;
        ctx.fillStyle = c;
      }
      ctx.fillRect(x, yOff, segW, segH);
    } else {
      ctx.shadowBlur = 0;
      ctx.fillStyle = BG_TRACK;
      ctx.fillRect(x, yOff, segW, segH);
    }
  }
  ctx.shadowBlur = 0;
}


// ============================================================
// 2. STAT CHIPS — color-coded number + modifier (replaces radar)
// ============================================================

// Legacy compat — called from app.js, now updates stat chips instead
export function drawStatRadar(_canvas, str, dex, con, wis, cha) {
  updateStatChips(str, dex, con, wis, cha);
}

function statModifier(val) {
  const mod = Math.floor((val - 10) / 2);
  return mod >= 0 ? '+' + mod : '' + mod;
}

function statColorClass(val) {
  if (val >= 16) return 'strong';
  if (val >= 13) return 'good';
  if (val >= 10) return 'neutral';
  if (val >= 8) return 'weak';
  return 'poor';
}

export function updateStatChips(str, dex, con, wis, cha) {
  const container = document.getElementById('statsGrid');
  if (!container) return;
  const labels = ['STR', 'DEX', 'CON', 'WIS', 'CHA'];
  const vals = [str, dex, con, wis, cha];
  container.textContent = '';
  const tints = {
    strong: 'rgba(74,154,92,0.08)', good: 'rgba(74,154,92,0.04)',
    neutral: 'transparent', weak: 'rgba(201,168,76,0.06)', poor: 'rgba(180,64,64,0.08)'
  };
  vals.forEach((v, i) => {
    const cls = statColorClass(v);
    const chip = document.createElement('div');
    chip.className = 'stat-chip ' + cls;
    chip.style.background = tints[cls];
    const lbl = document.createElement('div');
    lbl.className = 'sc-label';
    lbl.textContent = labels[i];
    const val = document.createElement('div');
    val.className = 'sc-value';
    val.textContent = Math.round(v);
    const mod = document.createElement('div');
    mod.className = 'sc-mod';
    mod.textContent = statModifier(v);
    chip.appendChild(lbl);
    chip.appendChild(val);
    chip.appendChild(mod);
    container.appendChild(chip);
  });
}

// ============================================================
// 2b. ENEMY HP — Smooth arc gauge (green 100% → red 0%)
// ============================================================

function enemyHpColor(pct) {
  if (pct > 0.6) return lerpColor('#c9a84c', '#4a9a5c', (pct - 0.6) / 0.4);
  return lerpColor('#c94040', '#c9a84c', pct / 0.6);
}

export function drawEnemyArc(canvas, pct) {
  const { ctx, w, h } = dpr(canvas);
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h * 0.55, r = Math.min(w, h) * 0.36;
  const start = Math.PI * 0.75, end = Math.PI * 2.25, total = end - start;
  const lw = r * 0.16;
  pct = Math.max(0, Math.min(1, pct));
  const c = enemyHpColor(pct);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, r, start, end);
  ctx.lineWidth = lw;
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.stroke();
  if (pct > 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + pct * total);
    ctx.lineWidth = lw;
    ctx.strokeStyle = c;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + pct * total);
    ctx.lineWidth = lw + 4;
    ctx.strokeStyle = rgba(c, 0.12);
    ctx.stroke();
  }
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = c;
  ctx.fillText(Math.round(pct * 100) + '%', cx, cy + 4);
}

// ============================================================
// 2c. COMPASS — mini compass with gold-tick exits
// ============================================================

export function drawCompass(canvas, exits) {
  const { ctx, w, h } = dpr(canvas);
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.4;
  // Outer ring
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.lineWidth = 2;
  ctx.stroke();
  const cardinals = [
    { l: 'N', a: -Math.PI / 2 }, { l: 'E', a: 0 },
    { l: 'S', a: Math.PI / 2 }, { l: 'W', a: Math.PI }
  ];
  const interC = [
    { l: 'NE', a: -Math.PI / 4 }, { l: 'SE', a: Math.PI / 4 },
    { l: 'SW', a: Math.PI * 3 / 4 }, { l: 'NW', a: -Math.PI * 3 / 4 }
  ];
  const allDirs = [...cardinals, ...interC];
  // Minor ticks
  for (let d = 0; d < 360; d += 15) {
    if (d % 45 === 0) continue;
    const a = (d - 90) * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (r - 4), cy + Math.sin(a) * (r - 4));
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  // Direction ticks — exits glow gold
  allDirs.forEach(d => {
    const isExit = exits.some(e => e.dir === d.l);
    const isCardinal = cardinals.some(c => c.l === d.l);
    const tickLen = isCardinal ? 8 : 6;
    if (isExit) {
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(d.a) * (r - tickLen), cy + Math.sin(d.a) * (r - tickLen));
      ctx.lineTo(cx + Math.cos(d.a) * r, cy + Math.sin(d.a) * r);
      ctx.strokeStyle = rgba(XP_COLOR, 0.25);
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(d.a) * (r - tickLen), cy + Math.sin(d.a) * (r - tickLen));
      ctx.lineTo(cx + Math.cos(d.a) * r, cy + Math.sin(d.a) * r);
      ctx.strokeStyle = XP_COLOR;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(d.a) * (r - tickLen), cy + Math.sin(d.a) * (r - tickLen));
      ctx.lineTo(cx + Math.cos(d.a) * r, cy + Math.sin(d.a) * r);
      ctx.strokeStyle = isCardinal ? TEXT_DIM : 'rgba(255,255,255,.06)';
      ctx.lineWidth = isCardinal ? 2 : 1;
      ctx.stroke();
    }
  });
  // Cardinal labels
  cardinals.forEach(c => {
    const isExit = exits.some(e => e.dir === c.l);
    ctx.font = 'bold 8px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = c.l === 'N' ? HP_COLOR : (isExit ? XP_COLOR : TEXT_DIM);
    ctx.fillText(c.l, cx + Math.cos(c.a) * (r - 18), cy + Math.sin(c.a) * (r - 18));
  });
  // Inter-cardinal labels for exits
  interC.forEach(c => {
    const isExit = exits.some(e => e.dir === c.l);
    if (isExit) {
      ctx.font = 'bold 7px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = XP_COLOR;
      ctx.fillText(c.l, cx + Math.cos(c.a) * (r - 14), cy + Math.sin(c.a) * (r - 14));
    }
  });
  // Center dot (player)
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fillStyle = HB_LISTENING;
  ctx.fill();
}


// ============================================================
// 3. DM HEARTBEAT — ECG line with mode-based animation
// ============================================================

const heartbeatState = {
  mode: null,   // 'thinking' | 'speaking' | 'listening' | null
  phase: 0,
  animId: null,
  canvas: null,
};

export function startDMHeartbeat(canvas) {
  heartbeatState.canvas = canvas;
  if (!heartbeatState.animId) {
    heartbeatState.animId = requestAnimationFrame(animateHeartbeat);
  }
}

export function setDMHeartbeatMode(mode) {
  heartbeatState.mode = mode;
  // Restart animation if stopped
  if (mode && !heartbeatState.animId && heartbeatState.canvas) {
    heartbeatState.animId = requestAnimationFrame(animateHeartbeat);
  }
}

export function stopDMHeartbeat() {
  heartbeatState.mode = null;
  if (heartbeatState.animId) {
    cancelAnimationFrame(heartbeatState.animId);
    heartbeatState.animId = null;
  }
  // Clear canvas
  if (heartbeatState.canvas) {
    const { ctx, w, h } = dpr(heartbeatState.canvas);
    ctx.clearRect(0, 0, w, h);
  }
}

function animateHeartbeat() {
  const s = heartbeatState;
  if (!s.canvas || !s.mode) {
    s.animId = null;
    return;
  }

  // Speed varies by mode
  const speeds = { thinking: 0.012, speaking: 0.035, listening: 0.006 };
  s.phase += speeds[s.mode] || 0.012;

  renderHeartbeat(s.canvas, s.mode, s.phase);
  s.animId = requestAnimationFrame(animateHeartbeat);
}

function renderHeartbeat(canvas, mode, phase) {
  const { ctx, w, h } = dpr(canvas);
  ctx.clearRect(0, 0, w, h);

  const cy = h / 2;
  const colors = {
    thinking: HB_THINKING,
    speaking: HB_SPEAKING,
    listening: HB_LISTENING,
  };
  const color = colors[mode] || HB_THINKING;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  for (let x = 0; x < w; x++) {
    let t = ((x / w) * 4 + phase) % 4;
    let y = cy;

    if (mode === 'listening') {
      // Gentle breathing sine wave
      y = cy + Math.sin(x * 0.06 + phase * 10) * 4;
    } else {
      // ECG-style spikes
      if (t > 1.8 && t < 2.0) y = cy - (h * 0.35);
      else if (t > 2.0 && t < 2.15) y = cy + (h * 0.18);
      else if (t > 2.15 && t < 2.3) y = cy - (h * 0.55);
      else if (t > 2.3 && t < 2.5) y = cy + (h * 0.14);
    }

    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Glow pass
  ctx.strokeStyle = rgba(color, 0.12);
  ctx.lineWidth = 4;
  ctx.stroke();
}


// ============================================================
// 4. CREATURE RADAR — Mini sweep with NPC dots
// ============================================================

const creatureState = {
  npcs: [],
  sweepAngle: 0,
  animId: null,
  canvas: null,
};

export function drawCreatureRadar(canvas, npcs) {
  creatureState.canvas = canvas;
  creatureState.npcs = (npcs || []).map(npc => ({
    name: npc.name,
    attitude: npc.attitude || 'neutral', // friendly, neutral, hostile
    // Place NPCs around the radar at pseudo-random angles/distances
    angle: hashAngle(npc.name),
    dist: 0.3 + hashDist(npc.name) * 0.5,
  }));

  if (!creatureState.animId) {
    creatureState.animId = requestAnimationFrame(animateCreatureRadar);
  }
}

function animateCreatureRadar() {
  const s = creatureState;
  if (!s.canvas) {
    s.animId = null;
    return;
  }

  s.sweepAngle += 0.02;
  renderCreatureRadar(s.canvas, s.npcs, s.sweepAngle);
  s.animId = requestAnimationFrame(animateCreatureRadar);
}

export function stopCreatureRadar() {
  if (creatureState.animId) {
    cancelAnimationFrame(creatureState.animId);
    creatureState.animId = null;
  }
}

function renderCreatureRadar(canvas, npcs, sweep) {
  const { ctx, w, h } = dpr(canvas);
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2, cy = h / 2;
  const r = Math.min(w, h) * 0.42;

  // Concentric rings
  for (let ring = 0.33; ring <= 1; ring += 0.33) {
    ctx.beginPath();
    ctx.arc(cx, cy, r * ring, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Cross hairs
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.beginPath();
  ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
  ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
  ctx.stroke();

  // Sweep line
  const sx = cx + Math.cos(sweep) * r;
  const sy = cy + Math.sin(sweep) * r;
  const grad = ctx.createLinearGradient(cx, cy, sx, sy);
  grad.addColorStop(0, 'rgba(74,154,92,0)');
  grad.addColorStop(1, 'rgba(74,154,92,0.4)');
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(sx, sy);
  ctx.strokeStyle = grad;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Sweep fade cone
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, r, sweep - 0.5, sweep, false);
  ctx.closePath();
  const coneGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  coneGrad.addColorStop(0, 'rgba(74,154,92,0)');
  coneGrad.addColorStop(1, 'rgba(74,154,92,0.08)');
  ctx.fillStyle = coneGrad;
  ctx.fill();

  // Center dot
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fillStyle = HB_LISTENING;
  ctx.fill();

  // NPC dots
  const dotColors = {
    friendly: '#4a9a5c',
    neutral: '#c9a84c',
    hostile: '#c94040',
  };

  for (const npc of npcs) {
    const color = dotColors[npc.attitude] || dotColors.neutral;
    const nx = cx + Math.cos(npc.angle) * r * npc.dist;
    const ny = cy + Math.sin(npc.angle) * r * npc.dist;

    // Dot
    ctx.beginPath();
    ctx.arc(nx, ny, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // Glow
    ctx.beginPath();
    ctx.arc(nx, ny, 6, 0, Math.PI * 2);
    ctx.fillStyle = rgba(color, 0.2);
    ctx.fill();

    // Label
    ctx.font = '8px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = rgba(color, 0.8);
    ctx.fillText(npc.name, nx, ny - 9);
  }
}

// Simple string hash for pseudo-random NPC placement
function hashAngle(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return ((h & 0xffff) / 0xffff) * Math.PI * 2;
}

function hashDist(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 3) + h + str.charCodeAt(i)) | 0;
  return ((h & 0xffff) / 0xffff);
}
