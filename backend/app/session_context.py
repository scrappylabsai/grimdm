"""Track active WebSocket session IDs.

Gemini hallucinates session_id values when calling tools (e.g. "default_session").
This module tracks the REAL session_id from the WebSocket connection so tools can
use the correct one regardless of what Gemini passes.
"""

import logging

logger = logging.getLogger(__name__)

# Map user_id → session_id (set on WebSocket connect)
_active_sessions: dict[str, str] = {}

# Fallback: last active session (for single-player simplicity)
_last_session_id: str | None = None


def set_active_session(user_id: str, session_id: str) -> None:
    """Register the active session for a user (called on WebSocket connect)."""
    global _last_session_id
    _active_sessions[user_id] = session_id
    _last_session_id = session_id
    logger.info(f"Active session set: user={user_id} → session={session_id}")


def resolve_session_id(session_id: str) -> str:
    """Get the real session_id, ignoring Gemini's hallucinated value.

    Falls back to the last active session for single-player mode.
    """
    if _last_session_id:
        if session_id != _last_session_id:
            logger.debug(f"Overriding Gemini session_id '{session_id}' → '{_last_session_id}'")
        return _last_session_id
    return session_id
