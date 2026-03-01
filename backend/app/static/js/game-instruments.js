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
// 1. VITAL RINGS — HP (outer), XP (middle), Mana (inner)
// ============================================================

// Animation state for smooth transitions
const vitalState = {
  hp: 20, maxHp: 20, xp: 0, mana: 20, maxMana: 20,
  // Animated (tweened) values
  aHp: 20, aXp: 0, aMana: 20,
  // Low HP pulse
  pulsePhase: 0,
  animId: null,
};

export function drawVitalRings(canvas, hp, maxHp, xp, mana, maxMana) {
  // Update targets
  vitalState.hp = hp;
  vitalState.maxHp = maxHp || 20;
  vitalState.xp = xp;
  vitalState.mana = mana;
  vitalState.maxMana = maxMana || 20;

  // If no animation running, start one
  if (!vitalState.animId) {
    vitalState.animId = requestAnimationFrame(() => animateVitals(canvas));
  }
}

function animateVitals(canvas) {
  const s = vitalState;
  const ease = 0.08;

  // Tween toward targets
  s.aHp += (s.hp - s.aHp) * ease;
  s.aXp += (s.xp - s.aXp) * ease;
  s.aMana += (s.mana - s.aMana) * ease;
  s.pulsePhase += 0.04;

  renderVitalRings(canvas, s);

  // Keep animating if not settled, or if low HP (for pulse)
  const settled =
    Math.abs(s.aHp - s.hp) < 0.1 &&
    Math.abs(s.aXp - s.xp) < 0.1 &&
    Math.abs(s.aMana - s.mana) < 0.1;
  const lowHp = s.hp / s.maxHp < 0.3;

  if (!settled || lowHp) {
    s.animId = requestAnimationFrame(() => animateVitals(canvas));
  } else {
    s.animId = null;
  }
}

function renderVitalRings(canvas, s) {
  const { ctx, w, h } = dpr(canvas);
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2, cy = h / 2;
  const rBase = Math.min(w, h) * 0.42;
  const ringGap = 14;
  const lw = 9;
  const lowHp = s.hp / s.maxHp < 0.3;

  const rings = [
    { val: s.aHp, max: s.maxHp, color: HP_COLOR, label: 'HP' },
    { val: s.aXp, max: 100, color: XP_COLOR, label: 'XP' },
    { val: s.aMana, max: s.maxMana, color: MANA_COLOR, label: 'MP' },
  ];

  ctx.lineCap = 'round';

  for (let i = 0; i < rings.length; i++) {
    const r = rBase - i * ringGap;
    const pct = Math.max(0, Math.min(1, rings[i].val / rings[i].max));

    // Background track
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI * 1.5);
    ctx.lineWidth = lw;
    ctx.strokeStyle = BG_TRACK;
    ctx.stroke();

    // Filled arc
    if (pct > 0) {
      let color = rings[i].color;
      // Low HP pulse on outer ring
      if (i === 0 && lowHp) {
        const pulse = 0.5 + 0.5 * Math.sin(s.pulsePhase * 3);
        color = rgba(HP_COLOR, 0.4 + pulse * 0.6);
      }

      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + pct * Math.PI * 2);
      ctx.lineWidth = lw;
      ctx.strokeStyle = color;
      ctx.stroke();

      // Glow on low HP
      if (i === 0 && lowHp) {
        ctx.save();
        ctx.shadowBlur = 8 + 6 * Math.sin(s.pulsePhase * 3);
        ctx.shadowColor = HP_COLOR;
        ctx.beginPath();
        ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + pct * Math.PI * 2);
        ctx.lineWidth = lw;
        ctx.strokeStyle = 'transparent';
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // Center text: HP numerically
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 18px Georgia, serif';
  ctx.fillStyle = lowHp ? HP_COLOR : TEXT_PRIMARY;
  ctx.fillText(`${Math.round(s.aHp)}/${Math.round(s.maxHp)}`, cx, cy - 4);

  // Smaller label below
  ctx.font = '9px system-ui, sans-serif';
  ctx.fillStyle = TEXT_DIM;
  ctx.fillText('HP', cx, cy + 14);
}


// ============================================================
// 2. STAT RADAR — Pentagon for STR/DEX/CON/WIS/CHA
// ============================================================

const radarState = {
  targets: [10, 10, 10, 10, 10],
  current: [10, 10, 10, 10, 10],
  animId: null,
};

export function drawStatRadar(canvas, str, dex, con, wis, cha) {
  radarState.targets = [str, dex, con, wis, cha];
  if (!radarState.animId) {
    radarState.animId = requestAnimationFrame(() => animateRadar(canvas));
  }
}

function animateRadar(canvas) {
  const s = radarState;
  const ease = 0.1;
  let settled = true;

  for (let i = 0; i < 5; i++) {
    s.current[i] += (s.targets[i] - s.current[i]) * ease;
    if (Math.abs(s.current[i] - s.targets[i]) > 0.1) settled = false;
  }

  renderRadar(canvas, s.current);

  if (!settled) {
    s.animId = requestAnimationFrame(() => animateRadar(canvas));
  } else {
    s.animId = null;
  }
}

function renderRadar(canvas, vals) {
  const { ctx, w, h } = dpr(canvas);
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2, cy = h / 2;
  const r = Math.min(w, h) * 0.36;
  const labels = ['STR', 'DEX', 'CON', 'WIS', 'CHA'];
  const n = labels.length;
  // Max stat value for scale (D&D style, 20 is typical max)
  const maxStat = 20;

  // Grid rings at 25/50/75/100%
  for (let ring = 0.25; ring <= 1; ring += 0.25) {
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = -Math.PI / 2 + i * (Math.PI * 2 / n);
      const x = cx + Math.cos(a) * r * ring;
      const y = cy + Math.sin(a) * r * ring;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Axis lines
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + i * (Math.PI * 2 / n);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Labels
    const lr = r + 14;
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText(labels[i], cx + Math.cos(a) * lr, cy + Math.sin(a) * lr);
  }

  // Data fill
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + i * (Math.PI * 2 / n);
    const v = Math.min(1, vals[i] / maxStat);
    const x = cx + Math.cos(a) * r * v;
    const y = cy + Math.sin(a) * r * v;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = RADAR_FILL;
  ctx.fill();
  ctx.strokeStyle = RADAR_STROKE;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Dots at vertices
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + i * (Math.PI * 2 / n);
    const v = Math.min(1, vals[i] / maxStat);
    const x = cx + Math.cos(a) * r * v;
    const y = cy + Math.sin(a) * r * v;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = RADAR_STROKE;
    ctx.fill();
  }

  // Stat values near dots
  ctx.font = 'bold 10px system-ui, sans-serif';
  ctx.fillStyle = TEXT_PRIMARY;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + i * (Math.PI * 2 / n);
    const v = Math.min(1, vals[i] / maxStat);
    const dist = r * v + 10;
    const x = cx + Math.cos(a) * dist;
    const y = cy + Math.sin(a) * dist;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(Math.round(vals[i]), x, y);
  }
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
