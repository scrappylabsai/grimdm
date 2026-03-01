"""Player voice capture & cloning for dynamic story productions.

Captures a few seconds of the player's speech during character creation,
clones their voice via Qwen3-TTS on Mother, and uses it to insert the
player's voice into story narration and NPC conversations.

Audio is delivered via the NPC audio polling endpoint (same async pattern).
"""

import asyncio
import base64
import json
import logging
import os

import httpx

from app.session_context import resolve_session_id

logger = logging.getLogger(__name__)

SL_API_BASE = os.getenv("SL_API_URL", "https://api.scrappylabs.ai")

# In-memory store of player voice references per session
_player_voices: dict[str, dict] = {}


def capture_player_voice(audio_base64: str, session_id: str) -> str:
    """Store a sample of the player's voice for cloning.

    Call this after the player speaks their name or a few sentences during
    character creation. The audio is stored as a reference for later voice
    cloning to insert the player's voice into the story.

    Args:
        audio_base64: Base64-encoded audio sample (PCM 16kHz or WAV)
        session_id: Current game session ID

    Returns:
        Confirmation that voice was captured
    """
    session_id = resolve_session_id(session_id)
    _player_voices[session_id] = {
        "audio_b64": audio_base64,
        "captured": True,
    }
    logger.info(f"Player voice captured for session {session_id} ({len(audio_base64)} chars)")
    return json.dumps({
        "status": "ok",
        "message": "Voice captured. The player's voice can now be used in story narration.",
    })


async def speak_as_player(text: str, session_id: str) -> str:
    """Generate speech in the player's cloned voice for story narration.

    Use this to insert the player's voice into the narrative — for example,
    replaying their dramatic declarations, or having their character speak
    in cutscene-like moments. The audio is delivered to the player separately.

    Args:
        text: The dialogue or line for the player's character to speak
        session_id: Current game session ID

    Returns:
        Confirmation that player voice is being generated (audio delivered separately)
    """
    session_id = resolve_session_id(session_id)
    voice_data = _player_voices.get(session_id)
    if not voice_data or not voice_data.get("captured"):
        return json.dumps({
            "error": "No player voice captured yet. Ask the player to speak first.",
        })

    # Fire and forget — generate in background
    asyncio.create_task(_generate_player_voice_bg(text, voice_data, session_id))

    return json.dumps({
        "status": "generating",
        "text": text,
        "message": "The player's voice will echo through the tale...",
    })


async def _generate_player_voice_bg(
    text: str, voice_data: dict, session_id: str
) -> None:
    """Background task: generate player voice clone and queue for delivery."""
    from app.tools.npc_voice import _pending_npc_audio

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{SL_API_BASE}/api/voice-clone",
                json={
                    "text": text,
                    "reference_audio": voice_data["audio_b64"],
                },
            )
            response.raise_for_status()
            audio_data = response.content
            audio_b64 = base64.b64encode(audio_data).decode("utf-8")

            logger.info(f"Player voice ready: {len(audio_data)} bytes MP3")

            # Deliver via NPC audio channel (same polling endpoint)
            _pending_npc_audio.setdefault(session_id, []).append({
                "npc_id": "_player",
                "npc_name": "You",
                "text": text,
                "audio_base64": audio_b64,
                "audio_mime": "audio/mpeg",
            })

    except Exception as e:
        logger.error(f"Player voice clone error: {e}")
