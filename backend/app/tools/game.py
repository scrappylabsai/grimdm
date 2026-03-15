"""Core game mechanic tools for GrimDM.

These are registered as ADK tools that Gemini can call during gameplay.
Game state is persisted to JSON files in data/game_states/.
"""

import json
import logging
import random
from pathlib import Path

from app.models import (
    CharacterStats,
    CombatState,
    GameState,
    Item,
    ItemType,
    NPCRelationship,
    Quest,
    QuestStatus,
)
from app.session_context import resolve_session_id

logger = logging.getLogger(__name__)

# In-memory cache + JSON file persistence
_game_states: dict[str, GameState] = {}
_STATE_DIR = Path(__file__).parent.parent.parent / "data" / "game_states"
_STATE_DIR.mkdir(parents=True, exist_ok=True)
_MAX_EVENTS_LOG = 50
XP_PER_LEVEL = 100  # XP needed to gain each level (flat)


def _award_xp(state, amount: int) -> dict:
    """Award XP, auto level-up if threshold crossed. Returns xp info dict."""
    state.player.xp += amount
    new_level = state.player.xp // XP_PER_LEVEL + 1
    leveled_up = new_level > state.player.level
    if leveled_up:
        gains = new_level - state.player.level
        state.player.level = new_level
        state.player.max_hp += 5 * gains
        state.player.hp = min(state.player.hp + 5 * gains, state.player.max_hp)
        state.player.attack += gains
        state.events_log.append(f"LEVEL UP! Now level {state.player.level}")
    return {
        "xp": state.player.xp,
        "level": state.player.level,
        "xp_in_level": state.player.xp % XP_PER_LEVEL,
        "xp_to_next": XP_PER_LEVEL - (state.player.xp % XP_PER_LEVEL),
        "leveled_up": leveled_up,
        "new_level": state.player.level if leveled_up else None,
        "hp_max": state.player.max_hp,
        "hp": state.player.hp,
        "attack": state.player.attack,
    }




def _state_path(session_id: str) -> Path:
    # Sanitize session_id for filesystem safety
    safe_id = "".join(c for c in session_id if c.isalnum() or c in "-_")
    return _STATE_DIR / f"{safe_id}.json"


def _get_state(session_id: str) -> GameState:
    if session_id not in _game_states:
        path = _state_path(session_id)
        if path.exists():
            try:
                data = json.loads(path.read_text())
                _game_states[session_id] = GameState.model_validate(data)
                logger.info(f"Loaded game state from {path}")
            except Exception as e:
                logger.warning(f"Failed to load game state: {e}, creating new")
                _game_states[session_id] = GameState(session_id=session_id)
        else:
            _game_states[session_id] = GameState(session_id=session_id)
    return _game_states[session_id]


def _save_state(session_id: str) -> None:
    if session_id in _game_states:
        state = _game_states[session_id]
        if len(state.events_log) > _MAX_EVENTS_LOG:
            state.events_log = state.events_log[-_MAX_EVENTS_LOG:]
        path = _state_path(session_id)
        path.write_text(state.model_dump_json(indent=2))



def _load_world() -> dict:
    """Load world data from JSON."""
    import importlib.resources as pkg_resources
    from pathlib import Path

    world_path = Path(__file__).parent.parent / "game_data" / "world.json"
    with open(world_path) as f:
        return json.load(f)


def _load_npcs() -> dict:
    """Load NPC data from JSON."""
    from pathlib import Path

    npc_path = Path(__file__).parent.parent / "game_data" / "npcs.json"
    with open(npc_path) as f:
        return json.load(f)


def _load_quests() -> dict:
    """Load quest data from JSON."""
    from pathlib import Path

    quest_path = Path(__file__).parent.parent / "game_data" / "quests.json"
    with open(quest_path) as f:
        return json.load(f)


# --- Dice ---

def roll_dice(notation: str, session_id: str) -> str:
    """Roll dice using standard RPG notation like '2d6', 'd20+4', '3d8-2'.

    Args:
        notation: Dice notation (e.g. 'd20', '2d6+3', '3d8-1')
        session_id: Current game session ID

    Returns:
        JSON with individual rolls, modifier, and total
    """
    session_id = resolve_session_id(session_id)
    notation = notation.lower().strip()

    # Parse notation: NdS+M or NdS-M
    modifier = 0
    if "+" in notation:
        dice_part, mod_str = notation.split("+", 1)
        modifier = int(mod_str)
    elif "-" in notation.split("d", 1)[-1]:
        parts = notation.rsplit("-", 1)
        dice_part = parts[0]
        modifier = -int(parts[1])
    else:
        dice_part = notation

    if "d" not in dice_part:
        return json.dumps({"error": f"Invalid dice notation: {notation}"})

    parts = dice_part.split("d")
    num_dice = int(parts[0]) if parts[0] else 1
    sides = int(parts[1])

    if num_dice < 1 or num_dice > 20 or sides < 2 or sides > 100:
        return json.dumps({"error": "Dice must be 1-20 dice with 2-100 sides"})

    rolls = [random.randint(1, sides) for _ in range(num_dice)]
    total = sum(rolls) + modifier

    state = _get_state(session_id)
    state.events_log.append(f"Rolled {notation}: {rolls} + {modifier} = {total}")
    _save_state(session_id)

    result = {
        "notation": notation,
        "rolls": rolls,
        "modifier": modifier,
        "total": total,
        "natural_20": sides == 20 and num_dice == 1 and rolls[0] == 20,
        "natural_1": sides == 20 and num_dice == 1 and rolls[0] == 1,
    }
    return json.dumps(result)


# --- Player Info ---

def get_player_status(session_id: str) -> str:
    """Get the current player's full status including HP, level, location, gold.

    Args:
        session_id: Current game session ID

    Returns:
        JSON with player stats
    """
    session_id = resolve_session_id(session_id)
    state = _get_state(session_id)
    p = state.player
    return json.dumps({
        "name": p.name,
        "level": p.level,
        "xp": p.xp,
        "xp_in_level": p.xp % XP_PER_LEVEL,
        "xp_to_next": XP_PER_LEVEL - (p.xp % XP_PER_LEVEL),
        "hp": p.hp,
        "max_hp": p.max_hp,
        "attack": p.attack,
        "defense": p.defense,
        "stats": p.stats.model_dump(),
        "location": p.location,
        "gold": p.gold,
        "inventory_count": len(p.inventory),
        "active_quests": len([q for q in p.quests if q.status == QuestStatus.ACTIVE]),
        "combat_active": p.combat.active,
        "current_music": p.current_music,
    })


def award_xp(amount: int, reason: str, session_id: str) -> str:
    """Award experience points to the player for roleplay, clever solutions, exploration, or bravery.

    Use this to reward players who dive deep into roleplay, ask interesting questions to NPCs,
    make creative decisions, explore dangerous areas, or do something memorable. Small frequent
    rewards (5-15 XP) feel better than rare large ones.

    Suggested amounts:
    - 5 XP: Good roleplay moment, staying in character
    - 10 XP: Clever solution, creative thinking, asking great NPC questions
    - 15 XP: Exceptional roleplay, brave or risky decision, deeply exploring lore
    - 20 XP: Truly memorable moment, brilliant strategy, emotional scene
    - 25 XP: Combat victory (awarded automatically, don't double-award)

    Args:
        amount: XP to award (5-25 range recommended)
        reason: Brief reason shown to the player (e.g. "clever negotiation", "deep roleplay")
        session_id: Current game session ID

    Returns:
        JSON with updated XP totals and level info
    """
    session_id = resolve_session_id(session_id)
    state = _get_state(session_id)
    amount = max(1, min(50, amount))  # clamp to sane range
    xp_info = _award_xp(state, amount)
    xp_info["reason"] = reason
    xp_info["xp_awarded"] = amount
    state.events_log.append(f"XP +{amount}: {reason}")
    _save_state(session_id)
    return json.dumps(xp_info)


def set_player_name(name: str, session_id: str) -> str:
    """Set the player's character name.

    Args:
        name: The character name chosen by the player
        session_id: Current game session ID

    Returns:
        Confirmation message
    """
    session_id = resolve_session_id(session_id)
    state = _get_state(session_id)
    state.player.name = name
    state.events_log.append(f"Player named themselves: {name}")
    _save_state(session_id)
    return json.dumps({"status": "ok", "name": name})


def roll_character_stats(session_id: str) -> str:
    """Roll all five character stats at once during character creation.

    Rolls d20 for Strength, Dexterity, Constitution, Wisdom, and Charisma.
    Automatically sets the player's stats and derives combat values (ATK, DEF, HP).
    Call this ONCE during character creation — it handles all five rolls.

    Args:
        session_id: Current game session ID

    Returns:
        All five rolls with individual results plus derived combat values
    """
    session_id = resolve_session_id(session_id)
    state = _get_state(session_id)

    # Roll all five stats
    rolls = {
        "strength": random.randint(1, 20),
        "dexterity": random.randint(1, 20),
        "constitution": random.randint(1, 20),
        "wisdom": random.randint(1, 20),
        "charisma": random.randint(1, 20),
    }

    state.player.stats = CharacterStats(**rolls)

    # Derive combat stats
    state.player.attack = 3 + rolls["strength"] // 4
    state.player.defense = 2 + rolls["dexterity"] // 4
    state.player.max_hp = 15 + rolls["constitution"]
    state.player.hp = state.player.max_hp

    state.events_log.append(
        f"Character stats rolled: STR={rolls['strength']} DEX={rolls['dexterity']} "
        f"CON={rolls['constitution']} WIS={rolls['wisdom']} CHA={rolls['charisma']}"
    )
    _save_state(session_id)

    return json.dumps({
        "status": "ok",
        "rolls": rolls,
        "derived": {
            "attack": state.player.attack,
            "defense": state.player.defense,
            "hp": state.player.hp,
            "max_hp": state.player.max_hp,
        },
    })


# --- Inventory ---

def check_inventory(session_id: str) -> str:
    """Check the player's current inventory.

    Args:
        session_id: Current game session ID

    Returns:
        JSON list of items in inventory
    """
    session_id = resolve_session_id(session_id)
    state = _get_state(session_id)
    items = [item.model_dump() for item in state.player.inventory]
    return json.dumps({"items": items, "gold": state.player.gold})


def add_item(name: str, item_type: str, description: str, session_id: str,
             damage: int | None = None, defense: int | None = None,
             healing: int | None = None, quantity: int = 1) -> str:
    """Add an item to the player's inventory.

    Args:
        name: Item name
        item_type: One of: weapon, armor, potion, key, quest, misc
        description: Brief item description
        session_id: Current game session ID
        damage: Damage value for weapons
        defense: Defense value for armor
        healing: Healing value for potions
        quantity: How many to add

    Returns:
        Confirmation with updated inventory count
    """
    session_id = resolve_session_id(session_id)
    state = _get_state(session_id)
    item = Item(
        name=name,
        item_type=ItemType(item_type),
        description=description,
        damage=damage,
        defense=defense,
        healing=healing,
        quantity=quantity,
    )

    # Stack existing items
    for existing in state.player.inventory:
        if existing.name == name:
            existing.quantity += quantity
            state.events_log.append(f"Added {quantity}x {name} (stacked)")
            _save_state(session_id)
            return json.dumps({"status": "stacked", "name": name, "new_quantity": existing.quantity})

    state.player.inventory.append(item)
    state.events_log.append(f"Added {quantity}x {name} to inventory")
    _save_state(session_id)
    return json.dumps({"status": "added", "name": name, "inventory_count": len(state.player.inventory)})


def remove_item(name: str, session_id: str, quantity: int = 1) -> str:
    """Remove an item from the player's inventory.

    Args:
        name: Item name to remove
        session_id: Current game session ID
        quantity: How many to remove

    Returns:
        Confirmation or error if item not found
    """
    session_id = resolve_session_id(session_id)
    state = _get_state(session_id)
    for i, item in enumerate(state.player.inventory):
        if item.name.lower() == name.lower():
            if item.quantity <= quantity:
                state.player.inventory.pop(i)
                state.events_log.append(f"Removed all {name} from inventory")
                _save_state(session_id)
                return json.dumps({"status": "removed", "name": name})
            else:
                item.quantity -= quantity
                state.events_log.append(f"Removed {quantity}x {name}")
                _save_state(session_id)
                return json.dumps({"status": "reduced", "name": name, "remaining": item.quantity})

    return json.dumps({"error": f"Item '{name}' not found in inventory"})


def modify_gold(amount: int, session_id: str, reason: str = "") -> str:
    """Add or subtract gold from the player.

    Args:
        amount: Gold to add (positive) or remove (negative)
        session_id: Current game session ID
        reason: Why the gold is being modified

    Returns:
        New gold total
    """
    session_id = resolve_session_id(session_id)
    state = _get_state(session_id)
    state.player.gold = max(0, state.player.gold + amount)
    state.events_log.append(f"Gold {'gained' if amount > 0 else 'spent'}: {abs(amount)} ({reason})")
    _save_state(session_id)
    return json.dumps({"gold": state.player.gold, "change": amount, "reason": reason})


# --- Movement ---

def get_location_info(session_id: str) -> str:
    """Get information about the player's current location.

    Args:
        session_id: Current game session ID

    Returns:
        JSON with location details, connections, and present NPCs
    """
    session_id = resolve_session_id(session_id)
    state = _get_state(session_id)
    world = _load_world()
    location = world.get("locations", {}).get(state.player.location)
    if not location:
        return json.dumps({"error": f"Unknown location: {state.player.location}"})

    npcs_data = _load_npcs()
    present_npcs = []
    for npc_id, npc in npcs_data.get("npcs", {}).items():
        if npc.get("location") == state.player.location:
            present_npcs.append({"id": npc_id, "name": npc["name"], "role": npc.get("role", "")})

    return json.dumps({
        "location_id": state.player.location,
        "name": location["name"],
        "description": location["description"],
        "atmosphere": location.get("atmosphere", ""),
        "connections": location.get("connections", []),
        "exit_directions": location.get("directions", {}),
        "npcs_present": present_npcs,
        "suggested_music": location.get("music", "village"),
    })


def move_player(destination: str, session_id: str) -> str:
    """Move the player to a connected location.

    Args:
        destination: Location ID to move to
        session_id: Current game session ID

    Returns:
        New location info or error if not connected
    """
    session_id = resolve_session_id(session_id)
    state = _get_state(session_id)
    world = _load_world()
    current = world.get("locations", {}).get(state.player.location)

    if not current:
        return json.dumps({"error": f"Current location invalid: {state.player.location}"})

    connections = current.get("connections", [])
    if destination not in connections:
        available = ", ".join(connections)
        return json.dumps({"error": f"Cannot reach '{destination}' from here. Available: {available}"})

    new_location = world.get("locations", {}).get(destination)
    if not new_location:
        return json.dumps({"error": f"Unknown destination: {destination}"})

    old_location = state.player.location
    state.player.location = destination
    state.player.current_music = new_location.get("music", "village")
    state.turn_count += 1
    state.events_log.append(f"Moved from {old_location} to {destination}")
    _save_state(session_id)

    return json.dumps({
        "status": "moved",
        "from": old_location,
        "to": destination,
        "location_name": new_location["name"],
        "description": new_location["description"],
        "atmosphere": new_location.get("atmosphere", ""),
        "connections": new_location.get("connections", []),
        "exit_directions": new_location.get("directions", {}),
        "suggested_music": new_location.get("music", "village"),
    })


# --- Combat ---

def start_combat(enemies: str, session_id: str) -> str:
    """Start a combat encounter with one or more enemies.

    Args:
        enemies: JSON array of enemies, each with name, hp, attack, defense
        session_id: Current game session ID

    Returns:
        Combat state with initiative order
    """
    session_id = resolve_session_id(session_id)
    state = _get_state(session_id)
    if state.player.combat.active:
        return json.dumps({"error": "Combat already active"})

    try:
        enemy_list = json.loads(enemies)
    except (json.JSONDecodeError, TypeError):
        return json.dumps({"error": "Invalid enemies format — expected JSON array"})
    for enemy in enemy_list:
        enemy.setdefault("max_hp", enemy["hp"])

    # Roll initiative
    player_init = random.randint(1, 20) + state.player.attack // 2
    turn_order = [{"name": state.player.name, "type": "player", "initiative": player_init}]
    for enemy in enemy_list:
        init = random.randint(1, 20) + enemy.get("attack", 3) // 2
        turn_order.append({"name": enemy["name"], "type": "enemy", "initiative": init})

    turn_order.sort(key=lambda x: x["initiative"], reverse=True)

    state.player.combat = CombatState(
        active=True,
        enemies=enemy_list,
        turn_order=[t["name"] for t in turn_order],
        current_turn=0,
        round_number=1,
    )
    state.events_log.append(f"Combat started: {[e['name'] for e in enemy_list]}")
    _save_state(session_id)

    return json.dumps({
        "status": "combat_started",
        "enemies": enemy_list,
        "turn_order": turn_order,
        "current_turn": turn_order[0]["name"],
        "player_hp": state.player.hp,
        "suggested_music": "combat",
    })


def attack(target: str, session_id: str) -> str:
    """Player attacks a target enemy.

    Args:
        target: Name of the enemy to attack
        session_id: Current game session ID

    Returns:
        Attack result with damage dealt and remaining HP
    """
    session_id = resolve_session_id(session_id)
    state = _get_state(session_id)
    if not state.player.combat.active:
        return json.dumps({"error": "No active combat"})

    # Find target
    target_enemy = None
    for enemy in state.player.combat.enemies:
        if enemy["name"].lower() == target.lower():
            target_enemy = enemy
            break

    if not target_enemy:
        names = [e["name"] for e in state.player.combat.enemies if e["hp"] > 0]
        return json.dumps({"error": f"Target '{target}' not found. Available: {names}"})

    if target_enemy["hp"] <= 0:
        return json.dumps({"error": f"{target} is already defeated"})

    # Attack roll
    attack_roll = random.randint(1, 20)
    enemy_defense = target_enemy.get("defense", 3)
    hit = attack_roll + state.player.attack >= enemy_defense + 10

    result = {
        "attack_roll": attack_roll,
        "natural_20": attack_roll == 20,
        "natural_1": attack_roll == 1,
    }

    if attack_roll == 1:
        result["hit"] = False
        result["message"] = "Critical miss!"
        result["damage"] = 0
    elif hit or attack_roll == 20:
        damage = random.randint(1, 8) + state.player.attack // 2
        if attack_roll == 20:
            damage *= 2
            result["message"] = "Critical hit!"
        else:
            result["message"] = "Hit!"
        target_enemy["hp"] = max(0, target_enemy["hp"] - damage)
        result["hit"] = True
        result["damage"] = damage
        result["target_hp"] = target_enemy["hp"]
        result["target_max_hp"] = target_enemy.get("max_hp", target_enemy["hp"])
        result["target_defeated"] = target_enemy["hp"] <= 0
    else:
        result["hit"] = False
        result["message"] = "Miss!"
        result["damage"] = 0

    # Check if all enemies defeated
    all_defeated = all(e["hp"] <= 0 for e in state.player.combat.enemies)
    if all_defeated:
        result["combat_over"] = True
        result["victory"] = True
        state.player.combat.active = False
        xp_gain = sum(e.get("xp", 10) for e in state.player.combat.enemies)
        xp_info = _award_xp(state, xp_gain)
        result["xp_gained"] = xp_gain
        result.update(xp_info)
        result["suggested_music"] = "victory"

    state.events_log.append(f"Attack on {target}: {'Hit' if result.get('hit') else 'Miss'} for {result.get('damage', 0)} damage")
    _save_state(session_id)
    return json.dumps(result)


def enemy_turn(session_id: str) -> str:
    """Process all enemy attacks for this round.

    Args:
        session_id: Current game session ID

    Returns:
        Results of all enemy attacks
    """
    session_id = resolve_session_id(session_id)
    state = _get_state(session_id)
    if not state.player.combat.active:
        return json.dumps({"error": "No active combat"})

    results = []
    for enemy in state.player.combat.enemies:
        if enemy["hp"] <= 0:
            continue

        attack_roll = random.randint(1, 20)
        enemy_atk = enemy.get("attack", 3)
        hit = attack_roll + enemy_atk >= state.player.defense + 10

        if attack_roll == 1:
            results.append({"enemy": enemy["name"], "hit": False, "message": "Critical miss!", "damage": 0})
        elif hit or attack_roll == 20:
            damage = random.randint(1, 6) + enemy_atk // 2
            if attack_roll == 20:
                damage *= 2
            state.player.hp = max(0, state.player.hp - damage)
            results.append({
                "enemy": enemy["name"],
                "hit": True,
                "damage": damage,
                "attack_roll": attack_roll,
                "player_hp": state.player.hp,
            })
        else:
            results.append({"enemy": enemy["name"], "hit": False, "message": "Miss!", "damage": 0})

    player_defeated = state.player.hp <= 0
    if player_defeated:
        state.player.combat.active = False

    state.player.combat.round_number += 1
    state.events_log.append(f"Enemy round: {len(results)} attacks, player HP: {state.player.hp}")
    _save_state(session_id)

    return json.dumps({
        "enemy_attacks": results,
        "player_hp": state.player.hp,
        "player_max_hp": state.player.max_hp,
        "player_defeated": player_defeated,
        "round": state.player.combat.round_number,
    })


def end_combat(session_id: str) -> str:
    """End combat (flee, victory, or defeat).

    Args:
        session_id: Current game session ID

    Returns:
        Final combat summary
    """
    session_id = resolve_session_id(session_id)
    state = _get_state(session_id)
    state.player.combat.active = False
    state.events_log.append("Combat ended")
    _save_state(session_id)
    return json.dumps({
        "status": "combat_ended",
        "player_hp": state.player.hp,
        "player_max_hp": state.player.max_hp,
    })


def heal_player(amount: int, session_id: str, source: str = "potion") -> str:
    """Heal the player.

    Args:
        amount: HP to restore
        session_id: Current game session ID
        source: What caused the healing

    Returns:
        New HP values
    """
    session_id = resolve_session_id(session_id)
    state = _get_state(session_id)
    old_hp = state.player.hp
    state.player.hp = min(state.player.max_hp, state.player.hp + amount)
    healed = state.player.hp - old_hp
    state.events_log.append(f"Healed {healed} HP from {source}")
    _save_state(session_id)
    return json.dumps({"hp": state.player.hp, "max_hp": state.player.max_hp, "healed": healed})


# --- Quests ---

def update_quest(quest_id: str, action: str, session_id: str,
                 objective: str | None = None) -> str:
    """Update a quest's status or complete an objective.

    Args:
        quest_id: Quest identifier
        action: One of: start, complete_objective, complete, fail
        session_id: Current game session ID
        objective: Specific objective text to mark complete

    Returns:
        Updated quest state
    """
    session_id = resolve_session_id(session_id)
    state = _get_state(session_id)
    quests_data = _load_quests()

    # Find or create quest
    quest = None
    for q in state.player.quests:
        if q.quest_id == quest_id:
            quest = q
            break

    if action == "start":
        if quest:
            return json.dumps({"error": f"Quest '{quest_id}' already active"})
        template = quests_data.get("quests", {}).get(quest_id)
        if not template:
            return json.dumps({"error": f"Unknown quest: {quest_id}"})
        quest = Quest(
            quest_id=quest_id,
            name=template["name"],
            description=template["description"],
            status=QuestStatus.ACTIVE,
            objectives=template.get("objectives", []),
            reward_xp=template.get("reward_xp", 50),
            reward_items=template.get("reward_items", []),
        )
        state.player.quests.append(quest)
        state.events_log.append(f"Quest started: {quest.name}")
        _save_state(session_id)
        active_quests = [q.model_dump() for q in state.player.quests if q.status == QuestStatus.ACTIVE]
        return json.dumps({"status": "started", "quest": quest.model_dump(), "quests": active_quests})

    if not quest:
        return json.dumps({"error": f"Quest '{quest_id}' not found in player's quests"})

    if action == "complete_objective" and objective:
        if objective not in quest.completed_objectives:
            quest.completed_objectives.append(objective)
        state.events_log.append(f"Quest objective completed: {objective}")
        _save_state(session_id)
        return json.dumps({"status": "objective_completed", "quest": quest.model_dump()})

    if action == "complete":
        quest.status = QuestStatus.COMPLETED
        xp_info = _award_xp(state, quest.reward_xp)
        state.events_log.append(f"Quest completed: {quest.name} (+{quest.reward_xp} XP)")
        _save_state(session_id)
        active_quests = [q.model_dump() for q in state.player.quests if q.status == QuestStatus.ACTIVE]
        result = {
            "status": "completed",
            "quest": quest.model_dump(),
            "xp_gained": quest.reward_xp,
            "quests": active_quests,
        }
        result.update(xp_info)
        return json.dumps(result)

    if action == "fail":
        quest.status = QuestStatus.FAILED
        state.events_log.append(f"Quest failed: {quest.name}")
        _save_state(session_id)
        return json.dumps({"status": "failed", "quest": quest.model_dump()})

    return json.dumps({"error": f"Unknown action: {action}"})


# --- NPC Relationships ---

def get_npc_relationship(npc_id: str, session_id: str) -> str:
    """Get the player's relationship with an NPC.

    Args:
        npc_id: NPC identifier
        session_id: Current game session ID

    Returns:
        Relationship status and NPC info
    """
    session_id = resolve_session_id(session_id)
    state = _get_state(session_id)
    npcs_data = _load_npcs()
    npc_info = npcs_data.get("npcs", {}).get(npc_id)
    if not npc_info:
        return json.dumps({"error": f"Unknown NPC: {npc_id}"})

    # Find or create relationship
    rel = None
    for r in state.player.npc_relationships:
        if r.npc_id == npc_id:
            rel = r
            break

    if not rel:
        rel = NPCRelationship(npc_id=npc_id)
        state.player.npc_relationships.append(rel)

    return json.dumps({
        "npc_id": npc_id,
        "name": npc_info["name"],
        "role": npc_info.get("role", ""),
        "disposition": rel.disposition,
        "met": rel.met,
        "notes": rel.notes,
    })


def modify_npc_relationship(npc_id: str, disposition_change: int,
                            session_id: str, reason: str = "") -> str:
    """Modify the player's relationship with an NPC.

    Args:
        npc_id: NPC identifier
        disposition_change: Amount to change disposition (positive=friendlier, negative=hostile)
        session_id: Current game session ID
        reason: Why the relationship changed

    Returns:
        Updated relationship
    """
    session_id = resolve_session_id(session_id)
    state = _get_state(session_id)

    rel = None
    for r in state.player.npc_relationships:
        if r.npc_id == npc_id:
            rel = r
            break

    if not rel:
        rel = NPCRelationship(npc_id=npc_id)
        state.player.npc_relationships.append(rel)

    rel.met = True
    rel.disposition = max(0, min(100, rel.disposition + disposition_change))
    if reason:
        rel.notes.append(reason)

    state.events_log.append(f"NPC {npc_id} disposition: {rel.disposition} ({reason})")
    _save_state(session_id)
    return json.dumps({
        "npc_id": npc_id,
        "disposition": rel.disposition,
        "met": rel.met,
        "change": disposition_change,
        "reason": reason,
    })


# --- Gesture Battles ---

# Theater event queue for gesture results (polled by frontend via WS events)
_theater_events: dict[str, list[dict]] = {}


def get_theater_events(session_id: str) -> list[dict]:
    """Pop pending theater events for a session."""
    return _theater_events.pop(session_id, [])


def resolve_gesture_battle(
    battle_type: str,
    player_gesture: str,
    session_id: str,
    context: str = "",
) -> str:
    """Resolve a physical gesture battle between the player and the DM.

    The player shows a gesture via camera (recognized by Gemini vision).
    Call this tool with what you see in the player's gesture to resolve the battle.
    Use 1-2 times per combat encounter to add physical interactivity.

    Args:
        battle_type: One of: rps (rock-paper-scissors), odd_even (finger count),
                     thumbs (up or down), gesture_check (free-form DM judgment)
        player_gesture: What the player showed (e.g. "rock", "3 fingers", "thumbs up",
                        or free-form description for gesture_check)
        session_id: Current game session ID
        context: Narrative context (e.g. "combat bonus attack", "persuasion check")

    Returns:
        JSON with battle result, winner, and any combat effects
    """
    session_id = resolve_session_id(session_id)
    state = _get_state(session_id)
    player_gesture = player_gesture.lower().strip()

    result = {
        "battle_type": battle_type,
        "player_gesture": player_gesture,
        "context": context,
    }

    if battle_type == "rps":
        choices = ["rock", "paper", "scissors"]
        dm_choice = random.choice(choices)
        result["dm_gesture"] = dm_choice

        # Normalize player gesture
        pg = player_gesture
        for c in choices:
            if c in pg:
                pg = c
                break

        if pg == dm_choice:
            result["outcome"] = "draw"
            result["message"] = "A draw! The fates are undecided."
            result["combat_bonus"] = 0
        elif (pg == "rock" and dm_choice == "scissors") or \
             (pg == "paper" and dm_choice == "rock") or \
             (pg == "scissors" and dm_choice == "paper"):
            result["outcome"] = "player_wins"
            result["message"] = "Victory! The gesture favors you."
            result["combat_bonus"] = random.randint(2, 5)
        else:
            result["outcome"] = "dm_wins"
            result["message"] = "The darkness prevails! A penalty befalls you."
            result["combat_bonus"] = -random.randint(1, 3)

    elif battle_type == "odd_even":
        # Count fingers — odd = player wins
        digits = [c for c in player_gesture if c.isdigit()]
        finger_count = int(digits[0]) if digits else len(player_gesture.split())
        is_odd = finger_count % 2 == 1
        result["finger_count"] = finger_count
        result["is_odd"] = is_odd

        if is_odd:
            result["outcome"] = "player_wins"
            result["message"] = f"{finger_count} fingers — odd! Fortune smiles on you."
            result["combat_bonus"] = random.randint(1, 4)
        else:
            result["outcome"] = "dm_wins"
            result["message"] = f"{finger_count} fingers — even! The shadows grow bolder."
            result["combat_bonus"] = -random.randint(1, 3)

    elif battle_type == "thumbs":
        is_up = "up" in player_gesture or "thumbs up" in player_gesture
        result["thumbs_up"] = is_up

        if is_up:
            result["outcome"] = "player_wins"
            result["message"] = "Thumbs up! Courage bolsters your spirit."
            result["combat_bonus"] = random.randint(2, 4)
        else:
            result["outcome"] = "dm_wins"
            result["message"] = "Thumbs down! Dread takes hold."
            result["combat_bonus"] = -random.randint(1, 3)

    elif battle_type == "gesture_check":
        # Free-form — DM decides based on context, 60/40 player favor
        player_wins = random.random() < 0.6
        result["outcome"] = "player_wins" if player_wins else "dm_wins"
        result["message"] = "The gesture is accepted!" if player_wins else "The gesture fails to convince."
        result["combat_bonus"] = random.randint(1, 3) if player_wins else -random.randint(1, 2)

    else:
        return json.dumps({"error": f"Unknown battle_type: {battle_type}"})

    # Apply combat bonus if in combat
    bonus = result.get("combat_bonus", 0)
    if state.player.combat.active and bonus != 0:
        if bonus > 0:
            result["effect"] = f"+{bonus} bonus damage on next attack"
        else:
            result["effect"] = f"{bonus} HP penalty"
            state.player.hp = max(1, state.player.hp + bonus)
            result["player_hp"] = state.player.hp

    state.events_log.append(
        f"Gesture battle ({battle_type}): {player_gesture} → {result['outcome']} "
        f"(bonus: {bonus}, context: {context})"
    )
    _save_state(session_id)

    # Push theater event for frontend animation
    _theater_events.setdefault(session_id, []).append({
        "type": "gesture_battle_result",
        "data": result,
    })

    return json.dumps(result)
