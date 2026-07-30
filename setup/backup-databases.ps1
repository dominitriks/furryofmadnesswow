# Dump the game databases for a machine move (or just a backup).
#
#   .\backup-databases.ps1              accounts + characters only  (~17 MB)
#   .\backup-databases.ps1 -All         also world + playerbots     (~520 MB)
#   .\backup-databases.ps1 -To D:\wow-backup
#
# WHY THE DEFAULT IS ONLY TWO DATABASES
#   acore_auth (accounts, GM rights, realmlist) and acore_characters (players,
#   guilds, mail, items) are IRREPLACEABLE - nothing can regenerate them.
#   acore_world and acore_playerbots are rebuilt automatically on first boot by
#   AzerothCore's own updater. Use -All only if you have hand-edited world data
#   (custom spawns, loot, vendors); if unsure, -All is the safe choice.

param(
    [switch]$All,
    [string]$To
)

$ErrorActionPreference = 'Stop'
$BASE = Split-Path $PSScriptRoot -Parent

$mysqlBin = 'C:\Program Files\MySQL\MySQL Server 8.4\bin'
$dump = Join-Path $mysqlBin 'mysqldump.exe'
if (-not (Test-Path $dump)) { throw "mysqldump.exe not found at $dump" }

$passFile = Join-Path $PSScriptRoot 'db-password.txt'
if (-not (Test-Path $passFile)) { throw "missing $passFile" }
$dbPass = (Get-Content $passFile -Raw).Trim()

if (-not $To) { $To = Join-Path $BASE ("db-backup-" + (Get-Date -Format 'yyyy-MM-dd-HHmm')) }
New-Item -ItemType Directory -Force -Path $To | Out-Null

$dbs = @('acore_auth', 'acore_characters')
if ($All) { $dbs += @('acore_world', 'acore_playerbots') }

# A password on the command line is visible to every process on the box via the
# process list. Hand it over in a temp defaults-file instead, locked to this user.
$cnf = Join-Path ([System.IO.Path]::GetTempPath()) ("acdump-" + [guid]::NewGuid().ToString('N') + ".cnf")
$cnfBody = "[client]`nuser=acore`npassword=""$dbPass""`nhost=127.0.0.1`nprotocol=tcp`n"
[System.IO.File]::WriteAllText($cnf, $cnfBody, (New-Object System.Text.UTF8Encoding($false)))
$acl = Get-Acl $cnf
$acl.SetAccessRuleProtection($true, $false)
$acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    [System.Security.Principal.WindowsIdentity]::GetCurrent().Name, 'FullControl', 'Allow')))
Set-Acl $cnf $acl

try {
    foreach ($db in $dbs) {
        $out = Join-Path $To "$db.sql"
        Write-Output "dumping $db ..."
        # --single-transaction: consistent snapshot without locking players out.
        # --hex-blob: character blobs survive the round trip intact.
        # --no-tablespaces: the 'acore' user deliberately has no PROCESS privilege,
        #   and without this mysqldump errors on tablespace metadata we do not need.
        $err = Join-Path ([System.IO.Path]::GetTempPath()) ("acdump-err-" + [guid]::NewGuid().ToString('N') + ".txt")
        $p = Start-Process -FilePath $dump -Wait -NoNewWindow -PassThru -RedirectStandardError $err `
             -ArgumentList "--defaults-file=$cnf", '--single-transaction', '--routines', '--triggers', `
                           '--hex-blob', '--no-tablespaces', '--default-character-set=utf8mb4', `
                           "--result-file=$out", $db
        $stderr = ''
        if (Test-Path $err) { $stderr = (Get-Content $err -Raw); Remove-Item $err -Force -ErrorAction SilentlyContinue }
        if ($p.ExitCode -ne 0) { throw "mysqldump failed for ${db} (exit $($p.ExitCode)): $stderr" }
        if ($stderr -match 'Error:') { throw "mysqldump reported an error for ${db}: $stderr" }

        # A dump that stops early still looks like a normal file. mysqldump only
        # writes this trailer once it has finished cleanly, so check for it.
        $tail = Get-Content $out -Tail 3 -ErrorAction SilentlyContinue
        if (-not ($tail -match 'Dump completed')) { throw "$db.sql is TRUNCATED - no 'Dump completed' trailer" }

        $mb = (Get-Item $out).Length / 1MB
        Write-Output ("  {0,-20} {1,8:N1} MB  verified complete" -f "$db.sql", $mb)
    }
} finally {
    Remove-Item $cnf -Force -ErrorAction SilentlyContinue
}

# The realm address is machine- and network-specific, so record it as a note
# rather than relying on the dump: on the new machine it will need updating.
$realm = Join-Path $To 'realmlist-note.txt'
@(
    "The restored acore_auth.realmlist row still points at the OLD machine."
    "After restoring, set it for the new one:"
    ""
    "  UPDATE acore_auth.realmlist SET"
    "     address      = '<public IP or hostname clients reach>',"
    "     localAddress = '<new machine LAN IPv4>'"
    "  WHERE id = 1;"
    ""
    "No restart needed - authserver re-resolves every RealmsStateUpdateDelay (20s)."
    "Values dumped from the old machine, for reference:"
) | Set-Content $realm -Encoding utf8

$mysql = Join-Path $mysqlBin 'mysql.exe'
if (Test-Path $mysql) {
    $env:MYSQL_PWD = $dbPass
    try {
        & $mysql -u acore -h 127.0.0.1 --protocol=tcp -e `
            "SELECT id,name,address,localAddress,localSubnetMask,port FROM acore_auth.realmlist\G" 2>&1 |
            Where-Object { $_ -notmatch 'Using a password' } | Add-Content $realm -Encoding utf8
    } finally { Remove-Item Env:\MYSQL_PWD -ErrorAction SilentlyContinue }
}

Write-Output ""
Write-Output "backup written to: $To"
Write-Output "Restore on the new machine with: setup\restore-databases.ps1 -From `"$To`""
if (-not $All) {
    Write-Output ""
    Write-Output "NOTE: acore_world and acore_playerbots were NOT dumped - they rebuild"
    Write-Output "      themselves on first boot. Re-run with -All if you have custom world edits."
}
