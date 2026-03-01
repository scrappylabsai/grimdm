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

from app.session_context import resolve_session_id

logger = logging.getLogger(__name__)

STYLE_PREFIX = (
    "Dark fairy tale illustration, gothic fantasy art style, "
    "muted colors with dramatic lighting, ink and watercolor aesthetic, "
    "reminiscent of Arthur Rackham and Brian Froud. "
)

# Pending images keyed by session_id — polled by frontend
_pending_images: dict[str, list[dict]] = {}


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
    # Override Gemini's hallucinated session_id with the real one
    session_id = resolve_session_id(session_id)
    # Fire and forget — generate in background so DM keeps talking
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
