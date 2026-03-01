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
  gainNode.gain.value = 1.0;

  const playerNode = new AudioWorkletNode(ctx, 'pcm-player-processor');
  playerNode.connect(gainNode);
  gainNode.connect(ctx.destination);

  return { ctx, playerNode, gainNode };
}

// --- Mic Recorder (PCM 16kHz) ---

export async function initMicRecorder(onPCMData) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  const workletURL = new URL('./pcm-recorder-processor.js', import.meta.url);
  await ctx.audioWorklet.addModule(workletURL);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1 },
  });
  const source = ctx.createMediaStreamSource(stream);
  const recorderNode = new AudioWorkletNode(ctx, 'pcm-recorder-processor');
  source.connect(recorderNode);

  recorderNode.port.onmessage = (event) => {
    const pcm16 = convertFloat32ToPCM(event.data);
    onPCMData(pcm16);
  };

  return { ctx, recorderNode, stream };
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

// Duck DM voice while NPC is speaking
export function duckDMVoice(dmGainNode, duck = true) {
  if (!dmGainNode) return;
  const target = duck ? 0.3 : 1.0;
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

    // Fade in
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + crossfadeDuration / 2);

    source.start();
    currentMusicSource = source;
  } catch (e) {
    console.warn('Music load failed:', trackUrl, e);
  }
}

export function toggleMusic() {
  musicEnabled = !musicEnabled;
  if (!musicEnabled && currentMusicSource) {
    try { currentMusicSource.stop(); } catch (e) {}
    currentMusicSource = null;
    currentMusicTrack = null;
  }
  return musicEnabled;
}

export function isMusicEnabled() {
  return musicEnabled;
}
