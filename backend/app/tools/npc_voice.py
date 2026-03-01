"""NPC voice generation via api.scrappylabs.ai voice-design endpoint."""

import json
import logging
import os

import httpx

logger = logging.getLogger(__name__)

SL_API_BASE = os.getenv("SL_API_URL", "https://api.scrappylabs.ai")


async def speak_as_npc(npc_id: str, text: str, session_id: str) -> str:
    """Generate speech audio for an NPC character using their unique voice.

    The DM should call this whenever an NPC speaks dialogue directly.
    The audio URL is returned and sent to the frontend for playback on the NPC audio channel.

    Args:
        npc_id: NPC identifier (used to look up voice config)
        text: The dialogue text for the NPC to speak
        session_id: Current game session ID

    Returns:
        JSON with audio URL for the NPC's speech, or error
    """
    from pathlib import Path

    # Load NPC voice config
    npc_path = Path(__file__).parent.parent / "game_data" / "npcs.json"
    with open(npc_path) as f:
        npcs_data = json.load(f)

    npc = npcs_data.get("npcs", {}).get(npc_id)
    if not npc:
        return json.dumps({"error": f"Unknown NPC: {npc_id}"})

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

            # Return base64 audio for frontend playback
            import base64
            audio_b64 = base64.b64encode(audio_data).decode("utf-8")

            return json.dumps({
                "status": "ok",
                "npc_id": npc_id,
                "npc_name": npc["name"],
                "audio_base64": audio_b64,
                "audio_mime": "audio/mpeg",
                "text": text,
            })

    except httpx.HTTPStatusError as e:
        logger.error(f"NPC voice API error: {e.response.status_code}")
        return json.dumps({
            "error": f"Voice generation failed: {e.response.status_code}",
            "npc_id": npc_id,
            "text": text,
            "fallback": "Display text as subtitle instead",
        })
    except Exception as e:
        logger.error(f"NPC voice error: {e}")
        return json.dumps({
            "error": str(e),
            "npc_id": npc_id,
            "text": text,
            "fallback": "Display text as subtitle instead",
        })
