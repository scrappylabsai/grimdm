/**
 * GrimDM — Main Application
 * WebSocket streaming + game UI + 3-channel audio
 */

import {
  initDMVoice,
  initMicRecorder,
  playNPCAudio,
  duckDMVoice,
  setMusic,
  setMusicVolume,
  playSFX,
} from './audio-mixer.js';

import {
  drawVitalRings,
  drawVitalStrips,
  drawStatRadar,
  updateStatChips,
  drawEnemyArc,
  drawCompass,
  startDMHeartbeat,
  setDMHeartbeatMode,
  stopDMHeartbeat,
  drawCreatureRadar,
  stopCreatureRadar,
} from './game-instruments.js';

// --- State (persisted in localStorage for session continuity) ---
const userId = localStorage.getItem('grimdm_userId') || 'player-' + Math.random().toString(36).substring(2, 8);
const sessionId = localStorage.getItem('grimdm_sessionId') || 'game-' + Math.random().toString(36).substring(2, 10);
localStorage.setItem('grimdm_userId', userId);
localStorage.setItem('grimdm_sessionId', sessionId);
let websocket = null;
let isAudioActive = false;
let dmVoice = null; // { ctx, playerNode, gainNode }
let micRecorder = null;
let hasConnectedOnce = false;
let cameraStream = null;
let gestureBattleMode = false;

// Heartbeat — detect hung connections
let lastServerMessageTime = 0;
let heartbeatInterval = null;
const HEARTBEAT_SEND_MS = 15000;    // Ping every 15s
const HEARTBEAT_TIMEOUT_MS = 45000; // Dead after 45s silence

// Transcript state
let currentMsgId = null;
let currentBubbleEl = null;
let currentInputTransId = null;
let currentInputTransEl = null;
let currentOutputTransId = null;
let currentOutputTransEl = null;
let inputTransFinished = false;
let hasOutputTrans = false;
let inputTransAccum = '';

// --- DOM ---
const transcript = document.getElementById('transcript');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const messageForm = document.getElementById('messageForm');
const textInput = document.getElementById('textInput');
const sendBtn = document.getElementById('sendBtn');
const micBtn = document.getElementById('micBtn');
const musicSlider = document.getElementById('musicVolume');
const sceneImage = document.getElementById('sceneImage');
const sceneCaption = document.getElementById('sceneCaption');
const diceOverlay = document.getElementById('diceOverlay');
const diceValue = document.getElementById('diceValue');
const diceDetail = document.getElementById('diceDetail');
const npcSpeechEl = document.getElementById('npcSpeech');
const npcSpeechName = document.getElementById('npcSpeechName');
const npcSpeechText = document.getElementById('npcSpeechText');
const dmIndicator = document.getElementById('dmIndicator');
const dmIndicatorText = document.getElementById('dmIndicatorText');
const cameraOverlay = document.getElementById('cameraOverlay');
const cameraViewfinder = document.getElementById('cameraViewfinder');
const cameraSnapBtn = document.getElementById('cameraSnapBtn');
const cameraCloseBtn = document.getElementById('cameraCloseBtn');
const cameraHint = document.getElementById('cameraHint');
const cameraFileInput = document.getElementById('cameraFileInput');
const cameraBtn = document.getElementById('cameraBtn');
const gesturePrompt = document.getElementById('gesturePrompt');
const htpOverlay = document.getElementById('howToPlay');
const htpStartBtn = document.getElementById('htpStartBtn');

// Canvas instrument elements
const hpStripCanvas = document.getElementById('hpStrip');
const xpStripCanvas = document.getElementById('xpStrip');
const manaStripCanvas = document.getElementById('manaStrip');
const hpValueEl = document.getElementById('hpValue');
const xpValueEl = document.getElementById('xpValue');
const manaValueEl = document.getElementById('manaValue');
const dmStatusBar = document.getElementById('dmStatusBar');
const dmStatusText = document.getElementById('dmStatusText');
const dmStatusPulse = document.getElementById('dmStatusPulse');
const compassCanvas = document.getElementById('compassCanvas');
const charExitList = document.getElementById('charExits');
const combatGroup = document.getElementById('combatGroup');
const enemyRow = document.getElementById('enemyRow');
const dmHeartbeatCanvas = document.getElementById('dmHeartbeat');
const creatureRadarCanvas = document.getElementById('creatureRadar');
const creatureRadarGroup = document.getElementById('creatureRadarGroup');

// Tracked vitals state for instrument updates
let currentHp = 20, currentMaxHp = 20, currentXp = 0, currentMana = 20, currentMaxMana = 20;

// Status bar pulse animation
let statusPulseId = null;
let statusPulsePhase = 0;
function renderStatusPulse(mode) {
  if (!dmStatusPulse) return;
  const d = window.devicePixelRatio || 1;
  const w = dmStatusPulse.clientWidth, h = dmStatusPulse.clientHeight;
  dmStatusPulse.width = w * d;
  dmStatusPulse.height = h * d;
  const ctx = dmStatusPulse.getContext('2d');
  ctx.setTransform(d, 0, 0, d, 0, 0);

  const colors = { thinking: '#7a5aaa', speaking: '#c9a84c', listening: '#4a9a5c' };
  const color = colors[mode] || colors.thinking;

  function animatePulse() {
    statusPulsePhase += 0.06;
    ctx.clearRect(0, 0, w, h);
    const pulse = 0.4 + 0.6 * Math.abs(Math.sin(statusPulsePhase));
    ctx.globalAlpha = pulse;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = pulse * 0.3;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    statusPulseId = requestAnimationFrame(animatePulse);
  }
  cancelAnimationFrame(statusPulseId);
  animatePulse();
}

// Thinking phrases — randomly chosen, mystical & playful
const thinkingPhrases = [
  'Consulting the bones...',
  'Stirring the cauldron...',
  'Reading the entrails...',
  'Whispering to ravens...',
  'Rolling forbidden dice...',
  'Summoning dark inspiration...',
  'Peering into the void...',
  'Flipping through cursed tomes...',
  'Making mischief...',
  'Brewing something wicked...',
  'The shadows conspire...',
  'Plotting your doom...',
  'Weaving dark threads...',
  'Sharpening the thorns...',
  'Communing with the forest...',
];

const speakingPhrases = [
  'The dark tale unfolds...',
  'A voice from beyond...',
  'The Thornwood speaks...',
  'Fate whispers its decree...',
  'The story bleeds forth...',
];

let dmTimerStart = null;
let dmTimerInterval = null;

function showDMIndicator(mode = 'thinking') {
  dmIndicator.classList.add('visible');
  dmIndicator.classList.remove('listening');
  dmIndicator.classList.toggle('speaking', mode === 'speaking');
  dmIndicator.setAttribute('aria-hidden', 'false');

  // Drive heartbeat canvas
  startDMHeartbeat(dmHeartbeatCanvas);
  setDMHeartbeatMode(mode);

  // Show prominent status bar
  dmStatusBar.classList.add('visible');
  dmStatusBar.classList.remove('thinking', 'speaking', 'listening');
  dmStatusBar.classList.add(mode);
  dmStatusBar.setAttribute('aria-hidden', 'false');

  // Start elapsed timer
  if (!dmTimerStart) dmTimerStart = Date.now();
  clearInterval(dmTimerInterval);
  dmTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - dmTimerStart) / 1000);
    const phrase = mode === 'speaking' ? speakingPhrases : thinkingPhrases;
    const base = phrase[Math.floor(dmTimerStart / 1000) % phrase.length];
    dmIndicatorText.textContent = `${base} ${elapsed}s`;
    dmStatusText.textContent = `${base} ${elapsed}s`;
  }, 1000);
  // Show initial text immediately
  const phrase = mode === 'speaking' ? speakingPhrases : thinkingPhrases;
  const text = phrase[Math.floor(Math.random() * phrase.length)];
  dmIndicatorText.textContent = text;
  dmStatusText.textContent = text;

  // Mini pulse animation on status bar
  renderStatusPulse(mode);
}

function hideDMIndicator() {
  clearInterval(dmTimerInterval);
  dmTimerStart = null;
  cancelAnimationFrame(statusPulseId);
  statusPulseId = null;

  // Show "your turn" state if mic is active
  if (isAudioActive) {
    dmIndicator.classList.add('visible', 'listening');
    dmIndicator.classList.remove('speaking');
    dmIndicatorText.textContent = 'Your turn — speak...';
    dmIndicator.setAttribute('aria-hidden', 'false');
    setDMHeartbeatMode('listening');
    // Status bar shows listening
    dmStatusBar.classList.add('visible', 'listening');
    dmStatusBar.classList.remove('thinking', 'speaking');
    dmStatusBar.setAttribute('aria-hidden', 'false');
    dmStatusText.textContent = 'Your turn — speak...';
    renderStatusPulse('listening');
  } else {
    dmIndicator.classList.remove('visible', 'speaking', 'listening');
    dmIndicator.setAttribute('aria-hidden', 'true');
    dmStatusBar.classList.remove('visible', 'thinking', 'speaking', 'listening');
    dmStatusBar.setAttribute('aria-hidden', 'true');
    stopDMHeartbeat();
  }
}

// Character sheet elements
const charName = document.getElementById('charName');
const charLevel = document.getElementById('charLevel');
const hpBar = document.getElementById('hpBar');
const hpText = document.getElementById('hpText');
const xpBar = document.getElementById('xpBar');
const xpText = document.getElementById('xpText');
const charAtk = document.getElementById('charAtk');
const charDef = document.getElementById('charDef');
const charGold = document.getElementById('charGold');
const charStr = document.getElementById('charStr');
const charDex = document.getElementById('charDex');
const charCon = document.getElementById('charCon');
const charWis = document.getElementById('charWis');
const charCha = document.getElementById('charCha');
const charLocation = document.getElementById('charLocation');
const charExits = document.getElementById('charExits');
const inventoryList = document.getElementById('inventoryList');
const questList = document.getElementById('questList');

// --- WebSocket ---

function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws/${userId}/${sessionId}`;
  websocket = new WebSocket(url);

  let reconnectTimer = null;

  websocket.onopen = () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    statusDot.classList.add('connected');
    statusText.textContent = 'Connected';
    sendBtn.disabled = false;
    lastServerMessageTime = Date.now();
    if (isAudioActive) startHeartbeat();
    if (!hasConnectedOnce) {
      hasConnectedOnce = true;
    }
    startSceneImagePolling();
  };

  websocket.onmessage = async (event) => {
    lastServerMessageTime = Date.now();
    const adk = JSON.parse(event.data);
    // Lazy-init audio playback on first audio content (needs prior user gesture)
    if (!dmVoice && adk.content?.parts?.some(p => p.inlineData?.mimeType?.startsWith('audio/'))) {
      await ensureDMVoice();
    }
    handleADKEvent(adk);
  };

  websocket.onclose = () => {
    sendBtn.disabled = true;
    stopHeartbeat();
    if (isPaused) return; // Don't reconnect when paused
    // Only show "Reconnecting" if it takes more than 2s
    reconnectTimer = setTimeout(() => {
      statusDot.classList.remove('connected');
      statusText.textContent = 'Reconnecting...';
    }, 1000);
    setTimeout(connectWebSocket, 1000);
  };

  websocket.onerror = () => {
    // Don't flash error — onclose will handle reconnect
  };
}

// --- Heartbeat ---

function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    // Send ping to keep connection alive
    if (websocket?.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({ type: 'ping' }));
    }
    // Check for hung connection
    if (lastServerMessageTime && Date.now() - lastServerMessageTime > HEARTBEAT_TIMEOUT_MS) {
      console.warn('[GrimDM] Connection appears hung — forcing reconnect');
      forceReconnect();
    }
  }, HEARTBEAT_SEND_MS);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

function forceReconnect() {
  stopHeartbeat();
  if (websocket) {
    websocket.onclose = null; // prevent double-reconnect
    websocket.close();
    websocket = null;
  }
  statusDot.classList.remove('connected');
  statusText.textContent = 'Reconnecting...';
  dmIndicator.classList.add('visible');
  dmIndicatorText.textContent = 'Reconnecting...';
  setTimeout(() => {
    connectWebSocket();
    if (isAudioActive) startHeartbeat();
  }, 1000);
}

// --- ADK Event Handler ---

function handleADKEvent(adk) {
  // Turn complete
  if (adk.turnComplete) {
    finalizeBubble(currentBubbleEl);
    finalizeBubble(currentOutputTransEl);
    hideDMIndicator();
    resetTurnState();
    return;
  }

  // Interrupted
  if (adk.interrupted) {
    hideDMIndicator();
    if (dmVoice?.playerNode) {
      dmVoice.playerNode.port.postMessage({ command: 'endOfAudio' });
    }
    if (currentBubbleEl) currentBubbleEl.classList.add('interrupted');
    if (currentOutputTransEl) currentOutputTransEl.classList.add('interrupted');
    finalizeBubble(currentBubbleEl);
    finalizeBubble(currentOutputTransEl);
    resetTurnState();
    return;
  }

  // Input transcription (player's voice)
  if (adk.inputTranscription?.text) {
    handleInputTranscription(adk.inputTranscription);
  }

  // Output transcription (DM's voice text)
  if (adk.outputTranscription?.text) {
    showDMIndicator('speaking');
    handleOutputTranscription(adk.outputTranscription);
  }

  // Content (audio + text + tool results)
  if (adk.content?.parts) {
    handleContentParts(adk);
  }
}

function handleInputTranscription(trans) {
  if (inputTransFinished) return;

  // Accumulate partial words into full transcript
  inputTransAccum += trans.text;

  if (!currentInputTransId) {
    currentInputTransId = randomId();
    currentInputTransEl = createMsgBubble(inputTransAccum, 'player', !trans.finished);
    transcript.appendChild(currentInputTransEl);
  } else if (!currentOutputTransId && !currentMsgId) {
    updateBubbleText(currentInputTransEl, inputTransAccum, !trans.finished);
  }

  if (trans.finished) {
    currentInputTransId = null;
    currentInputTransEl = null;
    inputTransFinished = true;
    inputTransAccum = '';
    showDMIndicator('thinking');
  }
  scrollTranscript();
}

// Accumulate output transcription — only show final complete text
let outputTransAccum = '';

function handleOutputTranscription(trans) {
  hasOutputTrans = true;

  // Finalize input transcription on first output
  if (currentInputTransId && !currentOutputTransId) {
    finalizeBubble(currentInputTransEl);
    currentInputTransId = null;
    currentInputTransEl = null;
    inputTransFinished = true;
  }

  // Accumulate partial words
  if (!trans.finished) {
    outputTransAccum += trans.text;
    return; // Don't show yet
  }

  // Finished — show the complete transcription as one clean bubble
  const fullText = trans.text || outputTransAccum;
  outputTransAccum = '';

  if (fullText.trim()) {
    currentOutputTransId = randomId();
    currentOutputTransEl = createMsgBubble(fullText, 'dm', false);
    transcript.appendChild(currentOutputTransEl);
    currentOutputTransId = null;
    currentOutputTransEl = null;
    scrollTranscript();
  }
}

function handleContentParts(adk) {
  // Finalize input on first content
  if (currentInputTransId && !currentMsgId && !currentOutputTransId) {
    finalizeBubble(currentInputTransEl);
    currentInputTransId = null;
    currentInputTransEl = null;
    inputTransFinished = true;
  }

  for (const part of adk.content.parts) {
    // Debug: log non-audio parts to see tool call structure
    if (!part.inlineData) {
      console.log('[GrimDM] Part:', JSON.stringify(part).substring(0, 200));
    }

    // Audio playback (DM voice PCM)
    if (part.inlineData?.mimeType?.startsWith('audio/pcm')) {
      if (dmVoice?.playerNode) {
        dmVoice.playerNode.port.postMessage(base64ToArrayBuffer(part.inlineData.data));
      } else {
        console.warn('[GrimDM] Audio chunk received but dmVoice not ready');
      }
    }

    // Text content
    if (part.text && !part.thought) {
      // Skip aggregated content if output transcription already showed it
      if (!adk.partial && hasOutputTrans) continue;

      if (!currentMsgId) {
        currentMsgId = randomId();
        currentBubbleEl = createMsgBubble(part.text, 'dm', true);
        transcript.appendChild(currentBubbleEl);
      } else {
        const existing = getBubbleText(currentBubbleEl);
        updateBubbleText(currentBubbleEl, existing + part.text, true);
      }
      scrollTranscript();
    }

    // Function call results — parse for game UI updates
    if (part.functionResponse) {
      handleToolResult(part.functionResponse);
    }
    // ADK sometimes uses function_response (snake_case) instead of functionResponse
    if (part.function_response) {
      handleToolResult(part.function_response);
    }
  }
}

// --- Tool Result Handler (updates game UI) ---

function handleToolResult(funcResponse) {
  const name = funcResponse.name;
  let data;
  try {
    // ADK wraps tool results — the actual JSON is in response.content or response.result
    const raw = funcResponse.response?.content || funcResponse.response?.result || funcResponse.response;
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return;
  }

  if (!data || data.error) return;

  switch (name) {
    case 'roll_dice':
      showDiceRoll(data);
      break;
    case 'get_player_status':
      updateCharSheet(data);
      break;
    case 'set_player_name':
      charName.textContent = data.name;
      break;
    case 'roll_character_stats':
      if (data.rolls) {
        charStr.textContent = data.rolls.strength;
        charDex.textContent = data.rolls.dexterity;
        charCon.textContent = data.rolls.constitution;
        charWis.textContent = data.rolls.wisdom;
        charCha.textContent = data.rolls.charisma;
        updateStatChips(data.rolls.strength, data.rolls.dexterity, data.rolls.constitution, data.rolls.wisdom, data.rolls.charisma);
        drawStatRadar(statRadarCanvas, data.rolls.strength, data.rolls.dexterity, data.rolls.constitution, data.rolls.wisdom, data.rolls.charisma);
      }
      if (data.derived) {
        charAtk.textContent = data.derived.attack;
        charDef.textContent = data.derived.defense;
        updateHP(data.derived.hp, data.derived.max_hp);
      }
      break;
    case 'check_inventory':
      updateInventory(data.items);
      if (data.gold !== undefined) charGold.textContent = data.gold;
      break;
    case 'add_item':
    case 'remove_item':
      // Refresh will happen on next get_player_status
      break;
    case 'modify_gold':
      charGold.textContent = data.gold;
      break;
    case 'award_xp':
      if (data.xp !== undefined) updateCharSheet(data);
      if (data.xp_awarded) showXPFloat(data.xp_awarded, data.reason);
      break;
    case 'get_location_info':
    case 'move_player':
      if (data.name || data.location_name) {
        charLocation.textContent = data.name || data.location_name;
      }
      if (data.connections && data.connections.length > 0) {
        updateCompassExits(data.connections, data.exit_directions);
      }
      if (data.suggested_music) {
        setMusic(`/static/music/${data.suggested_music}.mp3`);
      }
      // Update creature radar if NPCs present
      if (data.npcs && data.npcs.length > 0) {
        creatureRadarGroup.style.display = '';
        drawCreatureRadar(creatureRadarCanvas, data.npcs);
      } else {
        creatureRadarGroup.style.display = 'none';
        stopCreatureRadar();
      }
      break;
    case 'start_combat':
      if (data.suggested_music) setMusic(`/static/music/${data.suggested_music}.mp3`);
      if (data.enemies) updateCombatEnemies(data.enemies);
      break;
    case 'attack':
      if (data.attack_roll) showDiceRoll({ total: data.attack_roll, notation: 'd20', natural_20: data.natural_20, natural_1: data.natural_1 });
      if (data.suggested_music) setMusic(`/static/music/${data.suggested_music}.mp3`);
      if (data.xp !== undefined) updateCharSheet(data);
      if (data.enemies) updateCombatEnemies(data.enemies);
      if (data.combat_ended) combatGroup.style.display = 'none';
      break;
    case 'heal_player':
      if (data.hp !== undefined) {
        updateHP(data.hp, data.max_hp);
      }
      break;
    case 'speak_as_npc':
      // Show speech bubble text immediately; audio arrives via polling
      if (data.npc_name && data.text) {
        showNPCSpeechBubble(data.npc_name, data.text);
      }
      break;
    case 'generate_scene_image':
    case 'generate_styled_scene':
      // Images arrive via polling (/api/scene-images); tool result is just confirmation
      break;
    case 'resolve_gesture_battle':
      showGestureResult(data);
      if (data.effect) addSystemMessage(data.effect);
      break;
    case 'set_background_music':
      if (data.track_url) setMusic(data.track_url);
      break;
    case 'play_sound_effect':
      if (data.effect_url) playSFX(data.effect_url);
      break;
    case 'speak_as_player':
      // Audio arrives via NPC audio polling; tool result is just confirmation
      break;
    case 'update_quest':
      if (data.quests) updateQuests(data.quests);
      if (data.xp !== undefined) updateCharSheet(data);
      break;
  }
}

// --- Game UI Updates ---

function showDiceRoll(data) {
  diceValue.textContent = data.total;
  diceValue.className = 'dice-value';
  if (data.natural_20) diceValue.classList.add('crit');
  if (data.natural_1) diceValue.classList.add('fumble');
  diceDetail.textContent = data.notation || '';

  diceOverlay.classList.add('show');
  diceOverlay.setAttribute('aria-hidden', 'false');
  setTimeout(() => {
    diceOverlay.classList.remove('show');
    diceOverlay.setAttribute('aria-hidden', 'true');
  }, 1000);
}


function showLevelUp(level) {
  // Remove any existing flash
  document.querySelector('.level-up-flash')?.remove();
  const el = document.createElement('div');
  el.className = 'level-up-flash';
  el.innerHTML = `<div class="luf-title">LEVEL UP</div><div class="luf-level">Level ${level}</div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 500);
  }, 2500);
}

function showXPFloat(amount, reason) {
  const el = document.createElement('div');
  el.className = 'xp-float';
  const amtEl = document.createElement('span');
  amtEl.className = 'xp-float-amount';
  amtEl.textContent = '+' + amount + ' XP';
  el.appendChild(amtEl);
  if (reason) {
    const reasonEl = document.createElement('span');
    reasonEl.className = 'xp-float-reason';
    reasonEl.textContent = reason;
    el.appendChild(reasonEl);
  }
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 600);
  }, 2000);
}

function updateCharSheet(data) {
  if (data.name) charName.textContent = data.name;
  if (data.level) charLevel.textContent = data.level;
  if (data.hp !== undefined) updateHP(data.hp, data.max_hp);
  if (data.xp !== undefined) {
    currentXp = data.xp;
    xpText.textContent = data.xp;
    xpValueEl.textContent = `${data.xp} XP`;
    drawVitalStrips(hpStripCanvas, xpStripCanvas, manaStripCanvas, currentHp, currentMaxHp, currentXp, currentMana, currentMaxMana);
  }
  if (data.leveled_up && data.new_level) showLevelUp(data.new_level);
  if (data.level) charLevel.textContent = data.level;
  if (data.attack) charAtk.textContent = data.attack;
  if (data.defense) charDef.textContent = data.defense;
  if (data.stats) {
    charStr.textContent = data.stats.strength;
    charDex.textContent = data.stats.dexterity;
    charCon.textContent = data.stats.constitution;
    charWis.textContent = data.stats.wisdom;
    charCha.textContent = data.stats.charisma;
    drawStatRadar(statRadarCanvas, data.stats.strength, data.stats.dexterity, data.stats.constitution, data.stats.wisdom, data.stats.charisma);
  }
  if (data.gold !== undefined) charGold.textContent = data.gold;
  if (data.location) charLocation.textContent = data.location;
}

// Compass + exit list — maps connection names to compass directions
function updateCompassExits(connections, exitDirections) {
  // exitDirections is optional {connection_name: "N"/"S"/"E"/"W"/etc} from backend
  // If not provided, just show text list without compass directions
  const dirMap = {
    north: 'N', south: 'S', east: 'E', west: 'W',
    northeast: 'NE', northwest: 'NW', southeast: 'SE', southwest: 'SW',
  };
  const exits = [];
  // Build exit list in DOM
  charExitList.textContent = '';
  for (const conn of connections) {
    const name = conn.replace(/_/g, ' ');
    // Try to get direction from exitDirections map or from name heuristics
    let dir = null;
    if (exitDirections && exitDirections[conn]) {
      dir = exitDirections[conn].toUpperCase();
    } else {
      // Check if connection name contains a direction word
      const lower = conn.toLowerCase();
      for (const [word, d] of Object.entries(dirMap)) {
        if (lower.includes(word)) { dir = d; break; }
      }
    }
    if (dir) exits.push({ dir, name });
    const line = document.createElement('div');
    line.textContent = dir ? `${dir} — ${name}` : name;
    charExitList.appendChild(line);
  }
  // Draw compass
  if (compassCanvas) drawCompass(compassCanvas, exits);
}

// Enemy combat arcs — show/hide + render smooth arcs
function updateCombatEnemies(enemies) {
  if (!enemies || enemies.length === 0) {
    combatGroup.style.display = 'none';
    return;
  }
  combatGroup.style.display = '';
  enemyRow.textContent = '';
  for (const enemy of enemies) {
    const unit = document.createElement('div');
    unit.className = 'enemy-unit';
    const canvas = document.createElement('canvas');
    canvas.className = 'enemy-arc-canvas';
    canvas.width = 140;
    canvas.height = 116;
    const nameEl = document.createElement('span');
    nameEl.className = 'enemy-name';
    nameEl.textContent = enemy.name;
    unit.appendChild(canvas);
    unit.appendChild(nameEl);
    enemyRow.appendChild(unit);
    const pct = enemy.max_hp > 0 ? enemy.hp / enemy.max_hp : 0;
    drawEnemyArc(canvas, pct);
  }
}

function updateHP(hp, maxHp) {
  currentHp = hp;
  currentMaxHp = maxHp;
  // Update hidden DOM for accessibility
  hpText.textContent = `${hp} / ${maxHp}`;
  hpBar.dataset.hp = hp;
  hpBar.dataset.maxhp = maxHp;
  // Update LED strip value labels
  hpValueEl.textContent = `${hp}/${maxHp}`;
  // Drive vital LED strips
  drawVitalStrips(hpStripCanvas, xpStripCanvas, manaStripCanvas, currentHp, currentMaxHp, currentXp, currentMana, currentMaxMana);
}

function updateInventory(items) {
  while (inventoryList.firstChild) {
    inventoryList.removeChild(inventoryList.firstChild);
  }

  if (!items || items.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-state';
    emptyDiv.textContent = 'Empty';
    inventoryList.appendChild(emptyDiv);
    return;
  }

  for (const item of items) {
    const itemDiv = document.createElement('div');
    itemDiv.className = 'inventory-item';
    itemDiv.textContent = item.name + (item.quantity > 1 ? ' x' + item.quantity : '');
    inventoryList.appendChild(itemDiv);
  }
}

function updateQuests(quests) {
  questList.innerHTML = '';

  if (!quests || quests.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-state';
    emptyDiv.textContent = 'No active quests';
    questList.appendChild(emptyDiv);
    return;
  }

  for (const quest of quests) {
    const questDiv = document.createElement('div');
    questDiv.className = 'quest-item';
    if (quest.description) questDiv.title = quest.description;

    const titleEl = document.createElement('div');
    titleEl.className = 'quest-name';
    titleEl.textContent = quest.name;
    questDiv.appendChild(titleEl);

    if (quest.objectives && quest.objectives.length > 0) {
      const objList = document.createElement('ul');
      objList.className = 'quest-objectives';
      for (const obj of quest.objectives) {
        const li = document.createElement('li');
        const done = (quest.completed_objectives || []).includes(obj);
        li.className = done ? 'quest-obj done' : 'quest-obj';
        li.textContent = (done ? '✓ ' : '○ ') + obj;
        objList.appendChild(li);
      }
      questDiv.appendChild(objList);
    }
    questList.appendChild(questDiv);
  }
}

let npcSpeechTimeout = null;

function showNPCSpeechBubble(name, text, autoHideMs = 5000) {
  // Clear any existing auto-hide timer
  if (npcSpeechTimeout) { clearTimeout(npcSpeechTimeout); npcSpeechTimeout = null; }

  npcSpeechName.textContent = name;
  npcSpeechText.textContent = text;
  npcSpeechEl.classList.add('show');
  npcSpeechEl.setAttribute('aria-hidden', 'false');

  if (autoHideMs > 0) {
    npcSpeechTimeout = setTimeout(() => {
      npcSpeechEl.classList.remove('show');
      npcSpeechEl.setAttribute('aria-hidden', 'true');
      npcSpeechTimeout = null;
    }, autoHideMs);
  }
}

function hideNPCSpeechBubble() {
  if (npcSpeechTimeout) { clearTimeout(npcSpeechTimeout); npcSpeechTimeout = null; }
  npcSpeechEl.classList.remove('show');
  npcSpeechEl.setAttribute('aria-hidden', 'true');
}

async function handleNPCAudioDelivery(data) {
  // Show speech bubble — keep visible until audio finishes (no auto-hide)
  showNPCSpeechBubble(data.npc_name, data.text, 0);

  if (data.audio_base64) {
    duckDMVoice(dmVoice?.gainNode, true);
    try {
      await playNPCAudio(data.audio_base64, data.audio_mime);
    } catch (e) {
      console.warn('NPC audio playback failed:', e);
    }
    duckDMVoice(dmVoice?.gainNode, false);
  }

  // Hide bubble after audio finishes (or immediately if no audio, with short delay)
  showNPCSpeechBubble(data.npc_name, data.text, data.audio_base64 ? 1500 : 3000);
}

function showSceneImage(base64, mime, description) {
  console.log(`[GrimDM] showSceneImage: mime=${mime}, base64 len=${base64?.length}, desc="${description}"`);
  if (!base64 || !mime) {
    console.warn('[GrimDM] showSceneImage called with missing data');
    return;
  }
  sceneImage.classList.remove('visible');
  // Wait for image to actually decode before fading in
  sceneImage.onload = () => {
    console.log('[GrimDM] Scene image loaded, fading in');
    sceneImage.classList.add('visible');
  };
  sceneImage.onerror = (e) => {
    console.error('[GrimDM] Scene image failed to load:', e);
  };
  sceneImage.src = `data:${mime};base64,${base64}`;
  if (description) {
    sceneCaption.textContent = description;
  }
}

// --- Message Bubbles ---

function createMsgBubble(text, type, isPartial = false) {
  const msg = document.createElement('div');
  msg.className = `msg ${type}`;

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  const textEl = document.createElement('p');
  textEl.textContent = text;

  if (isPartial && type === 'dm') {
    const indicator = document.createElement('span');
    indicator.className = 'typing-indicator';
    textEl.appendChild(indicator);
  }

  bubble.appendChild(textEl);
  msg.appendChild(bubble);
  return msg;
}

function updateBubbleText(el, text, isPartial) {
  if (!el) return;
  const textEl = el.querySelector('p');
  if (!textEl) return;

  const indicator = textEl.querySelector('.typing-indicator');
  if (indicator) indicator.remove();

  textEl.textContent = text;

  if (isPartial) {
    const newIndicator = document.createElement('span');
    newIndicator.className = 'typing-indicator';
    textEl.appendChild(newIndicator);
  }
}

function getBubbleText(el) {
  if (!el) return '';
  const textEl = el.querySelector('p');
  if (!textEl) return '';
  return textEl.textContent.replace(/\.\.\.$/, '');
}

function finalizeBubble(el) {
  if (!el) return;
  const indicator = el.querySelector('.typing-indicator');
  if (indicator) indicator.remove();
}

function addSystemMessage(text) {
  const msg = document.createElement('div');
  msg.className = 'msg system';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text;
  msg.appendChild(bubble);
  transcript.appendChild(msg);
  scrollTranscript();
}

function scrollTranscript() {
  transcript.scrollTop = transcript.scrollHeight;
}

function resetTurnState() {
  currentMsgId = null;
  currentBubbleEl = null;
  currentOutputTransId = null;
  currentOutputTransEl = null;
  inputTransFinished = false;
  hasOutputTrans = false;
  outputTransAccum = '';
  inputTransAccum = '';
}

// --- Utilities ---

function randomId() {
  return Math.random().toString(36).substring(2, 9);
}

function base64ToArrayBuffer(base64) {
  let std = base64.replace(/-/g, '+').replace(/_/g, '/');
  while (std.length % 4) std += '=';
  const binary = atob(std);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// --- Camera ---

function openCamera(hint = 'Snap a photo for the DM') {
  cameraHint.textContent = hint;
  // Try getUserMedia first
  if (navigator.mediaDevices?.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(stream => {
        cameraStream = stream;
        cameraViewfinder.srcObject = stream;
        cameraViewfinder.style.display = '';
        cameraOverlay.classList.add('show');
        cameraOverlay.setAttribute('aria-hidden', 'false');
      })
      .catch(() => {
        // Camera denied — fall back to file input
        cameraViewfinder.style.display = 'none';
        cameraFileInput.click();
      });
  } else {
    // No getUserMedia — file input fallback
    cameraViewfinder.style.display = 'none';
    cameraFileInput.click();
  }
}

function closeCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  cameraViewfinder.srcObject = null;
  cameraOverlay.classList.remove('show');
  cameraOverlay.setAttribute('aria-hidden', 'true');
  gestureBattleMode = false;
}

function captureFromViewfinder() {
  const canvas = document.createElement('canvas');
  canvas.width = cameraViewfinder.videoWidth || 640;
  canvas.height = cameraViewfinder.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(cameraViewfinder, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  const base64 = dataUrl.split(',')[1];
  sendCameraImage(base64, 'image/jpeg');
  closeCamera();
}

function sendCameraImage(base64, mime) {
  // Send via WebSocket for Gemini vision
  if (websocket?.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify({ type: 'image', data: base64, mimeType: mime }));
  }
  // Also store server-side for style reference
  fetch('/api/store-player-photo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, image_base64: base64, mime_type: mime }),
  }).catch(e => console.warn('[GrimDM] Failed to store player photo:', e));

  addSystemMessage('Photo sent to the DM');
}

// Camera button click
cameraBtn?.addEventListener('click', () => openCamera());

// Snap button
cameraSnapBtn?.addEventListener('click', () => {
  if (cameraStream) {
    captureFromViewfinder();
  }
});

// Close button
cameraCloseBtn?.addEventListener('click', closeCamera);

// File input fallback
cameraFileInput?.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = reader.result.split(',')[1];
    sendCameraImage(base64, file.type || 'image/jpeg');
    // Show overlay briefly then close
    cameraOverlay.classList.add('show');
    setTimeout(() => closeCamera(), 500);
  };
  reader.readAsDataURL(file);
  cameraFileInput.value = '';
});

// --- Gesture UI ---

function showGesturePrompt(text) {
  gesturePrompt.textContent = text;
  gesturePrompt.classList.add('show');
  gesturePrompt.setAttribute('aria-hidden', 'false');
  // Auto-hide after animation (3s)
  setTimeout(() => {
    gesturePrompt.classList.remove('show');
    gesturePrompt.setAttribute('aria-hidden', 'true');
  }, 3000);
}

function showGestureResult(data) {
  // Reuse dice overlay for gesture results
  const won = data.outcome === 'player_wins';
  const draw = data.outcome === 'draw';
  const emoji = won ? 'Victory!' : draw ? 'Draw!' : 'Defeated!';
  diceValue.textContent = emoji;
  diceValue.className = 'dice-value';
  if (won) diceValue.classList.add('crit');
  if (!won && !draw) diceValue.classList.add('fumble');

  let detail = data.player_gesture;
  if (data.dm_gesture) detail += ` vs ${data.dm_gesture}`;
  if (data.combat_bonus) {
    detail += ` (${data.combat_bonus > 0 ? '+' : ''}${data.combat_bonus})`;
  }
  diceDetail.textContent = detail;

  diceOverlay.classList.add('show');
  diceOverlay.setAttribute('aria-hidden', 'false');
  setTimeout(() => {
    diceOverlay.classList.remove('show');
    diceOverlay.setAttribute('aria-hidden', 'true');
  }, 3000);
}

// --- Send Message ---

// Ensure DM voice playback is initialized (requires user gesture)
async function ensureDMVoice() {
  try {
    if (!dmVoice) {
      console.log('[GrimDM] Initializing DM voice playback...');
      dmVoice = await initDMVoice();
      console.log('[GrimDM] DM voice ready, ctx state:', dmVoice.ctx.state);
    }
    if (dmVoice.ctx.state === 'suspended') {
      console.log('[GrimDM] Resuming AudioContext...');
      await dmVoice.ctx.resume();
    }
    console.log('[GrimDM] AudioContext state:', dmVoice.ctx.state, 'sampleRate:', dmVoice.ctx.sampleRate);
  } catch (e) {
    console.error('[GrimDM] Failed to init DM voice:', e);
  }
}

function sendTextMessage(text) {
  if (websocket?.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify({ type: 'text', text }));
    showDMIndicator('thinking');
  }
}

function sendAudioChunk(pcmBuffer) {
  if (websocket?.readyState === WebSocket.OPEN && isAudioActive) {
    websocket.send(pcmBuffer);
  }
}

// --- Event Listeners ---

messageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;

  // Init audio + connect on first user gesture
  await ensureDMVoice();
  if (!websocket || websocket.readyState !== WebSocket.OPEN) {
    connectWebSocket();
    // Wait for connection before sending
    await new Promise(resolve => {
      const check = setInterval(() => {
        if (websocket?.readyState === WebSocket.OPEN) { clearInterval(check); resolve(); }
      }, 100);
    });
  }

  const bubble = createMsgBubble(text, 'player');
  transcript.appendChild(bubble);
  scrollTranscript();
  textInput.value = '';
  sendTextMessage(text);
});

micBtn.addEventListener('click', async () => {
  if (isAudioActive) return; // Already active

  try {
    await ensureDMVoice();
    micRecorder = await initMicRecorder(sendAudioChunk);
    isAudioActive = true;
    micBtn.classList.add('active');

    // Connect WebSocket on first Speak press
    if (!websocket || websocket.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    }
    startHeartbeat();

    addSystemMessage('Voice active — speak to the Dungeon Master');
  } catch (e) {
    addSystemMessage('Microphone access denied');
    console.error('Audio init failed:', e);
  }
});

musicSlider.addEventListener('input', () => {
  setMusicVolume(musicSlider.value / 100);
});

let isPaused = false;
const pauseBtn = document.getElementById('pauseBtn');

pauseBtn?.addEventListener('click', () => {
  if (!isPaused) {
    // PAUSE — save state, disconnect cleanly
    isPaused = true;
    pauseBtn.textContent = 'Resume';
    pauseBtn.classList.add('paused');
    pauseBtn.title = 'Resume game';

    // Stop mic (micRecorder = { ctx, recorderNode, stream })
    if (micRecorder) {
      micRecorder.stream.getTracks().forEach(t => t.stop());
      micRecorder.ctx.close().catch(() => {});
      micRecorder = null;
    }
    isAudioActive = false;
    micBtn.classList.remove('active');

    // Close WebSocket cleanly (prevent auto-reconnect)
    if (websocket) {
      websocket.onclose = null; // prevent reconnect
      websocket.close(1000, 'paused');
      websocket = null;
    }

    // Clear polling
    clearInterval(sceneImagePollTimer);
    sceneImagePollTimer = null;

    // Show pause overlay
    const overlay = document.createElement('div');
    overlay.className = 'pause-overlay';
    overlay.id = 'pauseOverlay';
    overlay.innerHTML = `
      <h2>Game Saved</h2>
      <p>The Thornwood waits in silence...</p>
      <button id="resumeBtn">Resume Adventure</button>
    `;
    document.body.appendChild(overlay);
    document.getElementById('resumeBtn').addEventListener('click', resumeGame);

    hideDMIndicator();
    statusDot.classList.remove('connected');
    statusText.textContent = 'Paused';
    addSystemMessage('Game saved. The shadows hold their breath...');
  } else {
    resumeGame();
  }
});

function resumeGame() {
  isPaused = false;
  pauseBtn.textContent = 'Save';
  pauseBtn.classList.remove('paused');
  pauseBtn.title = 'Save & pause game';

  // Remove overlay
  document.getElementById('pauseOverlay')?.remove();

  // Reconnect
  connectWebSocket();
  startSceneImagePolling();
  addSystemMessage('The tale resumes...');
}

document.getElementById('loadBtn')?.addEventListener('click', async () => {
  try {
    const resp = await fetch('/api/saved-games');
    if (!resp.ok) { addSystemMessage('No saved games found.'); return; }
    const data = await resp.json();
    if (!data.saves || data.saves.length === 0) {
      addSystemMessage('No saved games found.');
      return;
    }
    // Show load overlay (safe DOM construction — save.name is user input)
    const overlay = document.createElement('div');
    overlay.className = 'pause-overlay';
    overlay.id = 'loadOverlay';
    const heading = document.createElement('h2');
    heading.textContent = 'Load Game';
    overlay.appendChild(heading);

    for (const save of data.saves) {
      const btn = document.createElement('button');
      btn.className = 'load-save-btn';
      btn.dataset.session = save.session_id;
      btn.textContent = `${save.name} — Lv.${save.level} — ${save.location.replace(/_/g, ' ')}`;
      btn.addEventListener('click', () => {
        localStorage.setItem('grimdm_sessionId', save.session_id);
        localStorage.setItem('grimdm_userId', 'player-' + Math.random().toString(36).substring(2, 8));
        location.reload();
      });
      overlay.appendChild(btn);
    }

    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'cancelLoadBtn';
    cancelBtn.style.cssText = 'margin-top:8px;border-color:var(--text-dim);color:var(--text-dim)';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());
    overlay.appendChild(cancelBtn);

    document.body.appendChild(overlay);
  } catch (e) {
    addSystemMessage('Could not load saves.');
  }
});

document.getElementById('newGameBtn')?.addEventListener('click', () => {
  if (confirm('Start a new game? Your current progress will be lost.')) {
    localStorage.removeItem('grimdm_userId');
    localStorage.removeItem('grimdm_sessionId');
    location.reload();
  }
});

// --- Scene image polling (images generated async, delivered via HTTP) ---
let sceneImagePollTimer = null;

function startSceneImagePolling() {
  if (sceneImagePollTimer) return;
  console.log(`[GrimDM] Starting asset polling for session: ${sessionId}`);
  sceneImagePollTimer = setInterval(async () => {
    // Poll scene images, NPC audio, and theater events in parallel
    try {
      const [imgResp, audioResp, theaterResp] = await Promise.all([
        fetch(`/api/scene-images/${sessionId}`).catch(() => null),
        fetch(`/api/npc-audio/${sessionId}`).catch(() => null),
        fetch(`/api/theater-events/${sessionId}`).catch(() => null),
      ]);

      if (imgResp?.ok) {
        const data = await imgResp.json();
        if (data.images && data.images.length > 0) {
          console.log(`[GrimDM] Poll received ${data.images.length} scene image(s)`);
          for (const img of data.images) {
            showSceneImage(img.image_base64, img.image_mime, img.description);
          }
        }
      }

      if (audioResp?.ok) {
        const data = await audioResp.json();
        if (data.audio && data.audio.length > 0) {
          console.log(`[GrimDM] Poll received ${data.audio.length} NPC audio(s)`);
          for (const npc of data.audio) {
            await handleNPCAudioDelivery(npc);
          }
        }
      }

      if (theaterResp?.ok) {
        const data = await theaterResp.json();
        if (data.events && data.events.length > 0) {
          for (const event of data.events) {
            if (event.type === 'gesture_battle_result') {
              showGestureResult(event.data);
              playSFX('/static/sfx/sword_clash.mp3');
            }
            if (event.type === 'open_camera') {
              const hint = event.data?.prompt || 'Show the DM your world...';
              // Small delay so the DM voice finishes the line first
              setTimeout(() => openCamera(hint), 800);
            }
          }
        }
      }
    } catch (e) {
      console.warn('[GrimDM] Asset poll error:', e);
    }
  }, 1000);
}

// --- Restore game state on reload ---
async function restoreGameState() {
  // Initialize instruments with defaults
  drawVitalStrips(hpStripCanvas, xpStripCanvas, manaStripCanvas, currentHp, currentMaxHp, currentXp, currentMana, currentMaxMana);
  updateStatChips(10, 10, 10, 10, 10);
  if (compassCanvas) drawCompass(compassCanvas, []);

  try {
    const resp = await fetch(`/api/game-state/${sessionId}`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.name && data.name !== 'Wanderer') {
      charName.textContent = data.name;
      if (data.stats) {
        charStr.textContent = data.stats.strength;
        charDex.textContent = data.stats.dexterity;
        charCon.textContent = data.stats.constitution;
        charWis.textContent = data.stats.wisdom;
        charCha.textContent = data.stats.charisma;
        updateStatChips(data.stats.strength, data.stats.dexterity, data.stats.constitution, data.stats.wisdom, data.stats.charisma);
      }
      charAtk.textContent = data.attack;
      charDef.textContent = data.defense;
      charGold.textContent = data.gold;
      charLevel.textContent = data.level;
      if (data.location) charLocation.textContent = data.location;
      if (data.connections) updateCompassExits(data.connections, data.exit_directions);
      if (data.xp !== undefined) {
        currentXp = data.xp;
        xpText.textContent = data.xp;
        xpValueEl.textContent = `${data.xp} XP`;
      }
      updateHP(data.hp, data.max_hp);
      if (data.inventory) updateInventory(data.inventory);
      if (data.quests) updateQuests(data.quests);
      console.log('[GrimDM] Game state restored from server');
    }
  } catch (e) {
    console.warn('[GrimDM] Could not restore game state:', e);
  }
}

// --- Init ---
restoreGameState();

// How to Play overlay — show for first-time players, skip for returning
// Always show the How to Play overlay — it IS the intro
statusText.textContent = 'Welcome';

htpStartBtn?.addEventListener('click', () => {
  localStorage.setItem('grimdm_hasPlayed', '1');
  htpOverlay.classList.add('hidden');
  addSystemMessage('Press "Speak" to begin your adventure, or type below.');
  statusText.textContent = 'Ready';
});
