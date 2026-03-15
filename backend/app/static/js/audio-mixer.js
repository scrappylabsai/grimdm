/**
 * GrimDM 3-Channel Audio Mixer
 *
 * Channel 1: DM Voice (Gemini native audio, PCM 24kHz via WebSocket)
 * Channel 2: NPC Voice (MP3 from tool calls, played async)
 * Channel 3: Background Music (MP3 loops, crossfade on mood change)
 */

// --- DM Voice (PCM worklet) ---

export async function initDMVoice() {
  const ctx = new AudioContext({ sampleRate: 24000 });
  const workletURL = new URL('./pcm-player-processor.js', import.meta.url);
  await ctx.audioWorklet.addModule(workletURL);

  const gainNode = ctx.createGain();
  gainNode.gain.value = 0.7; // Default lower — DM voice is loud

  const playerNode = new AudioWorkletNode(ctx, 'pcm-player-processor');
  playerNode.connect(gainNode);
  gainNode.connect(ctx.destination);

  return { ctx, playerNode, gainNode };
}

// --- Mic Recorder (PCM 16kHz) ---

const TARGET_SAMPLE_RATE = 16000;

export async function initMicRecorder(onPCMData) {
  // Don't force sampleRate — browser may ignore it. We resample manually.
  const ctx = new AudioContext();
  const actualRate = ctx.sampleRate;
  console.log(`[GrimDM] Mic AudioContext sampleRate: ${actualRate}`);

  const workletURL = new URL('./pcm-recorder-processor.js', import.meta.url);
  await ctx.audioWorklet.addModule(workletURL);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1 },
  });
  const source = ctx.createMediaStreamSource(stream);
  const recorderNode = new AudioWorkletNode(ctx, 'pcm-recorder-processor');
  source.connect(recorderNode);

  recorderNode.port.onmessage = (event) => {
    let float32 = event.data;
    // Resample to 16kHz if browser gave us a different rate
    if (actualRate !== TARGET_SAMPLE_RATE) {
      float32 = resample(float32, actualRate, TARGET_SAMPLE_RATE);
    }
    const pcm16 = convertFloat32ToPCM(float32);
    onPCMData(pcm16);
  };

  return { ctx, recorderNode, stream };
}

function resample(input, fromRate, toRate) {
  const ratio = fromRate / toRate;
  const outputLength = Math.round(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = srcIdx - lo;
    output[i] = input[lo] * (1 - frac) + input[hi] * frac;
  }
  return output;
}

function convertFloat32ToPCM(float32) {
  const pcm16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    pcm16[i] = float32[i] * 0x7fff;
  }
  return pcm16.buffer;
}

// --- NPC Voice Channel ---

let npcAudioCtx = null;
let npcGainNode = null;

function getNPCContext() {
  if (!npcAudioCtx) {
    npcAudioCtx = new AudioContext();
    npcGainNode = npcAudioCtx.createGain();
    npcGainNode.gain.value = 1.0;
    npcGainNode.connect(npcAudioCtx.destination);
  }
  return { ctx: npcAudioCtx, gain: npcGainNode };
}

export async function playNPCAudio(base64Audio, mimeType = 'audio/mpeg') {
  const { ctx, gain } = getNPCContext();
  if (ctx.state === 'suspended') await ctx.resume();

  const binary = atob(base64Audio);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const audioBuffer = await ctx.decodeAudioData(bytes.buffer);
  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(gain);
  source.start();

  return new Promise((resolve) => {
    source.onended = resolve;
  });
}

let dmVolume = 0.7; // User-adjustable DM voice level

export function setDMVoiceVolume(level) {
  dmVolume = Math.max(0, Math.min(1, level));
}

export function getDMVoiceVolume() {
  return dmVolume;
}

// Duck DM voice while NPC is speaking
export function duckDMVoice(dmGainNode, duck = true) {
  if (!dmGainNode) return;
  const target = duck ? 0.3 * dmVolume : dmVolume;
  dmGainNode.gain.linearRampToValueAtTime(
    target,
    dmGainNode.context.currentTime + 0.3
  );
}

// --- Background Music Channel ---

let musicCtx = null;
let musicGainNode = null;
let currentMusicSource = null;
let currentMusicTrack = null;
let musicEnabled = false;
let musicVolume = 0.15; // 0-1, default background level

function getMusicContext() {
  if (!musicCtx) {
    musicCtx = new AudioContext();
    musicGainNode = musicCtx.createGain();
    musicGainNode.gain.value = 0.15; // Background level
    musicGainNode.connect(musicCtx.destination);
  }
  return { ctx: musicCtx, gain: musicGainNode };
}

export async function setMusic(trackUrl, crossfadeDuration = 2.0) {
  if (!musicEnabled) return;

  const { ctx, gain } = getMusicContext();
  if (ctx.state === 'suspended') await ctx.resume();

  if (trackUrl === currentMusicTrack) return; // Already playing
  currentMusicTrack = trackUrl;

  // Fade out current
  if (currentMusicSource) {
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + crossfadeDuration / 2);
    const oldSource = currentMusicSource;
    setTimeout(() => {
      try { oldSource.stop(); } catch (e) { /* already stopped */ }
    }, (crossfadeDuration / 2) * 1000);
  }

  try {
    const response = await fetch(trackUrl);
    if (!response.ok) return; // Track not yet generated, skip silently

    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.loop = true;
    source.connect(gain);

    // Fade in to current volume level
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(musicVolume, ctx.currentTime + crossfadeDuration / 2);

    source.start();
    currentMusicSource = source;
  } catch (e) {
    console.warn('Music load failed:', trackUrl, e);
  }
}

export function setMusicVolume(level) {
  musicVolume = Math.max(0, Math.min(1, level));
  const wasEnabled = musicEnabled;
  musicEnabled = musicVolume > 0;

  if (musicEnabled && musicGainNode) {
    musicGainNode.gain.linearRampToValueAtTime(musicVolume, musicGainNode.context.currentTime + 0.1);
  }

  if (!musicEnabled && currentMusicSource) {
    try { currentMusicSource.stop(); } catch (e) {}
    currentMusicSource = null;
    currentMusicTrack = null;
  }

  return musicEnabled;
}

export function toggleMusic() {
  if (musicEnabled) {
    setMusicVolume(0);
  } else {
    setMusicVolume(0.15);
  }
  return musicEnabled;
}

export function isMusicEnabled() {
  return musicEnabled;
}

export function getMusicVolume() {
  return musicVolume;
}

// --- Sound Effects Channel ---

let sfxCtx = null;

function getSFXContext() {
  if (!sfxCtx) {
    sfxCtx = new AudioContext();
  }
  return sfxCtx;
}

export async function playSFX(url) {
  const ctx = getSFXContext();
  if (ctx.state === 'suspended') await ctx.resume();

  try {
    const response = await fetch(url);
    if (!response.ok) return;
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    source.start();
  } catch (e) {
    console.warn('SFX playback failed:', url, e);
  }
}
