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

// Canvas instrument elements
const hpStripCanvas = document.getElementById('hpStrip');
const xpStripCanvas = document.getElementById('xpStrip');
const manaStripCanvas = document.getElementById('manaStrip');
const hpValueEl = document.getElementById('hpValue');
const xpValueEl = document.getElementById('xpValue');
const manaValueEl = document.getElementById('manaValue');
const statRadarCanvas = document.getElementById('statRadar');
const dmHeartbeatCanvas = document.getElementById('dmHeartbeat');
const creatureRadarCanvas = document.getElementById('creatureRadar');
const creatureRadarGroup = document.getElementById('creatureRadarGroup');

// Tracked vitals state for instrument updates
let currentHp = 20, currentMaxHp = 20, currentXp = 0, currentMana = 20, currentMaxMana = 20;

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

  // Start elapsed timer
  if (!dmTimerStart) dmTimerStart = Date.now();
  clearInterval(dmTimerInterval);
  dmTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - dmTimerStart) / 1000);
    const phrase = mode === 'speaking' ? speakingPhrases : thinkingPhrases;
    const base = phrase[Math.floor(dmTimerStart / 1000) % phrase.length];
    dmIndicatorText.textContent = `${base} ${elapsed}s`;
  }, 1000);
  // Show initial text immediately
  const phrase = mode === 'speaking' ? speakingPhrases : thinkingPhrases;
  dmIndicatorText.textContent = phrase[Math.floor(Math.random() * phrase.length)];
}

function hideDMIndicator() {
  clearInterval(dmTimerInterval);
  dmTimerStart = null;

  // Show "your turn" state if mic is active
  if (isAudioActive) {
    dmIndicator.classList.add('visible', 'listening');
    dmIndicator.classList.remove('speaking');
    dmIndicatorText.textContent = 'Your turn — speak...';
    dmIndicator.setAttribute('aria-hidden', 'false');
    setDMHeartbeatMode('listening');
  } else {
    dmIndicator.classList.remove('visible', 'speaking', 'listening');
    dmIndicator.setAttribute('aria-hidden', 'true');
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
    if (!hasConnectedOnce) {
      hasConnectedOnce = true;
    }
    startSceneImagePolling();
  };

  websocket.onmessage = async (event) => {
    const adk = JSON.parse(event.data);
    // Lazy-init audio playback on first audio content (needs prior user gesture)
    if (!dmVoice && adk.content?.parts?.some(p => p.inlineData?.mimeType?.startsWith('audio/'))) {
      await ensureDMVoice();
    }
    handleADKEvent(adk);
  };

  websocket.onclose = () => {
    sendBtn.disabled = true;
    if (isPaused) return; // Don't reconnect when paused
    // Only show "Reconnecting" if it takes more than 2s
    reconnectTimer = setTimeout(() => {
      statusDot.classList.remove('connected');
      statusText.textContent = 'Reconnecting...';
    }, 2000);
    setTimeout(connectWebSocket, 1000);
  };

  websocket.onerror = () => {
    // Don't flash error — onclose will handle reconnect
  };
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
    case 'get_location_info':
    case 'move_player':
      if (data.name || data.location_name) {
        charLocation.textContent = data.name || data.location_name;
      }
      if (data.connections && data.connections.length > 0) {
        const exits = data.connections.map(c => c.replace(/_/g, ' ')).join(', ');
        charExits.textContent = exits;
        charExits.parentElement.style.display = '';
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
      break;
    case 'attack':
      if (data.attack_roll) showDiceRoll({ total: data.attack_roll, notation: 'd20', natural_20: data.natural_20, natural_1: data.natural_1 });
      if (data.suggested_music) setMusic(`/static/music/${data.suggested_music}.mp3`);
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
      // Images arrive via polling (/api/scene-images); tool result is just confirmation
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
  }, 2000);
}

function updateCharSheet(data) {
  if (data.name) charName.textContent = data.name;
  if (data.level) charLevel.textContent = data.level;
  if (data.hp !== undefined) updateHP(data.hp, data.max_hp);
  if (data.xp !== undefined) {
    currentXp = data.xp % 100;
    xpText.textContent = data.xp;
    xpValueEl.textContent = data.xp;
    drawVitalStrips(hpStripCanvas, xpStripCanvas, manaStripCanvas, currentHp, currentMaxHp, currentXp, currentMana, currentMaxMana);
  }
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
  while (questList.firstChild) {
    questList.removeChild(questList.firstChild);
  }

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
    questDiv.textContent = quest.name;
    if (quest.description) {
      questDiv.title = quest.description;
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
    // Poll scene images and NPC audio in parallel
    try {
      const [imgResp, audioResp] = await Promise.all([
        fetch(`/api/scene-images/${sessionId}`).catch(() => null),
        fetch(`/api/npc-audio/${sessionId}`).catch(() => null),
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
    } catch (e) {
      console.warn('[GrimDM] Asset poll error:', e);
    }
  }, 2000);
}

// --- Restore game state on reload ---
async function restoreGameState() {
  // Initialize instruments with defaults
  drawVitalStrips(hpStripCanvas, xpStripCanvas, manaStripCanvas, currentHp, currentMaxHp, currentXp, currentMana, currentMaxMana);
  drawStatRadar(statRadarCanvas, 10, 10, 10, 10, 10);

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
        drawStatRadar(statRadarCanvas, data.stats.strength, data.stats.dexterity, data.stats.constitution, data.stats.wisdom, data.stats.charisma);
      }
      charAtk.textContent = data.attack;
      charDef.textContent = data.defense;
      charGold.textContent = data.gold;
      charLevel.textContent = data.level;
      if (data.location) charLocation.textContent = data.location;
      if (data.xp !== undefined) {
        currentXp = data.xp % 100;
        xpText.textContent = data.xp;
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
// Don't auto-connect — wait for user gesture so AudioContext can play DM voice
addSystemMessage('Press "Speak" to begin your adventure, or type below.');
statusText.textContent = 'Ready';
