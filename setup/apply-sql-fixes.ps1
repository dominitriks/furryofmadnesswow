# Apply the custom SQL fixes in setup\sql-fixes\ that this machine has not run yet.
#
#   .\apply-sql-fixes.ps1            apply everything pending
#   .\apply-sql-fixes.ps1 -List      show status, change nothing
#
# WHY THIS EXISTS
#   Most raid and dungeon bugs in AzerothCore are fixed with SQL, not C++:
#   a wrong creature stat, a missing spawn, a broken smart_script, an absent
#   row in spell_script_names. Those live in acore_world - a database that is
#   NOT dumped and NOT in git, because AzerothCore regenerates it from its own
#   SQL on first boot.
#
#   So a fix applied by hand on one machine simply does not exist on the other,
#   and it also disappears from THIS machine the moment acore_world is rebuilt.
#   Keeping the fixes as numbered files in git solves both: they are versioned,
#   reviewable, and replayable anywhere.
#
# HOW TRACKING WORKS
#   Each fix is recorded in a `custom_fix_log` table inside the database it
#   targets - deliberately not in a central one. Drop and regenerate
#   acore_world and its log goes with it, so every world fix correctly re-applies
#   on the next run instead of being silently skipped.

param(
    [switch]$List,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$BASE = Split-Path $PSScriptRoot -Parent
$dir  = Join-Path $PSScriptRoot 'sql-fixes'

$mysqlBin = 'C:\Program Files\MySQL\MySQL Server 8.4\bin'
$mysql = Join-Path $mysqlBin 'mysql.exe'
if (-not (Test-Path $mysql)) { throw "mysql.exe not found at $mysql" }

$passFile = Join-Path $PSScriptRoot 'db-password.txt'
if (-not (Test-Path $passFile)) { throw "missing $passFile" }
$dbPass = (Get-Content $passFile -Raw).Trim()

$cnf = Join-Path ([System.IO.Path]::GetTempPath()) ("acfix-" + [guid]::NewGuid().ToString('N') + ".cnf")
[System.IO.File]::WriteAllText($cnf, "[client]`nuser=acore`npassword=""$dbPass""`nhost=127.0.0.1`nprotocol=tcp`n",
    (New-Object System.Text.UTF8Encoding($false)))
$acl = Get-Acl $cnf
$acl.SetAccessRuleProtection($true, $false)
$acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    [System.Security.Principal.WindowsIdentity]::GetCurrent().Name, 'FullControl', 'Allow')))
Set-Acl $cnf $acl

function Invoke-Sql([string]$db, [string]$sql) {
    $out = & $mysql "--defaults-file=$cnf" '--default-character-set=utf8mb4' '--batch' '--skip-column-names' $db -e $sql 2>&1
    if ($LASTEXITCODE -ne 0) { throw "SQL failed on ${db}: $out" }
    return $out
}

try {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $files = Get-ChildItem $dir -Filter '*.sql' -File | Sort-Object Name
    if ($files.Count -eq 0) {
        Write-Output "no fixes in $dir yet"
        Write-Output "add one as setup\sql-fixes\001-short-description.sql - see the README there"
        return
    }

    $pending = 0; $applied = 0; $drifted = 0

    foreach ($f in $files) {
        $text = [System.IO.File]::ReadAllText($f.FullName)

        # `-- target: acore_world` on any line before the first statement.
        $target = 'acore_world'
        $m = [regex]::Match($text, '(?im)^\s*--\s*target:\s*(\S+)\s*$')
        if ($m.Success) { $target = $m.Groups[1].Value }
        if ($target -notin @('acore_world', 'acore_characters', 'acore_auth', 'acore_playerbots')) {
            throw "$($f.Name): unknown target database '$target'"
        }

        $hash = (Get-FileHash $f.FullName -Algorithm SHA256).Hash

        Invoke-Sql $target @"
CREATE TABLE IF NOT EXISTS custom_fix_log (
  name       VARCHAR(191) NOT NULL PRIMARY KEY,
  sha256     CHAR(64)     NOT NULL,
  applied_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
"@ | Out-Null

        $safe = $f.Name.Replace("'", "''")
        $row = Invoke-Sql $target "SELECT sha256 FROM custom_fix_log WHERE name='$safe';"
        $prev = ($row | Where-Object { $_ -match '^[0-9A-Fa-f]{64}$' } | Select-Object -First 1)

        if ($prev) {
            if ($prev -ne $hash) {
                # An already-applied file was edited. Re-running it is not safe in
                # general, so say so rather than guess.
                Write-Warning ("{0} [{1}] CHANGED since it was applied - edit is NOT live. Add a new numbered file instead." -f $f.Name, $target)
                $drifted++
            } else {
                if ($List) { Write-Output ("  applied  {0,-46} {1}" -f $f.Name, $target) }
                $applied++
            }
            continue
        }

        if ($List) { Write-Output ("  PENDING  {0,-46} {1}" -f $f.Name, $target); $pending++; continue }

        Write-Output ("applying {0}  ->  {1}" -f $f.Name, $target)
        $p = Start-Process -FilePath $mysql -Wait -NoNewWindow -PassThru `
             -ArgumentList "--defaults-file=$cnf", '--default-character-set=utf8mb4', $target `
             -RedirectStandardInput $f.FullName
        if ($p.ExitCode -ne 0) { throw "$($f.Name) FAILED (exit $($p.ExitCode)) - nothing recorded, safe to fix and re-run" }

        Invoke-Sql $target "INSERT INTO custom_fix_log (name, sha256) VALUES ('$safe','$hash');" | Out-Null
        Write-Output "  ok"
        $pending++
    }

    Write-Output ""
    if ($List) { Write-Output ("{0} applied, {1} pending, {2} drifted" -f $applied, $pending, $drifted) }
    else       { Write-Output ("{0} newly applied, {1} already present, {2} drifted" -f $pending, $applied, $drifted) }
    if ($drifted -gt 0) { Write-Warning "drifted files were NOT re-run - see the warnings above" }
    if (-not $List -and $pending -gt 0) {
        Write-Output ""
        Write-Output "Most world-table changes need a worldserver restart, or at least:"
        Write-Output "  'reload creature_template' / 'reload smart_scripts' etc. on the console"
    }
} finally {
    Remove-Item $cnf -Force -ErrorAction SilentlyContinue
}
