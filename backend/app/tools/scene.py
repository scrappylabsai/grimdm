"""Scene image generation via Imagen 4 (Google GenAI SDK).

Images are stored in a pending queue and delivered to the browser via a separate
HTTP endpoint, NOT returned as tool results to Gemini (base64 in bidi = 1007 crash).
"""

import asyncio
import base64
import io
import json
import logging
import os

from PIL import Image

from pathlib import Path
from app.session_context import resolve_session_id

logger = logging.getLogger(__name__)


# Pre-rendered location images (served instantly, no API call)
_LOCATION_IMAGE_DIR = Path(__file__).parent.parent / "static" / "images" / "locations"

def _get_cached_location_image(location_id: str) -> str | None:
    """Return base64 JPEG if a pre-rendered image exists for this location."""
    path = _LOCATION_IMAGE_DIR / f"{location_id}.jpg"
    if path.exists():
        import base64 as _b64
        return _b64.b64encode(path.read_bytes()).decode()
    return None

STYLE_PREFIX = (
    "Dark fairy tale illustration, gothic fantasy art style, "
    "muted colors with dramatic lighting, ink and watercolor aesthetic, "
    "reminiscent of Arthur Rackham and Brian Froud. "
)

# Pending images keyed by session_id — polled by frontend
_pending_images: dict[str, list[dict]] = {}

# Player photos keyed by session_id — used as style references
_player_photos: dict[str, dict] = {}


def store_player_photo(session_id: str, image_base64: str, mime_type: str) -> None:
    """Store a player's camera photo for style reference."""
    _player_photos[session_id] = {
        "image_base64": image_base64,
        "mime_type": mime_type,
    }
    logger.info(f"Stored player photo for session={session_id}, mime={mime_type}")


def get_player_photo(session_id: str) -> dict | None:
    """Retrieve stored player photo for style reference."""
    return _player_photos.get(session_id)


def get_pending_images(session_id: str) -> list[dict]:
    """Pop all pending images for a session."""
    images = _pending_images.pop(session_id, [])
    if images:
        logger.info(f"Delivering {len(images)} scene image(s) for session={session_id}")
    return images


async def generate_scene_image(description: str, session_id: str) -> str:
    """Generate a dark fantasy scene illustration for the current game moment.

    Call this when the player enters a new location, encounters a dramatic scene,
    or when a significant event occurs. Keep descriptions vivid but concise.
    The image is sent directly to the player's screen — you don't need to describe it.

    Args:
        description: Scene description (e.g. "A crumbling stone bridge over a misty chasm")
        session_id: Current game session ID

    Returns:
        Confirmation that image is being generated (image delivered separately to player)
    """
    session_id = resolve_session_id(session_id)

    # Check if we have a pre-rendered image for a known location
    # Description often matches location name — check for location_id substring
    cached_b64 = None
    desc_lower = description.lower()
    for loc_id in ["crossroads", "hamlet", "thornwood_edge", "deep_thornwood",
                   "fairy_market", "old_bridge", "witch_hollow",
                   "cursed_castle_approach", "chapel_ruins", "standing_stones"]:
        loc_key = loc_id.replace("_", " ")
        if loc_key in desc_lower or loc_id in desc_lower:
            cached_b64 = _get_cached_location_image(loc_id)
            if cached_b64:
                logger.info(f"Serving pre-rendered image for location: {loc_id}")
                _pending_images.setdefault(session_id, []).append({
                    "image_base64": cached_b64,
                    "image_mime": "image/jpeg",
                    "description": description,
                })
                return json.dumps({
                    "status": "ready",
                    "description": description,
                    "message": "Scene illustration ready.",
                    "cached": True,
                })

    # No cached image — generate via Imagen 4 in background
    asyncio.create_task(_generate_image_bg(description, session_id))
    return json.dumps({
        "status": "generating",
        "description": description,
        "message": "Scene illustration is being painted for the player.",
    })


async def _generate_image_bg(description: str, session_id: str) -> None:
    """Background task: generate image and queue for browser delivery."""
    try:
        from google import genai

        client = genai.Client()
        prompt = STYLE_PREFIX + description

        response = await client.aio.models.generate_images(
            model="imagen-4.0-generate-001",
            prompt=prompt,
            config=genai.types.GenerateImagesConfig(
                number_of_images=1,
                aspect_ratio="16:9",
                safety_filter_level="BLOCK_LOW_AND_ABOVE",
            ),
        )

        if response.generated_images:
            img = response.generated_images[0]
            pil_img = Image.open(io.BytesIO(img.image.image_bytes))
            pil_img = pil_img.convert("RGB")
            if pil_img.width > 1280:
                ratio = 1280 / pil_img.width
                pil_img = pil_img.resize(
                    (1280, int(pil_img.height * ratio)), Image.LANCZOS
                )
            buf = io.BytesIO()
            pil_img.save(buf, format="JPEG", quality=80)
            img_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
            logger.info(f"Scene image ready: {len(buf.getvalue())} bytes JPEG")

            _pending_images.setdefault(session_id, []).append({
                "image_base64": img_b64,
                "image_mime": "image/jpeg",
                "description": description,
            })
            logger.info(f"Scene image queued for session={session_id}, pending keys: {list(_pending_images.keys())}")
        else:
            logger.warning(f"Scene image blocked by safety filter: {description}")

    except Exception as e:
        logger.error(f"Scene generation error: {e}")


async def generate_styled_scene(description: str, session_id: str) -> str:
    """Generate a scene illustration styled after the player's real environment.

    Uses the player's most recent camera photo as a style reference to blend
    their real-world surroundings into the dark fantasy scene art. Falls back
    to standard scene generation if no photo is available.

    Call this when the player has shared a photo of their environment and you
    want to create a scene that reflects their real-world setting in the game art.
    Use sparingly — 1-2 per session for maximum dramatic impact.

    Args:
        description: Scene description (e.g. "A crumbling throne room echoing the player's world")
        session_id: Current game session ID

    Returns:
        Confirmation that styled image is being generated
    """
    session_id = resolve_session_id(session_id)
    photo = get_player_photo(session_id)
    if not photo:
        # No player photo — fall back to standard generation
        asyncio.create_task(_generate_image_bg(description, session_id))
        return json.dumps({
            "status": "generating",
            "styled": False,
            "description": description,
            "message": "No player photo available — generating standard scene.",
        })

    asyncio.create_task(_generate_styled_image_bg(description, session_id, photo))
    return json.dumps({
        "status": "generating",
        "styled": True,
        "description": description,
        "message": "Painting a scene inspired by the player's world...",
    })


async def _generate_styled_image_bg(
    description: str, session_id: str, photo: dict
) -> None:
    """Background task: generate style-referenced image and queue for delivery."""
    try:
        from google import genai
        from google.genai import types as genai_types

        client = genai.Client()
        prompt = STYLE_PREFIX + description

        # Decode player photo for style reference
        photo_bytes = base64.b64decode(photo["image_base64"])

        response = await client.aio.models.edit_image(
            model="imagen-3.0-capability-001",
            prompt=prompt,
            reference_images=[
                genai_types.RawReferenceImage(
                    reference_id=1,
                    reference_image=genai_types.Image(
                        image_bytes=photo_bytes,
                    ),
                ),
            ],
            config=genai_types.EditImageConfig(
                edit_mode="EDIT_MODE_STYLE",
                number_of_images=1,
                output_mime_type="image/jpeg",
            ),
        )

        if response.generated_images:
            img = response.generated_images[0]
            pil_img = Image.open(io.BytesIO(img.image.image_bytes))
            pil_img = pil_img.convert("RGB")
            if pil_img.width > 1280:
                ratio = 1280 / pil_img.width
                pil_img = pil_img.resize(
                    (1280, int(pil_img.height * ratio)), Image.LANCZOS
                )
            buf = io.BytesIO()
            pil_img.save(buf, format="JPEG", quality=80)
            img_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
            logger.info(f"Styled scene image ready: {len(buf.getvalue())} bytes JPEG")

            _pending_images.setdefault(session_id, []).append({
                "image_base64": img_b64,
                "image_mime": "image/jpeg",
                "description": description,
            })
        else:
            logger.warning(f"Styled scene blocked by safety filter, falling back: {description}")
            await _generate_image_bg(description, session_id)

    except Exception as e:
        logger.error(f"Styled scene generation error: {e}, falling back to standard")
        await _generate_image_bg(description, session_id)
