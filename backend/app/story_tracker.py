"""Narrative context tracker for GrimDM crash recovery.

Captures rolling DM utterances so reconnect prompts can restore story context.
Pure string ops — no LLM calls.
"""

from collections import deque

from app.tools.game import _get_state, _save_state

_dm_utterances: dict[str, deque] = {}

_MAX_UTTERANCES = 6


def track_dm_utterance(session_id: str, text: str) -> None:
    """Append DM text to the rolling buffer. Skip short fragments."""
    if not text or len(text) < 10:
        return
    if session_id not in _dm_utterances:
        _dm_utterances[session_id] = deque(maxlen=_MAX_UTTERANCES)
    _dm_utterances[session_id].append(text.strip())


def get_story_context(session_id: str) -> str:
    """Return pipe-joined summary of recent DM utterances."""
    buf = _dm_utterances.get(session_id)
    if not buf:
        return ""
    return " | ".join(buf)


def save_story_context(session_id: str) -> None:
    """Persist current story context and last utterance to game state JSON."""
    buf = _dm_utterances.get(session_id)
    if not buf:
        return
    state = _get_state(session_id)
    state.story_context = " | ".join(buf)
    state.last_dm_utterance = buf[-1] if buf else ""
    _save_state(session_id)


def clear_session(session_id: str) -> None:
    """Clean up in-memory buffer for a session."""
    _dm_utterances.pop(session_id, None)
