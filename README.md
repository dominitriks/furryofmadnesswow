# Furry of Madness — WoW 3.3.5a server tooling

Admin tooling and setup automation for an **AzerothCore** WotLK server
(patch 3.3.5a, build 12340) running the **Playerbots** fork.

The game server itself is **not** in this repo — it stays on real hardware.
What lives here is everything around it: setup scripts, the admin panel, the
HUD, and the patches applied to the bot module.

---

## What is in here

| Path | What it is |
|---|---|
| `panel/server.js` | Node admin panel + HUD (localhost:8080) |
| `panel/hud-launcher/HudGui.cs` | Native Windows GUI for the HUD (WinForms, C#) |
| `setup/*.ps1` | Setup automation — DB, firewall, hosts, configs, verification |
| `setup/01-create-databases.sql` | Creates the four databases and the `acore` user |
| `setup/patches/` | Local patches to `mod-playerbots`, with re-apply instructions |
| `START-SERVER.ps1` | Brings up MySQL → worldserver → authserver → panel, in order |

## What is deliberately NOT in here

- **Passwords.** `setup/CREDENTIALS.txt` and the `*-password.txt` files are
  gitignored. The server is internet-facing; a leaked credential is a live
  compromise, and git history is forever.
- **`source/`** — a clone of [mod-playerbots](https://github.com/mod-playerbots/azerothcore-wotlk),
  someone else's project. Only our patches to it are tracked, in `setup/patches/`.
- **`build/` (7 GB), `server/` (3 GB client data), `mysql/` (the live database).**
- **Live `.conf` files** — they carry the DB password in their connection strings.

---

## Architecture

The game server cannot run on serverless platforms: it is a stateful process
holding ~4 GB of world data in memory and listening on **raw TCP 3724/8085**.
Neither Vercel nor Supabase can host that. So the split is:

```
   ┌─────────── cloud ────────────┐        ┌──── home machine ─────┐
   │  Vercel   — website          │        │  worldserver  :8085   │
   │  Supabase — site database    │◀───────│  authserver   :3724   │
   │  Cloudflare — DNS + CDN      │ push   │  MySQL 8.4 (4 DBs)    │
   └──────────────────────────────┘  only  │  panel/HUD   :8080    │
                                            └───────────────────────┘
```

The home machine talks **outbound only** to the cloud. Nothing dials in, so no
extra ports are opened, and a changing home IP does not matter.

Players connect straight to the game ports — those cannot be proxied through
Cloudflare, whose CDN only handles HTTP/HTTPS (raw TCP needs Enterprise
Spectrum).

---

## Stack, and why each version is pinned

| Component | Version | Why this one |
|---|---|---|
| Core | mod-playerbots fork, `Playerbot` branch | playerbots needs core engine changes; upstream AzerothCore will not build with it |
| Compiler | **VS 2022 (v143)** | AzerothCore targets 2022; VS 2026 (v145) is untested |
| CMake | **3.31.x** | CMake 4.x breaks the build (azerothcore-wotlk#26544) |
| Boost | **1.83.0** msvc-14.3 | mod-playerbots pins 1.78–1.83; 1.87+ is known-broken |
| OpenSSL | **3.6.2** | core needs 3.x; must match the build's own DLLs |
| MySQL | 8.4.9 | AzerothCore is **MySQL-only** — zero PostgreSQL support in the source |

### Build flags that matter

```
-DCMAKE_CXX_FLAGS="/DWIN32 /D_WINDOWS /EHsc /FS /MP4"
```

- Setting `CMAKE_CXX_FLAGS` **replaces** CMake's defaults, so `/EHsc` must be
  restated — without it Boost never emits `throw_exception` and every binary
  fails to link.
- `/FS` is required: the bare `/MP` the project adds spawns many compilers that
  otherwise fight over one `.pdb` (`C1041`).

### Runtime files the install target does NOT copy

Four DLLs must sit next to `worldserver.exe`, or it dies before printing a line:

```
libmysql.dll          from MySQL   lib/
libcrypto-3-x64.dll   from OpenSSL bin/
libssl-3-x64.dll      from OpenSSL bin/
legacy.dll            from OpenSSL lib/ossl-modules/   ← a hard ASSERT
```

---

## Running it

```powershell
powershell -ExecutionPolicy Bypass -File START-SERVER.ps1
```

Then `AzerothCore-HUD.exe` for the native status window, or
<http://localhost:8080> for the full panel (accounts, GM commands, rates).

> The panel binds to **127.0.0.1 only**. It can create GM-level accounts, and
> this machine has game ports forwarded from the internet.

---

## Patches

`setup/patches/` holds local changes to `mod-playerbots`. They must be
re-applied after every module update — see `setup/patches/README.txt`.

- **`001-lfg-accept-in-combat.patch`** — upstream makes a bot decline an LFG
  proposal while it is in combat. Random bots grind constantly, so a tank was
  usually mid-fight when the proposal arrived, and LFG drops decliners from the
  queue — groups kept failing to form. The patch declines only when dead, and
  otherwise makes the bot drop what it is doing and commit. It also adds
  `AiPlayerbot.LfgEnterDelayMin/Max` so bots hold at the dungeon entrance for a
  configurable 25–50 s, giving real players time to finish what they were doing.

## License

AzerothCore is GPLv2 and is **not** redistributed here. The scripts and panel in
this repo are provided as-is for running that server.
