# Replay setup\server-settings.conf onto this machine's live configs.
#
#   .\apply-settings.ps1 -FromDist    fresh install: reset from .dist, then apply
#   .\apply-settings.ps1              existing install: apply on top, keep the rest
#   .\apply-settings.ps1 -WhatIf      show what would change, touch nothing
#
# Every machine-specific value is derived here, never stored:
#   {{BASE}}     <- this script's parent folder
#   {{DB_PASS}}  <- setup\db-password.txt

[CmdletBinding(SupportsShouldProcess = $true)]
param([switch]$FromDist)

$ErrorActionPreference = 'Stop'
$BASE = Split-Path $PSScriptRoot -Parent
$cfg  = Join-Path $BASE 'server\configs'
$src  = Join-Path $PSScriptRoot 'server-settings.conf'

if (-not (Test-Path $src)) { throw "missing $src - run export-settings.ps1 on the old machine first" }
if (-not (Test-Path $cfg)) { throw "missing $cfg - has the build's 'install' target run yet?" }

$dbPassFile = Join-Path $PSScriptRoot 'db-password.txt'
if (-not (Test-Path $dbPassFile)) { throw "missing $dbPassFile - create it with the MySQL 'acore' password first" }
$dbPass = (Get-Content $dbPassFile -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($dbPass)) { throw "$dbPassFile is empty" }

Write-Output "BASE = $BASE"

# ---------------------------------------------------------------- parse
$sections = [ordered]@{}
$current  = $null
foreach ($line in [System.IO.File]::ReadAllLines($src)) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    if ($t -match '^\[(.+)\]$') { $current = $Matches[1]; $sections[$current] = [ordered]@{}; continue }
    if ($null -eq $current) { continue }
    if ($t -match '^([A-Za-z0-9_.]+)\s*=\s*(.*)$') {
        $v = $Matches[2]
        $v = $v -replace '\{\{BASE\}\}', ($BASE -replace '\\', '/')
        $v = $v -replace '\{\{DB_PASS\}\}', $dbPass
        $sections[$current][$Matches[1]] = $v
    }
}

# ---------------------------------------------------------------- pre-flight
# LfgEnterDelayMin/Max are read by patch 001. Without the patch they are inert
# text - the bots would enter dungeons with no delay and nothing would say why.
$needsPatch = $false
foreach ($s in $sections.Values) { if ($s.Contains('AiPlayerbot.LfgEnterDelayMin')) { $needsPatch = $true } }
if ($needsPatch) {
    # Search rather than hardcode: this fork has moved the file before
    # (src/strategy/actions -> src/Ai/Base/Actions).
    $modRoot = Join-Path $BASE 'source\modules\mod-playerbots'
    $lfg = $null
    if (Test-Path $modRoot) {
        $lfg = Get-ChildItem $modRoot -Recurse -Filter 'LfgActions.cpp' -ErrorAction SilentlyContinue |
               Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $lfg) {
        Write-Warning "cannot find LfgActions.cpp under $modRoot - is the source tree in place?"
    } elseif (-not (Select-String -Path $lfg -Pattern 'LfgEnterDelay' -Quiet)) {
        Write-Warning "PATCH 001 IS NOT APPLIED. LfgEnterDelayMin/Max will have no effect."
        Write-Warning "Apply setup\patches\001-lfg-accept-in-combat.patch and REBUILD, then re-run."
    } else {
        Write-Output "patch 001 present in source (LfgEnterDelay found)"
    }
}

# ---------------------------------------------------------------- apply
function Apply-Section([string]$label, [string]$file, $kv) {
    $dist = "$file.dist"
    if ($FromDist) {
        if (-not (Test-Path $dist)) { Write-Warning "no .dist for $label - skipping reset"; }
        elseif ($PSCmdlet.ShouldProcess($file, 'reset from .dist')) {
            Copy-Item $dist $file -Force
            Write-Output "  reset from .dist"
        }
    }
    if (-not (Test-Path $file)) {
        if (-not (Test-Path $dist)) { Write-Warning "$label does not exist and has no .dist - skipped"; return }
        Copy-Item $dist $file -Force
        Write-Output "  created from .dist"
    }

    $lines = [System.Collections.Generic.List[string]]::new()
    [System.IO.File]::ReadAllLines($file) | ForEach-Object { [void]$lines.Add($_) }

    $set = 0; $added = 0; $same = 0
    foreach ($key in $kv.Keys) {
        $val = $kv[$key]
        $want = "$key = $val"
        # Only lines where the key starts the line - the .dist repeats every key
        # inside its comment blocks.
        $pattern = '^\s*' + [regex]::Escape($key) + '\s*='
        $idx = -1
        for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match $pattern) { $idx = $i; break } }

        if ($idx -ge 0) {
            if ($lines[$idx] -eq $want) { $same++ }
            else { $lines[$idx] = $want; $set++; Write-Verbose "    set    $key" }
        } else {
            # Not in the .dist at all => added by a source patch. Append it.
            [void]$lines.Add('')
            [void]$lines.Add("# added by apply-settings.ps1 (not a stock option)")
            [void]$lines.Add($want)
            $added++
            Write-Output "    APPEND $key = $val"
        }
    }

    if ($PSCmdlet.ShouldProcess($file, 'write')) {
        # UTF-8 WITHOUT BOM. PowerShell 5.1's -Encoding utf8 writes a BOM, and
        # AzerothCore then logs "Failure to read line number 1" for the file.
        [System.IO.File]::WriteAllLines($file, $lines, (New-Object System.Text.UTF8Encoding($false)))
    }
    Write-Output ("  {0}: {1} changed, {2} appended, {3} already correct" -f $label, $set, $added, $same)
}

# A [modules/<name>.conf] section resolves on its own, so adding a module needs
# no edit here. With a hardcoded list, a new module's settings silently never
# applied: the section sat in server-settings.conf, was skipped as "unknown",
# and the module ran on its built-in defaults while looking configured.
function Resolve-ConfPath([string]$label) {
    if ($label -match '^modules/(.+\.conf)$') { return (Join-Path $cfg (Join-Path 'modules' $Matches[1])) }
    if ($label -match '^[A-Za-z0-9_.-]+\.conf$') { return (Join-Path $cfg $label) }
    return $null
}

foreach ($label in $sections.Keys) {
    $path = Resolve-ConfPath $label
    if (-not $path) { Write-Warning "unknown section [$label] - skipped"; continue }
    Write-Output ""
    Write-Output "[$label]"
    Apply-Section $label $path $sections[$label]
}

# ---------------------------------------------------------------- verify
if (-not $WhatIfPreference) {
    Write-Output ""
    Write-Output "--- verification ---"
    $bad = 0
    foreach ($label in $sections.Keys) {
        $file = Resolve-ConfPath $label
        if (-not $file) { continue }
        if (-not (Test-Path $file)) { continue }

        $bytes = [System.IO.File]::ReadAllBytes($file)
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
            Write-Warning "$label has a UTF-8 BOM - the config parser will reject line 1"
            $bad++
        }

        $live = @{}
        foreach ($l in [System.IO.File]::ReadAllLines($file)) {
            if ($l -match '^\s*([A-Za-z0-9_.]+)\s*=\s*(.*?)\s*$') { if (-not $live.ContainsKey($Matches[1])) { $live[$Matches[1]] = $Matches[2] } }
        }
        foreach ($key in $sections[$label].Keys) {
            if ($live[$key] -ne $sections[$label][$key]) {
                Write-Warning "  MISMATCH $label :: $key"
                $bad++
            }
        }
    }
    if ($bad -eq 0) { Write-Output "  all settings verified present and correct" }
    else { Write-Output "  $bad problem(s) above" }

    # Paths in the config must actually exist, or the failures are silent:
    # a missing LogsDir disables file logging, a wrong DataDir fails much later.
    foreach ($d in @("$BASE\server\Data", "$BASE\server\logs", "$BASE\source")) {
        if (Test-Path $d) { Write-Output "  ok   $d" }
        else { Write-Warning "  MISSING $d" }
    }
}
