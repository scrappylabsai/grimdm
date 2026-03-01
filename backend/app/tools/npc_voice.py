"""NPC voice generation via api.scrappylabs.ai voice-design endpoint.

Audio is generated in the background and delivered via a separate HTTP endpoint,
NOT returned as tool results to Gemini (base64 in bidi = 1007 crash).
Same pattern as scene image delivery.
"""

import asyncio
import base64
import json
import logging
import os
from pathlib import Path

import httpx

from app.session_context import resolve_session_id

logger = logging.getLogger(__name__)

SL_API_BASE = os.getenv("SL_API_URL", "https://api.scrappylabs.ai")

# Pending NPC audio keyed by session_id — polled by frontend
_pending_npc_audio: dict[str, list[dict]] = {}


def get_pending_npc_audio(session_id: str) -> list[dict]:
    """Pop all pending NPC audio for a session."""
    audio = _pending_npc_audio.pop(session_id, [])
    if audio:
        logger.info(f"Delivering {len(audio)} NPC audio(s) for session={session_id}")
    return audio


async def speak_as_npc(npc_id: str, text: str, session_id: str) -> str:
    """Generate speech audio for an NPC character using their unique voice.

    The DM should call this whenever an NPC speaks dialogue directly.
    The audio is generated in the background and delivered to the player's screen
    separately — you don't need to wait for it.

    Args:
        npc_id: NPC identifier (used to look up voice config)
        text: The dialogue text for the NPC to speak
        session_id: Current game session ID

    Returns:
        Confirmation that NPC voice is being generated (audio delivered separately)
    """
    session_id = resolve_session_id(session_id)

    # Load NPC voice config
    npc_path = Path(__file__).parent.parent / "game_data" / "npcs.json"
    with open(npc_path) as f:
        npcs_data = json.load(f)

    npc = npcs_data.get("npcs", {}).get(npc_id)
    if not npc:
        return json.dumps({"error": f"Unknown NPC: {npc_id}"})

    # Fire and forget — generate audio in background so DM keeps talking
    asyncio.create_task(_generate_npc_audio_bg(npc_id, npc, text, session_id))

    return json.dumps({
        "status": "generating",
        "npc_id": npc_id,
        "npc_name": npc["name"],
        "text": text,
        "message": f"{npc['name']} is speaking — their voice will reach the player.",
    })


async def _generate_npc_audio_bg(
    npc_id: str, npc: dict, text: str, session_id: str
) -> None:
    """Background task: generate NPC audio and queue for browser delivery."""
    voice_config = npc.get("voice", {})
    voice_description = voice_config.get("description", "A mysterious voice")
    voice_seed = voice_config.get("seed", 42)

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{SL_API_BASE}/api/voice-design",
                json={
                    "text": text,
                    "voice_description": voice_description,
                    "seed": voice_seed,
                },
            )
            response.raise_for_status()
            audio_data = response.content
            audio_b64 = base64.b64encode(audio_data).decode("utf-8")

            logger.info(
                f"NPC audio ready: {npc['name']} ({len(audio_data)} bytes MP3)"
            )

            _pending_npc_audio.setdefault(session_id, []).append({
                "npc_id": npc_id,
                "npc_name": npc["name"],
                "text": text,
                "audio_base64": audio_b64,
                "audio_mime": "audio/mpeg",
            })

    except httpx.HTTPStatusError as e:
        logger.error(f"NPC voice API error: {e.response.status_code}")
        # Queue text-only fallback so frontend still shows speech bubble
        _pending_npc_audio.setdefault(session_id, []).append({
            "npc_id": npc_id,
            "npc_name": npc["name"],
            "text": text,
            "audio_base64": None,
            "audio_mime": None,
        })
    except Exception as e:
        logger.error(f"NPC voice error: {e}")
        _pending_npc_audio.setdefault(session_id, []).append({
            "npc_id": npc_id,
            "npc_name": npc["name"],
            "text": text,
            "audio_base64": None,
            "audio_mime": None,
        })
