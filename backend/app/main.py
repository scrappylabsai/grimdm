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
from google.adk.agents.live_request_queue import LiveRequestQueue
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

# Load environment variables before importing agent
load_dotenv(Path(__file__).parent / ".env")

from dm_agent.agent import agent  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)
warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")

APP_NAME = "grimdm"

# --- FastAPI App ---

app = FastAPI(title="GrimDM", version="0.1.0")

static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=static_dir), name="static")

session_service = InMemorySessionService()
runner = Runner(app_name=APP_NAME, agent=agent, session_service=session_service)


@app.get("/")
async def root():
    """Serve the game interface."""
    return FileResponse(static_dir / "index.html")


@app.get("/health")
async def health():
    """Health check for Cloud Run."""
    return {"status": "ok", "app": APP_NAME, "model": agent.model}


# --- WebSocket Endpoint ---

@app.websocket("/ws/{user_id}/{session_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    user_id: str,
    session_id: str,
) -> None:
    """Bidirectional streaming WebSocket for voice gameplay."""
    logger.info(f"WS connect: user={user_id}, session={session_id}")
    await websocket.accept()

    # Native audio model — always use AUDIO response modality
    run_config = RunConfig(
        streaming_mode=StreamingMode.BIDI,
        response_modalities=["AUDIO"],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        session_resumption=types.SessionResumptionConfig(),
        enable_affective_dialog=True,
    )

    # Get or create session
    session = await session_service.get_session(
        app_name=APP_NAME, user_id=user_id, session_id=session_id
    )
    if not session:
        await session_service.create_session(
            app_name=APP_NAME, user_id=user_id, session_id=session_id
        )

    # Inject session_id into tool calls via state
    # Tools receive session_id as a parameter from the agent
    live_request_queue = LiveRequestQueue()

    async def upstream_task() -> None:
        """Receive messages from browser WebSocket and queue for ADK."""
        while True:
            message = await websocket.receive()

            if "bytes" in message:
                audio_blob = types.Blob(
                    mime_type="audio/pcm;rate=16000", data=message["bytes"]
                )
                live_request_queue.send_realtime(audio_blob)

            elif "text" in message:
                json_message = json.loads(message["text"])

                if json_message.get("type") == "text":
                    content = types.Content(
                        parts=[types.Part(text=json_message["text"])]
                    )
                    live_request_queue.send_content(content)

                elif json_message.get("type") == "image":
                    image_data = base64.b64decode(json_message["data"])
                    mime_type = json_message.get("mimeType", "image/jpeg")
                    image_blob = types.Blob(mime_type=mime_type, data=image_data)
                    live_request_queue.send_realtime(image_blob)

    async def downstream_task() -> None:
        """Receive ADK events and send to browser WebSocket."""
        async for event in runner.run_live(
            user_id=user_id,
            session_id=session_id,
            live_request_queue=live_request_queue,
            run_config=run_config,
        ):
            event_json = event.model_dump_json(exclude_none=True, by_alias=True)
            await websocket.send_text(event_json)

    try:
        await asyncio.gather(upstream_task(), downstream_task())
    except WebSocketDisconnect:
        logger.info(f"Client disconnected: user={user_id}")
    except Exception as e:
        logger.error(f"WS error: {e}", exc_info=True)
    finally:
        live_request_queue.close()
