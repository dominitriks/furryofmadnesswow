Local patches to mod-playerbots
===============================
These are LOCAL changes to a third-party module. `git pull` in
source\modules\mod-playerbots will either overwrite them or refuse to merge,
so they must be re-applied after every module update.

Base commit when the patches were written: mod-playerbots 3fa1c1e4


001-lfg-accept-in-combat.patch
------------------------------
File: src/Ai/Base/Actions/LfgActions.cpp  (LfgAcceptAction::Execute, both branches)

Problem it fixes:
  Upstream declines an LFG proposal when the bot is in combat OR dead:

      if (bot->IsInCombat() || bot->isDead())
          *packet << id << false;      // decline

  Random bots grind constantly, so a tank was very often mid-fight when the
  proposal arrived. Worse, LFG removes a decliner from the queue, so every
  refusal shrank the pool of available tanks and groups kept failing to form.
  This is why "the tank refuses RDF" happened repeatedly.

What the patch does:
  - Declines only when the bot is DEAD.
  - Otherwise the bot drops what it is doing and commits to the dungeon:
        bot->CombatStop(true);
        bot->AttackStop();
        bot->InterruptNonMeleeSpells(true);

  This matches real players, who can accept a proposal mid-fight; entering the
  dungeon ends combat anyway.

Why it is needed:
  Without it there is a hard conflict - bots that quest and kill mobs (wanted)
  are exactly the bots that decline RDF (not wanted). No config option controls
  this; the check is hardcoded.


How to re-apply after updating mod-playerbots
---------------------------------------------
    cd C:\Users\DomiJesusa\Desktop\wow\source\modules\mod-playerbots
    git apply ..\..\..\setup\patches\001-lfg-accept-in-combat.patch

If it fails to apply (upstream changed that function), open
LfgActions.cpp, find LfgAcceptAction::Execute, and make the same two edits by
hand - there are two identical blocks, one per branch.

A pristine copy of the original file is kept as LfgActions.cpp.orig.

After applying, rebuild:
    cd C:\Users\DomiJesusa\Desktop\wow\build
    cmake --build . --config RelWithDebInfo --parallel 1
    cmake --build . --config RelWithDebInfo --target install
