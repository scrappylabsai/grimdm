"""GrimDM — FastAPI application with WebSocket streaming via ADK Gemini Live API."""

import asyncio
import base64
import json
import logging
import warnings
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from google.adk.agents.live_request_queue import LiveRequestQueue
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import Runner
from google.adk.sessions.sqlite_session_service import SqliteSessionService
from google.genai import types

# Load environment variables before importing agent
load_dotenv(Path(__file__).parent / ".env")

from app.dm_agent.agent import agent  # noqa: E402
from app.session_context import set_active_session  # noqa: E402
from app.story_tracker import (  # noqa: E402
    track_dm_utterance,
    save_story_context,
    clear_session as clear_story_session,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)
warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")

APP_NAME = "grimdm"

# --- FastAPI App ---

app = FastAPI(title="GrimDM", version="0.1.0")


class NoCacheStaticMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return response


app.add_middleware(NoCacheStaticMiddleware)

static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=static_dir), name="static")

# Use SQLite for persistent sessions (survives server restarts + browser refreshes)
# Falls back to in-memory if SQLite path not writable (e.g. read-only container)
_db_path = Path(__file__).parent.parent / "data" / "sessions.db"
_db_path.parent.mkdir(parents=True, exist_ok=True)
session_service = SqliteSessionService(db_path=str(_db_path))
logger.info(f"Session persistence: SQLite at {_db_path}")

runner = Runner(app_name=APP_NAME, agent=agent, session_service=session_service)

# Track which sessions have an active game (survives WS reconnects within same process)
_active_games: dict[str, bool] = {}


def _build_reconnect_prompt(session_id: str) -> str:
    """Build a context-rich reconnect prompt from persisted game state."""
    from app.tools.game import _get_state
    state = _get_state(session_id)
    p = state.player

    lines = [
        "CONNECTION RESTORED. Current game state — absorb and continue:",
        f"Player: {p.name}, Level {p.level}, HP {p.hp}/{p.max_hp}, Location: {p.location}",
    ]

    if p.combat.active:
        enemies = ", ".join(
            f"{e['name']} HP:{e['hp']}/{e.get('max_hp', e['hp'])}"
            for e in p.combat.enemies if e["hp"] > 0
        )
        lines.append(f"IN COMBAT with: {enemies} (round {p.combat.round_number})")

    if state.story_context:
        lines.append(f"Recent story: {state.story_context}")

    if state.events_log:
        recent = state.events_log[-5:]
        lines.append(f"Recent events: {'; '.join(recent)}")

    active_quests = [q.name for q in p.quests if q.status.value == "active"]
    if active_quests:
        lines.append(f"Active quests: {', '.join(active_quests)}")

    lines.append(
        "Resume naturally. One sentence acknowledging the interruption, then continue."
    )
    return "\n".join(lines)


@app.get("/")
async def root():
    """Serve the game interface."""
    return FileResponse(static_dir / "index.html")


@app.get("/health")
async def health():
    """Health check for Cloud Run."""
    return {"status": "ok", "app": APP_NAME, "model": agent.model}


@app.get("/api/scene-images/{session_id}")
async def poll_scene_images(session_id: str):
    """Poll for pending scene images (generated async, delivered here)."""
    from app.tools.scene import get_pending_images
    images = get_pending_images(session_id)
    return {"images": images}


class PlayerPhotoRequest(BaseModel):
    session_id: str
    image_base64: str
    mime_type: str = "image/jpeg"


@app.post("/api/store-player-photo")
async def store_player_photo_endpoint(req: PlayerPhotoRequest):
    """Store a player's camera photo for styled scene generation."""
    from app.tools.scene import store_player_photo
    store_player_photo(req.session_id, req.image_base64, req.mime_type)
    return {"status": "ok"}


@app.get("/api/theater-events/{session_id}")
async def poll_theater_events(session_id: str):
    """Poll for pending theater events (gesture battles, etc.)."""
    from app.tools.game import get_theater_events
    events = get_theater_events(session_id)
    return {"events": events}


@app.get("/api/npc-audio/{session_id}")
async def poll_npc_audio(session_id: str):
    """Poll for pending NPC voice audio (generated async, delivered here)."""
    from app.tools.npc_voice import get_pending_npc_audio
    audio = get_pending_npc_audio(session_id)
    return {"audio": audio}


@app.get("/api/saved-games")
async def list_saved_games():
    """List all saved game states for the load screen."""
    from app.tools.game import _STATE_DIR
    saves = []
    for path in sorted(_STATE_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            data = json.loads(path.read_text())
            player = data.get("player", {})
            name = player.get("name", "Unknown")
            if name == "Wanderer":
                continue  # Skip empty/unused sessions
            saves.append({
                "session_id": path.stem,
                "name": name,
                "level": player.get("level", 1),
                "location": player.get("location", "unknown"),
            })
        except Exception:
            continue
    return {"saves": saves[:10]}  # Last 10 saves


@app.get("/api/game-state/{session_id}")
async def get_game_state(session_id: str):
    """Get persisted game state for a session (used on page reload)."""
    from app.tools.game import _get_state, _load_world
    state = _get_state(session_id)
    p = state.player
    world = _load_world()
    loc = world.get("locations", {}).get(p.location, {})
    return {
        "name": p.name,
        "level": p.level,
        "hp": p.hp,
        "max_hp": p.max_hp,
        "xp": p.xp,
        "attack": p.attack,
        "defense": p.defense,
        "gold": p.gold,
        "location": loc.get("name", p.location),
        "stats": p.stats.model_dump(),
        "inventory": [item.model_dump() for item in p.inventory],
        "quests": [q.model_dump() for q in p.quests if q.status.value == "active"],
        "combat_active": p.combat.active,
        "connections": loc.get("connections", []),
        "exit_directions": loc.get("directions", {}),
    }


# --- WebSocket Endpoint ---

@app.websocket("/ws/{user_id}/{session_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    user_id: str,
    session_id: str,
) -> None:
    """Bidirectional streaming WebSocket for voice gameplay."""
    logger.info(f"WS connect: user={user_id}, session={session_id}")
    set_active_session(user_id, session_id)
    await websocket.accept()

    # Native audio model — always use AUDIO response modality
    run_config = RunConfig(
        streaming_mode=StreamingMode.BIDI,
        response_modalities=["AUDIO"],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
    )

    # Get or create session
    session = await session_service.get_session(
        app_name=APP_NAME, user_id=user_id, session_id=session_id
    )
    if not session:
        await session_service.create_session(
            app_name=APP_NAME, user_id=user_id, session_id=session_id
        )

    live_request_queue = LiveRequestQueue()

    # Determine opening vs reconnect prompt
    from app.tools.game import _get_state
    if not _active_games.get(session_id):
        state = _get_state(session_id)
        if state.turn_count > 0 and state.player.name != "Wanderer":
            # Returning player after server restart — reconnect with context
            prompt_text = _build_reconnect_prompt(session_id)
            logger.info(f"Reconnect (server restart): {session_id}, player={state.player.name}")
        else:
            # Fresh game
            prompt_text = "The player has just connected. Begin the game — greet them and ask their name."
    else:
        # WS crashed but same server process — reconnect with context
        prompt_text = _build_reconnect_prompt(session_id)
        logger.info(f"Reconnect (WS crash): {session_id}")

    _active_games[session_id] = True
    live_request_queue.send_content(
        types.Content(parts=[types.Part(text=prompt_text)])
    )

    async def upstream_task() -> None:
        """Receive messages from browser WebSocket and queue for ADK."""
        while True:
            message = await websocket.receive()

            if "bytes" in message:
                raw = message["bytes"]
                if len(raw) < 2 or len(raw) % 2 != 0:
                    continue
                audio_blob = types.Blob(
                    mime_type="audio/pcm;rate=16000", data=raw
                )
                live_request_queue.send_realtime(audio_blob)

            elif "text" in message:
                json_message = json.loads(message["text"])
                msg_type = json_message.get("type")

                if msg_type == "ping":
                    continue

                if msg_type == "text":
                    content = types.Content(
                        parts=[types.Part(text=json_message["text"])]
                    )
                    live_request_queue.send_content(content)

                elif msg_type == "image":
                    image_data = base64.b64decode(json_message["data"])
                    mime_type = json_message.get("mimeType", "image/jpeg")
                    image_blob = types.Blob(mime_type=mime_type, data=image_data)
                    live_request_queue.send_realtime(image_blob)

    # Track thinking text so we can filter the duplicate non-thought copy
    seen_thinking_texts: set[str] = set()

    async def downstream_task() -> None:
        """Receive ADK events and send to browser WebSocket."""
        async for event in runner.run_live(
            user_id=user_id,
            session_id=session_id,
            live_request_queue=live_request_queue,
            run_config=run_config,
        ):
            # Filter out thinking/reasoning content before sending to browser.
            # ADK sends thinking text twice: once with thought=True, once without.
            # We strip both copies server-side.
            if hasattr(event, "content") and event.content and event.content.parts:
                filtered_parts = []
                for part in event.content.parts:
                    if hasattr(part, "thought") and part.thought:
                        # Track thinking text so we can catch the duplicate
                        if hasattr(part, "text") and part.text:
                            seen_thinking_texts.add(part.text[:100])
                        continue
                    # Filter duplicate: non-thought text that matches a thinking part
                    if hasattr(part, "text") and part.text:
                        if part.text[:100] in seen_thinking_texts:
                            continue
                    filtered_parts.append(part)

                if not filtered_parts:
                    continue  # Skip entirely empty events
                event.content.parts = filtered_parts

            # Track DM text for story context (crash recovery)
            # In audio mode, DM speech arrives as outputTranscription, not content.parts.text
            if hasattr(event, "outputTranscription") and event.outputTranscription:
                ot = event.outputTranscription
                if hasattr(ot, "text") and ot.text and getattr(ot, "finished", False):
                    track_dm_utterance(session_id, ot.text)
            if hasattr(event, "content") and event.content and event.content.parts:
                for part in event.content.parts:
                    if hasattr(part, "text") and part.text and not getattr(part, "thought", False):
                        track_dm_utterance(session_id, part.text)

            # Log tool calls and results for debugging
            if hasattr(event, "content") and event.content and event.content.parts:
                for part in event.content.parts:
                    if hasattr(part, "function_call") and part.function_call:
                        logger.info(f"Tool call: {part.function_call.name}")
                    if hasattr(part, "function_response") and part.function_response:
                        logger.info(f"Tool result: {part.function_response.name}")

            event_json = event.model_dump_json(exclude_none=True, by_alias=True)
            await websocket.send_text(event_json)

    try:
        await asyncio.gather(upstream_task(), downstream_task())
    except WebSocketDisconnect:
        logger.info(f"Client disconnected: user={user_id}")
    except Exception as e:
        error_msg = str(e)
        logger.error(f"WS error: {e}", exc_info=True)
        # 1007/1008 on reconnect = corrupted session history in SQLite
        # Delete the session so next reconnect gets a fresh one
        if "1007" in error_msg or "1008" in error_msg:
            logger.warning(f"Clearing corrupted session: {session_id}")
            try:
                await session_service.delete_session(
                    app_name=APP_NAME, user_id=user_id, session_id=session_id
                )
            except Exception:
                pass  # delete_session may not exist in all ADK versions
    finally:
        save_story_context(session_id)
        clear_story_session(session_id)
        live_request_queue.close()
