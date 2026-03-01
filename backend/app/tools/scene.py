"""Scene image generation via Imagen 4 (Google GenAI SDK)."""

import base64
import json
import logging
import os

logger = logging.getLogger(__name__)

STYLE_PREFIX = (
    "Dark fairy tale illustration, gothic fantasy art style, "
    "muted colors with dramatic lighting, ink and watercolor aesthetic, "
    "reminiscent of Arthur Rackham and Brian Froud. "
)


async def generate_scene_image(description: str, session_id: str) -> str:
    """Generate a dark fantasy scene illustration for the current game moment.

    Call this when the player enters a new location, encounters a dramatic scene,
    or when a significant event occurs. Keep descriptions vivid but concise.

    Args:
        description: Scene description (e.g. "A crumbling stone bridge over a misty chasm")
        session_id: Current game session ID

    Returns:
        JSON with base64 image data or error
    """
    try:
        from google import genai

        client = genai.Client()

        prompt = STYLE_PREFIX + description

        response = await client.aio.models.generate_images(
            model="imagen-4.0-generate-preview-06-06",
            prompt=prompt,
            config=genai.types.GenerateImagesConfig(
                number_of_images=1,
                aspect_ratio="16:9",
                safety_filter_level="BLOCK_MEDIUM_AND_ABOVE",
            ),
        )

        if response.generated_images:
            img = response.generated_images[0]
            img_b64 = base64.b64encode(img.image.image_bytes).decode("utf-8")
            return json.dumps({
                "status": "ok",
                "image_base64": img_b64,
                "image_mime": "image/png",
                "description": description,
            })
        else:
            return json.dumps({
                "error": "No image generated (safety filter may have blocked)",
                "description": description,
            })

    except Exception as e:
        logger.error(f"Scene generation error: {e}")
        return json.dumps({
            "error": str(e),
            "description": description,
        })
