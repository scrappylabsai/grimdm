# GrimDM — Voice AI Dungeon Master

> *"The mist parts before you, wanderer. Speak your name into the darkness..."*

A real-time voice-interactive AI Dungeon Master powered by **Google's Gemini Live API** and the **Agent Development Kit (ADK)**. GrimDM creates an immersive dark fairy tale RPG where players speak naturally, NPCs respond in distinct character voices, scenes render as gothic fantasy illustrations, and ambient music shifts with the mood of gameplay.

**Built for the [Gemini Live Agent Challenge](https://devpost.com/) on Devpost.**

## What Makes GrimDM Special

GrimDM is not a chatbot — it's a full audio-visual game experience with three independent audio channels mixed in the browser:

| Channel | Source | What It Does |
|---------|--------|-------------|
| **DM Voice** | Gemini native audio (WebSocket, 24kHz PCM) | The Dungeon Master narrates, reacts, and responds in real-time with sub-second latency and barge-in support |
| **NPC Voices** | ScrappyLabs voice-design API (async generation) | Each of 10 NPCs has a unique voice created from text descriptions + seeds — a troll sounds like grinding stones, a child speaks breathlessly |
| **Music & SFX** | Pre-generated loops + 16 real foley sound effects | Crossfading ambient music that shifts with location/mood, plus one-shot SFX for dice, swords, magic, and more |

All three channels play simultaneously with automatic DM voice ducking when an NPC speaks.

## Features

- **Natural Voice Interaction**: Speak to the DM using Gemini's native audio — sub-second latency, mid-sentence barge-in, emotional vocal range
- **10 Unique NPC Voices**: Each NPC character has a distinct AI-generated voice (deep rumbling troll, ethereal witch, excitable goblin merchant)
- **Dark Fantasy Scene Art**: Imagen 4 generates gothic fairy tale illustrations in the style of Arthur Rackham and Brian Froud
- **Full RPG Mechanics**: 5-stat character creation (STR/DEX/CON/WIS/CHA), dice rolls, inventory, combat, quests, NPC relationships, gold economy
- **Mood-Reactive Music**: 8 ambient loops (village, tavern, forest, dungeon, combat, boss, mystery, victory) with smooth crossfade transitions
- **16 Foley Sound Effects**: Real recorded sounds — dice clatter, sword clash, door creak, thunder, campfire crackling, and more
- **Persistent Game State**: Player progress, stats, inventory, and quest log survive browser refreshes and server restarts (SQLite + JSON)
- **Save/Load System**: Pause your adventure and resume later, or load a different character's save
- **The Thornwood**: A hand-crafted dark fairy tale world — a cursed kingdom of thorny forests, crumbling castles, and treacherous fey creatures across 10 interconnected locations

## Architecture

```
Browser (Web Audio API, 3 audio channels)
  |
  +-- WebSocket (16kHz PCM bidi) --> Cloud Run (FastAPI + ADK)
  |                                      |
  |<-- HTTP polling (images, NPC audio)--+--> Gemini 2.5 Flash Native Audio (DM voice)
  |                                      +--> Imagen 4 (scene art via tool call)
  |                                      +--> ScrappyLabs API (NPC character voices)
  |                                      +--> SQLite (session persistence)
  |                                      +--> Static music library (pre-generated MP3s)
```

### Key Design Decisions

- **ADK over raw Gemini Live API**: ADK handles session management, tool calling, and context compression. The bidi-streaming mode gives us full-duplex voice with tool interleaving.
- **Async asset delivery via HTTP polling**: Scene images and NPC audio are generated in background tasks and delivered via REST endpoints, not through the bidi WebSocket stream. This prevents large base64 payloads from crashing the Gemini connection (1007 errors).
- **Server-side session_id resolution**: Gemini sometimes hallucinates tool parameters. A server-side `session_context` module tracks the real WebSocket session ID and overrides any hallucinated values in tool calls.
- **3-channel browser audio mixing**: Separate AudioContext instances for DM voice (PCM worklet), NPC voice (decoded MP3), and music/SFX — enabling independent volume control and DM ducking during NPC speech.

## Tech Stack

| Component | Technology | Notes |
|-----------|-----------|-------|
| Voice AI Engine | Gemini 2.5 Flash Native Audio | Via ADK bidi-streaming |
| Agent Framework | `google-adk` (Python) | Open source, handles tool calling + context |
| NPC Voices | ScrappyLabs voice-design API | Qwen3-TTS with per-character voice seeds |
| Scene Art | Imagen 4 | Via `google-genai` SDK, 16:9 dark fantasy style |
| Backend | FastAPI + uvicorn | WebSocket + REST endpoints |
| Session Storage | SQLite (ADK `SqliteSessionService`) | Persistent across restarts |
| Game State | JSON files | Player stats, inventory, quests |
| Frontend | Vanilla HTML/CSS/JS | Web Audio API, zero framework dependencies |
| Hosting | Google Cloud Run | Session affinity for WebSocket, 1hr timeout |

## Quick Start

### Prerequisites
- Python 3.10+
- A Google AI API key (from [AI Studio](https://aistudio.google.com/) or Vertex AI)

### Run Locally

```bash
cd backend

# Create .env from template
cp .env.example .env
# Edit .env — add your GOOGLE_API_KEY

# Install dependencies (using uv or pip)
uv pip install -e .
# or: pip install -e .

# Run
uvicorn app.main:app --host 0.0.0.0 --port 8080 --ws-max-size 5242880
```

Open http://localhost:8080 — click **Speak** to start voice mode, or type in the text box.

> **Note**: Voice input requires HTTPS (or localhost). For remote access, use a reverse proxy with TLS.

### Deploy to Cloud Run

```bash
# Authenticate with GCP
gcloud auth login
gcloud config set project YOUR_PROJECT

# Create API key secret (first time only)
echo -n "YOUR_GEMINI_API_KEY" | gcloud secrets create GEMINI_API_KEY --data-file=-

# Deploy
bash deploy/deploy.sh
```

## The World: The Thornwood

A once-prosperous kingdom consumed by a creeping curse. The Thornwood — a forest of thorny vines and corrupted magic — grows outward from the castle, strangling villages and roads. Fey creatures from old stories have returned, darker and hungrier. The few remaining humans survive in pockets of resistance.

**10 Locations**: The Crossroads, Briarhollow Hamlet, Edge of the Thornwood, The Deep Thornwood, The Goblin Market, The Troll Bridge, The Witch's Hollow, The Briarthrone Approach, The Ruined Chapel, The Whispering Stones

**10 NPCs**: Marta the Innkeeper, Pip the orphan thief, Grimjaw the troll toll-keeper, The Thornweaver witch, Sir Aldric the cursed knight, Nixie the goblin merchant, Father Moss the hermit priest, Echo the stone spirit, Bramble the corrupted guardian, The Briar King

## Project Structure

```
grimdm/
├── backend/
│   ├── app/
│   │   ├── main.py                 # FastAPI + WebSocket + REST endpoints
│   │   ├── session_context.py      # Real session ID tracking (Gemini hallucination fix)
│   │   ├── models.py               # Pydantic: Player, Inventory, Quest, Combat
│   │   ├── dm_agent/
│   │   │   └── agent.py            # ADK Agent definition + DM system prompt
│   │   ├── tools/
│   │   │   ├── game.py             # 18 game tools: dice, inventory, combat, quests, NPCs
│   │   │   ├── npc_voice.py        # NPC voice generation (async queue + delivery)
│   │   │   ├── scene.py            # Imagen 4 scene art (async queue + delivery)
│   │   │   ├── music.py            # Background music + sound effects
│   │   │   └── player_voice.py     # Player voice capture + cloning
│   │   ├── game_data/
│   │   │   ├── world.json          # 10 locations with connections + atmosphere
│   │   │   ├── npcs.json           # 10 NPCs with voice configs + personalities
│   │   │   └── quests.json         # Quest templates
│   │   └── static/
│   │       ├── index.html          # Game interface
│   │       ├── css/game.css        # Dark fantasy theme
│   │       ├── js/
│   │       │   ├── app.js          # Main app + WebSocket + game UI
│   │       │   ├── audio-mixer.js  # 3-channel audio mixing
│   │       │   └── pcm-*.js        # AudioWorklet processors
│   │       └── music/              # Pre-generated MP3 loops + SFX
│   ├── Dockerfile
│   ├── pyproject.toml
│   └── .env.example
├── deploy/
│   └── deploy.sh                   # Cloud Run deployment script
└── README.md
```

## Audio Credits

Sound effects sourced from open-licensed packs:
- **RPG Sound Pack** (CC0) — sword_clash, coin_drop, door_creak, magic_cast, heal_potion, treasure_open, level_up, quest_accepted, shield_block, monster_growl, death_knell, armor_equip, sword_draw, footsteps_stone
- **Kenney Casino Audio** (CC0) — dice_roll
- **100 CC0 SFX #2** — thunder
- **Fire Crackling** (CC0) — campfire
- **Bow & Arrow Shot** (CC-BY-SA 3.0) — arrow_shot

Music loops generated via MiniMax AI.

## License

MIT
