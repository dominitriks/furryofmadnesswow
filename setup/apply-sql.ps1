# Applies SQL changes that travel through git, once each, in order.
#
# Why this exists: settings and C++ patches have a path from one machine to
# another, but changes to the WORLD - a teleport location, a fixed NPC, a custom
# item - are rows in a database, and a database does not merge. So they travel as
# files: whoever makes the change writes the SQL, commits it, and every machine
# replays it in the same order.
#
#   setup\sql\world\2026-07-31-teleports.sql        -> acore_world
#   setup\sql\characters\2026-08-02-fix-guild.sql   -> acore_characters
#   setup\sql\auth\...                              -> acore_auth
#
# Names are applied in sort order, so date-first names keep the order obvious.
#
# Each applied file is recorded in acore_world.fom_migrations, so running this
# twice is safe: the second run has nothing to do. That record is what makes the
# whole thing work - without it, re-running a file that inserts an NPC would
# insert it twice.
#
#   powershell -ExecutionPolicy Bypass -File setup\apply-sql.ps1
#   ... -WhatIf     show what would run, change nothing

param([switch]$WhatIf)

$ErrorActionPreference = 'Stop'
$BASE = Split-Path $PSScriptRoot -Parent

$mysql = 'C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe'
if (-not (Test-Path $mysql)) { throw "mysql.exe not found at $mysql" }

$passFile = "$PSScriptRoot\db-password.txt"
if (-not (Test-Path $passFile)) { throw "missing $passFile" }
$dbPass = (Get-Content $passFile -Raw).Trim()

$sqlRoot = "$PSScriptRoot\sql"
if (-not (Test-Path $sqlRoot)) {
    Write-Output "no setup\sql folder - nothing to apply"
    exit 0
}

# A defaults-file rather than -p on the command line: the password would
# otherwise be visible to anything that can list processes.
$cnf = Join-Path ([System.IO.Path]::GetTempPath()) ("fomsql-" + [guid]::NewGuid().ToString('N') + ".cnf")
[System.IO.File]::WriteAllText($cnf, "[client]`nuser=acore`npassword=""$dbPass""`nhost=127.0.0.1`nprotocol=tcp`n",
    (New-Object System.Text.UTF8Encoding($false)))
$acl = Get-Acl $cnf
$acl.SetAccessRuleProtection($true, $false)
$acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    [System.Security.Principal.WindowsIdentity]::GetCurrent().Name, 'FullControl', 'Allow')))
Set-Acl $cnf $acl

function Invoke-Sql([string]$db, [string]$query) {
    $out = & $mysql "--defaults-file=$cnf" --default-character-set=utf8mb4 -N -B $db -e $query 2>&1
    if ($LASTEXITCODE -ne 0) { throw "query failed on ${db}: $out" }
    return $out
}

try {
    # The ledger lives in acore_world because that is the database these changes
    # almost always target, and it survives the world being repopulated only if
    # nobody drops the database - which is why the restore docs say not to.
    Invoke-Sql 'acore_world' @"
CREATE TABLE IF NOT EXISTS fom_migrations (
  name VARCHAR(255) NOT NULL PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_by VARCHAR(64) NOT NULL DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
"@ | Out-Null

    $applied = @{}
    foreach ($row in (Invoke-Sql 'acore_world' 'SELECT name FROM fom_migrations;')) {
        if ($row) { $applied[$row.Trim()] = $true }
    }

    $targets = @{ world = 'acore_world'; characters = 'acore_characters'; auth = 'acore_auth'; playerbots = 'acore_playerbots' }
    $pending = @()

    foreach ($folder in $targets.Keys | Sort-Object) {
        $dir = Join-Path $sqlRoot $folder
        if (-not (Test-Path $dir)) { continue }
        foreach ($f in (Get-ChildItem $dir -Filter '*.sql' -File | Sort-Object Name)) {
            $key = "$folder/$($f.Name)"
            if ($applied.ContainsKey($key)) { continue }
            $pending += [pscustomobject]@{ Key = $key; Db = $targets[$folder]; File = $f }
        }
    }

    if ($pending.Count -eq 0) {
        Write-Output "up to date - $($applied.Count) migration(s) already applied"
        exit 0
    }

    Write-Output "pending:"
    foreach ($p in $pending) { Write-Output ("  {0,-52} -> {1}" -f $p.Key, $p.Db) }

    if ($WhatIf) { Write-Output "`n-WhatIf: nothing was changed"; exit 0 }

    # Refuse while the world is live: worldserver caches much of acore_world in
    # memory at startup, so a row inserted underneath it is invisible until a
    # restart, and a row it is mid-write on can be lost.
    if (Get-Process worldserver -ErrorAction SilentlyContinue) {
        throw "worldserver is running. Stop it first - changes to acore_world are cached in memory and would not take effect, or would fight the live server."
    }

    foreach ($p in $pending) {
        Write-Output "applying $($p.Key) ..."
        $proc = Start-Process -FilePath $mysql -Wait -NoNewWindow -PassThru `
            -ArgumentList "--defaults-file=$cnf", '--default-character-set=utf8mb4', $p.Db `
            -RedirectStandardInput $p.File.FullName
        if ($proc.ExitCode -ne 0) {
            throw "FAILED on $($p.Key) (exit $($proc.ExitCode)). Nothing after it was applied; fix the file and run again."
        }
        $who = ($env:USERNAME -replace "'", "''")
        $name = ($p.Key -replace "'", "''")
        Invoke-Sql 'acore_world' "INSERT INTO fom_migrations (name, applied_by) VALUES ('$name', '$who');" | Out-Null
        Write-Output "  ok"
    }

    Write-Output "`n$($pending.Count) migration(s) applied. Start the server to pick them up."
}
finally {
    Remove-Item $cnf -Force -ErrorAction SilentlyContinue
}
