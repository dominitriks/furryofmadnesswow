# Capture every config setting we have tuned into a portable, secret-free file.
#
# WHY THIS EXISTS
#   The live .conf files are gitignored - they carry the MySQL password in five
#   connection strings. That meant ~30 hard-won settings existed on exactly one
#   machine. Moving to a new box would silently reset all of them to stock, and
#   nothing would error: the server boots fine on defaults, it just behaves
#   differently (1x XP, 500 bots, LFG delay gone, tank passive again).
#
#   This writes setup\server-settings.conf, which IS tracked by git.
#   apply-settings.ps1 replays it onto a fresh install on any machine.
#
# RUN THIS AFTER ANY CONFIG CHANGE, so the record never drifts from reality.

$ErrorActionPreference = 'Stop'
$BASE = Split-Path $PSScriptRoot -Parent
$cfg  = Join-Path $BASE 'server\configs'
$out  = Join-Path $PSScriptRoot 'server-settings.conf'

$dbPass = $null
$dbPassFile = Join-Path $PSScriptRoot 'db-password.txt'
if (Test-Path $dbPassFile) { $dbPass = (Get-Content $dbPassFile -Raw).Trim() }
if ([string]::IsNullOrWhiteSpace($dbPass)) {
    Write-Warning "db-password.txt is empty - connection strings will be exported REDACTED, not as {{DB_PASS}}."
    $dbPass = $null
}

# Why each setting is what it is. Carried into the generated file so the new
# machine inherits the reasoning, not just the number.
$WHY = @{
  'DataDir'                                = 'absolute path to extracted client data (dbc/maps/vmaps/mmaps)'
  'LogsDir'                                = 'a NON-EXISTENT LogsDir silently disables file logging entirely'
  'SourceDirectory'                        = 'NOT cosmetic - playerbots module SQL is resolved through it on every boot'
  'ProcessPriority'                        = 'BOOL. dist ships 1 (high), which starves MySQL on the same box'
  'MapUpdate.Threads'                      = 'benchmarked on 12 threads; raise only with evidence'
  'Rate.XP.Kill'                           = 'progression rate'
  'Rate.XP.Quest'                          = 'progression rate'
  'Rate.Drop.Money'                        = 'progression rate'
  'DungeonFinder.OptionsMask'              = '7 = RDF enabled for both random and specific dungeons'
  'Logger.spells.scripts'                  = 'raised while debugging ICC gunship spell visibility'
  'Logger.entities.vehicle'                = 'raised while debugging ICC gunship spell visibility'
  'Logger.vehicles'                        = 'raised while debugging ICC gunship spell visibility'
  'AiPlayerbot.MinRandomBots'              = 'sized for 16 GB / 12 threads. Accounts = ceil(max/10) + PoolSize'
  'AiPlayerbot.MaxRandomBots'              = 'keep equal to Min unless you want churn'
  'AiPlayerbot.AddClassAccountPoolSize'    = 'adds directly to the account count - dist 50 is why stock boot appears to hang'
  'AiPlayerbot.RandomBotRandomPassword'    = 'CRITICAL: with 0 every bot password EQUALS its account name. Consulted only at creation - set before any bot exists'
  'AiPlayerbot.RandomBotMinLevel'          = 'bots spawn at 80 so they can fill level-80 raids and RDF'
  'AiPlayerbot.BotActiveAlone'             = 'percent of bots active with no real player nearby - raised so the world feels alive'
  'AiPlayerbot.RandomChangeMultiplier'     = 'how often bots re-roll activity; raised so they move around instead of idling'
  'AiPlayerbot.RandomBotTalk'              = '0 = stop bots whispering real players'
  'AiPlayerbot.RandomBotSuggestDungeons'   = '0 = stop dungeon-suggestion whispers'
  'AiPlayerbot.RandomBotCombatStrategies'  = '+pull makes the TANK open combat instead of waiting for a command; -dps assist lets bots pick their own targets'
  'AiPlayerbot.CombatStrategies'           = 'same, for non-random bots'
  'AiPlayerbot.LfgEnterDelayMin'           = 'ADDED BY PATCH 001 - not a stock option. Bots wait before acting on dungeon entry'
  'AiPlayerbot.LfgEnterDelayMax'           = 'ADDED BY PATCH 001 - not a stock option'
}

# A value that round-trips back to the dist value through a Latin-1 -> UTF-8
# reversal was never a deliberate edit: it is the same text, corrupted by an
# encoding slip. Exporting it would carry the corruption to the new machine.
function Undo-Mojibake([string]$s) {
    if ($null -eq $s) { return $null }
    $bytes = New-Object byte[] $s.Length
    for ($i = 0; $i -lt $s.Length; $i++) {
        $c = [int]$s[$i]
        if ($c -gt 255) { return $null }
        $bytes[$i] = [byte]$c
    }
    $strict = New-Object System.Text.UTF8Encoding($false, $true)
    try { return $strict.GetString($bytes) } catch { return $null }
}

function Read-Conf([string]$path) {
    $map = [ordered]@{}
    if (-not (Test-Path $path)) { return $null }
    foreach ($line in [System.IO.File]::ReadAllLines($path)) {
        if ($line -match '^\s*([A-Za-z0-9_.]+)\s*=\s*(.*?)\s*$') {
            if (-not $map.Contains($Matches[1])) { $map[$Matches[1]] = $Matches[2] }
        }
    }
    return $map
}

# Turn machine-specific text back into placeholders.
function Portable([string]$v) {
    $fwd = $BASE -replace '\\', '/'
    $v = $v -replace [regex]::Escape($fwd), '{{BASE}}'
    $v = $v -replace [regex]::Escape($BASE), '{{BASE}}'
    if ($dbPass) { $v = $v -replace [regex]::Escape($dbPass), '{{DB_PASS}}' }
    else         { $v = $v -replace ';[^;]*;acore_', ';REDACTED;acore_' }
    return $v
}

$files = @(
    @{ label = 'worldserver.conf'; live = "$cfg\worldserver.conf" },
    @{ label = 'authserver.conf';  live = "$cfg\authserver.conf" }
)

# Module configs are DISCOVERED, not listed. Adding a module used to mean
# remembering to edit this script too, and forgetting meant its settings simply
# never reached git - the module then ran on stock defaults on the other machine
# while looking correctly configured here.
foreach ($mc in (Get-ChildItem (Join-Path $cfg 'modules') -Filter '*.conf' -File -ErrorAction SilentlyContinue | Sort-Object Name)) {
    $files += @{ label = "modules/$($mc.Name)"; live = $mc.FullName }
}

$sb = New-Object System.Text.StringBuilder
function Emit($t) { [void]$sb.AppendLine($t) }

Emit "# AzerothCore server settings - portable record"
Emit "# Generated by setup\export-settings.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
Emit "#"
Emit "# Every line below is a setting that DIFFERS from the shipped .conf.dist."
Emit "# Apply to a fresh install with:   setup\apply-settings.ps1 -FromDist"
Emit "#"
Emit "# Placeholders substituted at apply time:"
Emit "#   {{BASE}}     -> the wow\ folder, derived from this script's own location"
Emit "#   {{DB_PASS}}  -> read from setup\db-password.txt"
Emit "#"
Emit "# NO SECRETS IN THIS FILE. It is committed to a public repo."

$total = 0
$skipped = @()
$emitted = @()

# Sections whose .conf does not exist on THIS machine are carried over verbatim.
# Without this, running export on the non-hosting machine - which has no reason
# to have every module installed - would silently delete that module's settings
# from git, and the host would quietly revert it to stock on the next apply.
$carried = [ordered]@{}
if (Test-Path $out) {
    $cur = $null
    foreach ($line in [System.IO.File]::ReadAllLines($out)) {
        if ($line.Trim() -match '^\[(.+)\]$') { $cur = $Matches[1]; $carried[$cur] = @(); continue }
        if ($cur) { $carried[$cur] += $line }
    }
}

foreach ($f in $files) {
    $dist = "$($f.live).dist"
    $liveMap = Read-Conf $f.live
    $distMap = Read-Conf $dist
    if ($null -eq $liveMap) { Write-Warning "missing live conf: $($f.live)"; continue }
    if ($null -eq $distMap) { Write-Warning "missing dist: $dist"; continue }

    $rows = @()
    foreach ($k in $liveMap.Keys) {
        $lv = $liveMap[$k]
        $isNew = -not $distMap.Contains($k)
        if (-not $isNew -and $distMap[$k] -eq $lv) { continue }

        if (-not $isNew) {
            $fixed = Undo-Mojibake $lv
            if ($fixed -and $fixed -eq $distMap[$k]) {
                $skipped += "$($f.label): $k  (encoding corruption, not a real change)"
                continue
            }
        }
        $rows += @{ key = $k; val = (Portable $lv); new = $isNew }
    }

    if ($rows.Count -eq 0) { continue }
    Emit ""
    Emit "[$($f.label)]"
    $emitted += $f.label
    foreach ($r in $rows) {
        # NB: PowerShell variable names are case-insensitive, so this local must
        # NOT be called $why - that would overwrite the $WHY table itself.
        $note = $WHY[$r.key]
        if ($r.new) {
            if ($note) { Emit "# $note" }
            Emit "# NOT A STOCK OPTION - requires the source patch to be applied first."
        } elseif ($note) {
            Emit "# $note"
        }
        Emit ("{0} = {1}" -f $r.key, $r.val)
        $total++
    }
}

$preserved = @()
foreach ($label in $carried.Keys) {
    if ($emitted -contains $label) { continue }
    $preserved += $label
    Emit ""
    Emit "[$label]"
    foreach ($l in $carried[$label]) { Emit $l }
}

[System.IO.File]::WriteAllText($out, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))

Write-Output "wrote $out"
Write-Output "  $total settings captured"
if ($preserved.Count -gt 0) {
    Write-Output "  $($preserved.Count) section(s) carried over unchanged (no .conf on this machine):"
    $preserved | ForEach-Object { Write-Output "    - $_" }
}
if ($skipped.Count -gt 0) {
    Write-Output "  $($skipped.Count) skipped:"
    $skipped | ForEach-Object { Write-Output "    - $_" }
}
if ($dbPass) {
    $leak = Select-String -Path $out -Pattern ([regex]::Escape($dbPass)) -SimpleMatch
    if ($leak) { Write-Error "ABORT: the DB password leaked into $out" }
    else       { Write-Output "  verified: DB password does not appear in the output" }
}
