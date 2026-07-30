# Config differences from stock

Every line below differs from the shipped `.conf.dist`.
Passwords and connection strings are replaced with `<REDACTED>`.

> These are reproduced automatically by `setup\apply-settings.ps1`.
> This file is documentation - `setup\server-settings.conf` is the machine-readable source.

Generated 2026-07-30 23:06

## worldserver.conf

| Setting | Stock | This server |
|---|---|---|
| `LoginDatabaseInfo` | `"<REDACTED CONNECTION STRING>"` | `"<REDACTED CONNECTION STRING>"` |
| `WorldDatabaseInfo` | `"<REDACTED CONNECTION STRING>"` | `"<REDACTED CONNECTION STRING>"` |
| `CharacterDatabaseInfo` | `"<REDACTED CONNECTION STRING>"` | `"<REDACTED CONNECTION STRING>"` |
| `DataDir` | `"."` | `"C:/Users/DomiJesusa/Desktop/wow/server/Data"` |
| `LogsDir` | `""` | `"C:/Users/DomiJesusa/Desktop/wow/server/logs"` |
| `SourceDirectory` | `""` | `"C:/Users/DomiJesusa/Desktop/wow/source"` |
| `ProcessPriority` | `1` | `0` |
| `Logger.spells.scripts` | `2,Console Errors` | `5,Console Server Errors` |
| `Logger.entities.vehicle` | `(not in .dist)` | `5,Console Server` |
| `Logger.vehicles` | `(not in .dist)` | `5,Console Server` |
| `MapUpdate.Threads` | `1` | `2` |
| `Rate.XP.Kill` | `1` | `3` |
| `Rate.XP.Quest` | `1` | `7` |
| `Rate.Drop.Money` | `1` | `2` |
| `DungeonFinder.OptionsMask` | `5` | `7` |

15 settings changed.

## authserver.conf

| Setting | Stock | This server |
|---|---|---|
| `LogsDir` | `""` | `"C:/Users/DomiJesusa/Desktop/wow/server/logs"` |
| `LoginDatabaseInfo` | `"<REDACTED CONNECTION STRING>"` | `"<REDACTED CONNECTION STRING>"` |

2 settings changed.

## modules/playerbots.conf

| Setting | Stock | This server |
|---|---|---|
| `AiPlayerbot.MinRandomBots` | `500` | `40` |
| `AiPlayerbot.MaxRandomBots` | `500` | `40` |
| `AiPlayerbot.AddClassAccountPoolSize` | `50` | `5` |
| `AiPlayerbot.LfgEnterDelayMin` | `(not in .dist)` | `25000` |
| `AiPlayerbot.LfgEnterDelayMax` | `(not in .dist)` | `50000` |
| `AiPlayerbot.RandomBotRandomPassword` | `0` | `1` |
| `AiPlayerbot.RandomBotMinLevel` | `1` | `80` |
| `AiPlayerbot.TradeActionExcludedPrefixes` | `"RPLL_H_,DBMv4,{звезда} Questie,{rt1} Questie"` | `"RPLL_H_,DBMv4,{Ð·Ð²ÐµÐ·Ð´Ð°} Questie,{rt1} Questie"` |
| `AiPlayerbot.BotActiveAlone` | `10` | `50` |
| `AiPlayerbot.RandomBotCombatStrategies` | `""` | `"+pull,+attack tagged,-dps assist"` |
| `AiPlayerbot.CombatStrategies` | `""` | `"+pull,+attack tagged,-dps assist"` |
| `PlayerbotsDatabaseInfo` | `"<REDACTED CONNECTION STRING>"` | `"<REDACTED CONNECTION STRING>"` |
| `AiPlayerbot.RandomChangeMultiplier` | `1` | `3` |
| `AiPlayerbot.RandomBotTalk` | `1` | `0` |
| `AiPlayerbot.RandomBotSuggestDungeons` | `1` | `0` |

15 settings changed.

## acore_auth.realmlist

```
id	name	address	localAddress	port
1	AzerothCore	<REDACTED IP>	<REDACTED IP>	8085
```

> The real addresses are redacted on purpose: this repo is public and the server
> runs on a home connection. The values are in `setup\CREDENTIALS.txt`.
>
> `address` and `localAddress` point at the OLD machine and MUST be updated
> after the move, or clients pass authentication and then hang.
