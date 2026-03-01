"""Pydantic models for GrimDM game state."""

from __future__ import annotations

from enum import Enum
from pydantic import BaseModel, Field


class ItemType(str, Enum):
    WEAPON = "weapon"
    ARMOR = "armor"
    POTION = "potion"
    KEY = "key"
    QUEST = "quest"
    MISC = "misc"


class Item(BaseModel):
    name: str
    item_type: ItemType = ItemType.MISC
    description: str = ""
    damage: int | None = None
    defense: int | None = None
    healing: int | None = None
    quantity: int = 1


class QuestStatus(str, Enum):
    AVAILABLE = "available"
    ACTIVE = "active"
    COMPLETED = "completed"
    FAILED = "failed"


class Quest(BaseModel):
    quest_id: str
    name: str
    description: str
    status: QuestStatus = QuestStatus.AVAILABLE
    objectives: list[str] = Field(default_factory=list)
    completed_objectives: list[str] = Field(default_factory=list)
    reward_xp: int = 0
    reward_items: list[str] = Field(default_factory=list)


class NPCRelationship(BaseModel):
    npc_id: str
    disposition: int = 50  # 0=hostile, 50=neutral, 100=friendly
    met: bool = False
    notes: list[str] = Field(default_factory=list)


class CombatState(BaseModel):
    active: bool = False
    enemies: list[dict] = Field(default_factory=list)
    turn_order: list[str] = Field(default_factory=list)
    current_turn: int = 0
    round_number: int = 1


class CharacterStats(BaseModel):
    """Rolled character stats from creation."""
    strength: int = 10
    dexterity: int = 10
    constitution: int = 10
    wisdom: int = 10
    charisma: int = 10


class Player(BaseModel):
    name: str = "Wanderer"
    level: int = 1
    xp: int = 0
    hp: int = 20
    max_hp: int = 20
    attack: int = 5
    defense: int = 3
    stats: CharacterStats = Field(default_factory=CharacterStats)
    location: str = "crossroads"
    inventory: list[Item] = Field(default_factory=list)
    gold: int = 10
    quests: list[Quest] = Field(default_factory=list)
    npc_relationships: list[NPCRelationship] = Field(default_factory=list)
    combat: CombatState = Field(default_factory=CombatState)
    current_music: str = "village"
    voice_captured: bool = False


class GameState(BaseModel):
    """Full game state stored per session."""
    player: Player = Field(default_factory=Player)
    session_id: str = ""
    turn_count: int = 0
    events_log: list[str] = Field(default_factory=list)
