# Phase 5 - copy .conf.dist -> .conf and apply the verified edits.
# Safe to re-run: it always re-copies from .dist then re-applies, so it is idempotent.
$ErrorActionPreference = 'Stop'
$srv  = 'C:\Users\DomiJesusa\Desktop\wow\server'
$cfg  = Join-Path $srv 'configs'
$log  = 'C:\Users\DomiJesusa\Desktop\wow\setup\04-configure-server.log'
function W($m) { $l = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m; Write-Output $l; Add-Content -Path $log -Value $l -Encoding utf8 }

Set-Content -Path $log -Value "=== Phase 5 configure ===" -Encoding utf8

if (-not (Test-Path $cfg)) { W "FATAL: $cfg does not exist - did the install target run?"; exit 1 }

# --- copy .dist -> live conf -------------------------------------------------
$pairs = @(
  @{ d = "$cfg\worldserver.conf.dist";         c = "$cfg\worldserver.conf" },
  @{ d = "$cfg\authserver.conf.dist";          c = "$cfg\authserver.conf" },
  @{ d = "$cfg\modules\playerbots.conf.dist";  c = "$cfg\modules\playerbots.conf" }
)
foreach ($p in $pairs) {
  if (Test-Path $p.d) { Copy-Item $p.d $p.c -Force; W ("copied -> " + (Split-Path $p.c -Leaf)) }
  else { W ("MISSING dist: " + $p.d) }
}

# Replace the FIRST uncommented occurrence of a key. AzerothCore confs use
# 'Key = value'; the .dist also contains the key inside comment blocks, so we
# must only touch lines that start with the key at column 0.
function Set-Conf($file, $key, $value) {
  if (-not (Test-Path $file)) { W "  ! missing $file"; return }
  $lines = Get-Content $file
  $pattern = '^\s*' + [regex]::Escape($key) + '\s*='
  $hit = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match $pattern) { $lines[$i] = "$key = $value"; $hit = $true; break }
  }
  # NOTE: must write UTF-8 *without* BOM. PowerShell 5.1's `-Encoding utf8`
  # emits a BOM, and AzerothCore's config parser then reports
  # "Failure to read line number 1 ... Skip this line" on every file.
  if ($hit) { [System.IO.File]::WriteAllLines($file, $lines, (New-Object System.Text.UTF8Encoding($false))); W "  $key = $value" }
  else      { W "  ! KEY NOT FOUND: $key  (option name wrong?)" }
}

$ws = "$cfg\worldserver.conf"
$pb = "$cfg\modules\playerbots.conf"

W "worldserver.conf:"
Set-Conf $ws 'DataDir'           '"C:/Users/DomiJesusa/Desktop/wow/server/Data"'
Set-Conf $ws 'LogsDir'           '"C:/Users/DomiJesusa/Desktop/wow/server/logs"'
Set-Conf $ws 'SourceDirectory'   '"C:/Users/DomiJesusa/Desktop/wow/source"'
Set-Conf $ws 'ProcessPriority'   '0'
Set-Conf $ws 'MapUpdate.Threads' '2'

W "authserver.conf: (LogsDir only - everything else already correct)"
Set-Conf "$cfg\authserver.conf" 'LogsDir' '"C:/Users/DomiJesusa/Desktop/wow/server/logs"'

# Bots stay OFF for this first boot (agreed scope: stop before Phase 7).
# RandomBotRandomPassword must be set BEFORE any bot account exists - it is
# only consulted at creation time, so fixing it later does not help.
W "playerbots.conf: bots DISABLED for first boot; password hardening pre-applied"
Set-Conf $pb 'AiPlayerbot.Enabled'                 '0'
Set-Conf $pb 'AiPlayerbot.RandomBotRandomPassword' '1'
Set-Conf $pb 'AiPlayerbot.MinRandomBots'           '40'
Set-Conf $pb 'AiPlayerbot.MaxRandomBots'           '40'
Set-Conf $pb 'AiPlayerbot.AddClassAccountPoolSize' '5'

# --- verify -----------------------------------------------------------------
W "--- verification ---"
foreach ($k in @('DataDir','LogsDir','SourceDirectory','ProcessPriority','MapUpdate.Threads','Updates.EnableDatabases','BindIP','WorldServerPort')) {
  $m = Select-String -Path $ws -Pattern ('^\s*' + [regex]::Escape($k) + '\s*=') | Select-Object -First 1
  W ("  ws  " + $(if ($m) { $m.Line } else { "$k NOT FOUND" }))
}
foreach ($k in @('AiPlayerbot.Enabled','AiPlayerbot.RandomBotRandomPassword','PlayerbotsDatabaseInfo')) {
  $m = Select-String -Path $pb -Pattern ('^\s*' + [regex]::Escape($k) + '\s*=') | Select-Object -First 1
  W ("  pb  " + $(if ($m) { $m.Line } else { "$k NOT FOUND" }))
}
W "=== done ==="
