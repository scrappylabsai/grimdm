"""Background music selection tool.

Music is pre-generated MP3 loops served from /static/music/.
The tool tells the frontend which track to crossfade to.
"""

import json

# Available music tracks (pre-generated, stored in static/music/)
MUSIC_TRACKS = {
    "village": {"file": "village.mp3", "description": "Warm folk melody, gentle and welcoming"},
    "tavern": {"file": "tavern.mp3", "description": "Lively tavern music with lute and fiddle"},
    "forest": {"file": "forest.mp3", "description": "Mysterious woodland ambience with soft strings"},
    "dungeon": {"file": "dungeon.mp3", "description": "Dark, echoing tones with dripping water"},
    "combat": {"file": "combat.mp3", "description": "Intense drums and urgent strings"},
    "boss": {"file": "boss.mp3", "description": "Epic orchestral battle theme"},
    "mystery": {"file": "mystery.mp3", "description": "Eerie, unsettling tones with whispers"},
    "victory": {"file": "victory.mp3", "description": "Triumphant fanfare"},
}


def set_background_music(mood: str, session_id: str) -> str:
    """Change the background music to match the current scene mood.

    Call this when the atmosphere changes: entering a new area, starting combat,
    discovering something mysterious, or celebrating victory.

    Args:
        mood: One of: village, tavern, forest, dungeon, combat, boss, mystery, victory
        session_id: Current game session ID

    Returns:
        JSON with track info for the frontend to play
    """
    track = MUSIC_TRACKS.get(mood)
    if not track:
        available = ", ".join(MUSIC_TRACKS.keys())
        return json.dumps({"error": f"Unknown mood '{mood}'. Available: {available}"})

    return json.dumps({
        "status": "ok",
        "mood": mood,
        "track": track["file"],
        "track_url": f"/static/music/{track['file']}",
        "description": track["description"],
    })


SOUND_EFFECTS = {
    "dice_roll": "Dice clattering on table",
    "sword_clash": "Steel on steel combat strike",
    "door_creak": "Old wooden door creaking open",
    "coin_drop": "Gold coins clinking on stone",
    "treasure_open": "Treasure chest opening with shimmer",
    "magic_cast": "Arcane spell energy release",
    "heal_potion": "Potion drinking with healing chime",
    "level_up": "Triumphant level-up fanfare",
    "thunder": "Lightning crack and rolling thunder",
    "arrow_shot": "Bow twang and arrow whoosh",
    "monster_growl": "Deep beast roar and snarl",
    "footsteps_stone": "Boots echoing on stone corridor",
    "campfire": "Warm crackling fire",
    "death_knell": "Ominous deep bell toll",
    "quest_accepted": "Scroll unfurl with quest chime",
    "shield_block": "Shield deflecting heavy blow",
}


def play_sound_effect(effect: str, session_id: str) -> str:
    """Play a one-shot sound effect to enhance immersion.

    Call this during key moments: combat hits, opening doors/chests, casting spells,
    picking up gold, rolling dice, encountering monsters, weather events, etc.

    Args:
        effect: One of: dice_roll, sword_clash, door_creak, coin_drop, treasure_open,
                magic_cast, heal_potion, level_up, thunder, arrow_shot, monster_growl,
                footsteps_stone, campfire, death_knell, quest_accepted, shield_block
        session_id: Current game session ID

    Returns:
        JSON with effect info for the frontend to play
    """
    if effect not in SOUND_EFFECTS:
        available = ", ".join(SOUND_EFFECTS.keys())
        return json.dumps({"error": f"Unknown effect '{effect}'. Available: {available}"})

    return json.dumps({
        "status": "ok",
        "effect": effect,
        "effect_url": f"/static/music/sfx/{effect}.mp3",
        "description": SOUND_EFFECTS[effect],
    })
