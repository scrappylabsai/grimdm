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
  toggleMusic,
  isMusicEnabled,
} from './audio-mixer.js';

// --- State ---
const userId = 'player-' + Math.random().toString(36).substring(2, 8);
const sessionId = 'game-' + Math.random().toString(36).substring(2, 10);
let websocket = null;
let isAudioActive = false;
let dmVoice = null; // { ctx, playerNode, gainNode }
let micRecorder = null;

// Transcript state
let currentMsgId = null;
let currentBubbleEl = null;
let currentInputTransId = null;
let currentInputTransEl = null;
let currentOutputTransId = null;
let currentOutputTransEl = null;
let inputTransFinished = false;
let hasOutputTrans = false;

// --- DOM ---
const transcript = document.getElementById('transcript');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const messageForm = document.getElementById('messageForm');
const textInput = document.getElementById('textInput');
const sendBtn = document.getElementById('sendBtn');
const micBtn = document.getElementById('micBtn');
const muteBtn = document.getElementById('muteBtn');
const sceneImage = document.getElementById('sceneImage');
const sceneCaption = document.getElementById('sceneCaption');
const diceOverlay = document.getElementById('diceOverlay');
const diceValue = document.getElementById('diceValue');
const diceDetail = document.getElementById('diceDetail');
const npcSpeechEl = document.getElementById('npcSpeech');
const npcSpeechName = document.getElementById('npcSpeechName');
const npcSpeechText = document.getElementById('npcSpeechText');

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
const charLocation = document.getElementById('charLocation');
const inventoryList = document.getElementById('inventoryList');
const questList = document.getElementById('questList');

// --- WebSocket ---

function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws/${userId}/${sessionId}`;
  websocket = new WebSocket(url);

  websocket.onopen = () => {
    statusDot.classList.add('connected');
    statusText.textContent = 'Connected';
    sendBtn.disabled = false;
    addSystemMessage('The tale begins...');
  };

  websocket.onmessage = (event) => {
    const adk = JSON.parse(event.data);
    handleADKEvent(adk);
  };

  websocket.onclose = () => {
    statusDot.classList.remove('connected');
    statusText.textContent = 'Reconnecting...';
    sendBtn.disabled = true;
    setTimeout(connectWebSocket, 3000);
  };

  websocket.onerror = () => {
    statusDot.classList.remove('connected');
    statusText.textContent = 'Error';
  };
}

// --- ADK Event Handler ---

function handleADKEvent(adk) {
  // Turn complete
  if (adk.turnComplete) {
    finalizeBubble(currentBubbleEl);
    finalizeBubble(currentOutputTransEl);
    resetTurnState();
    return;
  }

  // Interrupted
  if (adk.interrupted) {
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
    handleOutputTranscription(adk.outputTranscription);
  }

  // Content (audio + text + tool results)
  if (adk.content?.parts) {
    handleContentParts(adk);
  }
}

function handleInputTranscription(trans) {
  if (inputTransFinished) return;

  if (!currentInputTransId) {
    currentInputTransId = randomId();
    currentInputTransEl = createMsgBubble(trans.text, 'player', !trans.finished);
    transcript.appendChild(currentInputTransEl);
  } else if (!currentOutputTransId && !currentMsgId) {
    updateBubbleText(currentInputTransEl, trans.text, !trans.finished);
  }

  if (trans.finished) {
    currentInputTransId = null;
    currentInputTransEl = null;
    inputTransFinished = true;
  }
  scrollTranscript();
}

function handleOutputTranscription(trans) {
  hasOutputTrans = true;

  // Finalize input transcription on first output
  if (currentInputTransId && !currentOutputTransId) {
    finalizeBubble(currentInputTransEl);
    currentInputTransId = null;
    currentInputTransEl = null;
    inputTransFinished = true;
  }

  if (!currentOutputTransId) {
    currentOutputTransId = randomId();
    currentOutputTransEl = createMsgBubble(trans.text, 'dm', !trans.finished);
    transcript.appendChild(currentOutputTransEl);
  } else {
    if (trans.finished) {
      updateBubbleText(currentOutputTransEl, trans.text, false);
    } else {
      const existing = getBubbleText(currentOutputTransEl);
      updateBubbleText(currentOutputTransEl, existing + trans.text, true);
    }
  }

  if (trans.finished) {
    currentOutputTransId = null;
    currentOutputTransEl = null;
  }
  scrollTranscript();
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
    // Audio playback (DM voice PCM)
    if (part.inlineData?.mimeType?.startsWith('audio/pcm') && dmVoice?.playerNode) {
      dmVoice.playerNode.port.postMessage(base64ToArrayBuffer(part.inlineData.data));
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
      if (data.suggested_music) {
        setMusic(`/static/music/${data.suggested_music}.mp3`);
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
      handleNPCSpeech(data);
      break;
    case 'generate_scene_image':
      if (data.image_base64) {
        showSceneImage(data.image_base64, data.image_mime, data.description);
      }
      break;
    case 'set_background_music':
      if (data.track_url) setMusic(data.track_url);
      break;
    case 'update_quest':
      // Quest UI updated on next status refresh
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
    xpText.textContent = data.xp;
    // XP bar: 100 XP per level
    const pct = Math.min(100, (data.xp % 100));
    xpBar.style.width = pct + '%';
  }
  if (data.attack) charAtk.textContent = data.attack;
  if (data.defense) charDef.textContent = data.defense;
  if (data.gold !== undefined) charGold.textContent = data.gold;
  if (data.location) charLocation.textContent = data.location;
}

function updateHP(hp, maxHp) {
  hpText.textContent = `${hp} / ${maxHp}`;
  const pct = Math.max(0, (hp / maxHp) * 100);
  hpBar.style.width = pct + '%';
  hpBar.setAttribute('aria-valuenow', hp);
  hpBar.setAttribute('aria-valuemax', maxHp);
}

function updateInventory(items) {
  // Clear existing items safely using DOM methods
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

async function handleNPCSpeech(data) {
  // Show speech bubble
  npcSpeechName.textContent = data.npc_name;
  npcSpeechText.textContent = data.text;
  npcSpeechEl.classList.add('show');
  npcSpeechEl.setAttribute('aria-hidden', 'false');

  // Duck DM, play NPC audio
  if (data.audio_base64) {
    duckDMVoice(dmVoice?.gainNode, true);
    try {
      await playNPCAudio(data.audio_base64, data.audio_mime);
    } catch (e) {
      console.warn('NPC audio playback failed:', e);
    }
    duckDMVoice(dmVoice?.gainNode, false);
  }

  // Hide speech bubble after a delay
  setTimeout(() => {
    npcSpeechEl.classList.remove('show');
    npcSpeechEl.setAttribute('aria-hidden', 'true');
  }, 3000);
}

function showSceneImage(base64, mime, description) {
  sceneImage.classList.remove('visible');
  setTimeout(() => {
    sceneImage.src = `data:${mime};base64,${base64}`;
    sceneImage.classList.add('visible');
    if (description) {
      sceneCaption.textContent = description;
    }
  }, 100);
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

function sendTextMessage(text) {
  if (websocket?.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify({ type: 'text', text }));
  }
}

function sendAudioChunk(pcmBuffer) {
  if (websocket?.readyState === WebSocket.OPEN && isAudioActive) {
    websocket.send(pcmBuffer);
  }
}

// --- Event Listeners ---

messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;

  const bubble = createMsgBubble(text, 'player');
  transcript.appendChild(bubble);
  scrollTranscript();
  textInput.value = '';
  sendTextMessage(text);
});

micBtn.addEventListener('click', async () => {
  if (isAudioActive) return; // Already active

  try {
    dmVoice = await initDMVoice();
    micRecorder = await initMicRecorder(sendAudioChunk);
    isAudioActive = true;
    micBtn.classList.add('active');
    addSystemMessage('Voice active — speak to the Dungeon Master');
  } catch (e) {
    addSystemMessage('Microphone access denied');
    console.error('Audio init failed:', e);
  }
});

muteBtn.addEventListener('click', () => {
  const enabled = toggleMusic();
  muteBtn.classList.toggle('muted', !enabled);
});

// --- Init ---
connectWebSocket();
