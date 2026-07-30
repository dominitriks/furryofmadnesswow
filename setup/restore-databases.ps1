# Restore database dumps onto a new machine.
#
#   .\restore-databases.ps1 -From D:\wow-backup\db-backup-2026-07-30-1400
#
# PREREQUISITES on the new machine, in order:
#   1. MySQL installed and running
#   2. setup\01-create-databases.sql run as root (creates the 4 DBs + acore user)
#   3. setup\db-password.txt holding the acore password used there
#   4. The game servers STOPPED - restoring under a live server corrupts state
#
# Databases not present in the backup folder are left alone. acore_world and
# acore_playerbots are normally absent by design and repopulate on first boot.

param(
    [Parameter(Mandatory = $true)][string]$From,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $From)) { throw "backup folder not found: $From" }

$mysqlBin = 'C:\Program Files\MySQL\MySQL Server 8.4\bin'
$mysql = Join-Path $mysqlBin 'mysql.exe'
if (-not (Test-Path $mysql)) { throw "mysql.exe not found at $mysql" }

$passFile = Join-Path $PSScriptRoot 'db-password.txt'
if (-not (Test-Path $passFile)) { throw "missing $passFile - create it with the acore password on THIS machine" }
$dbPass = (Get-Content $passFile -Raw).Trim()

foreach ($p in @('worldserver', 'authserver')) {
    if (Get-Process $p -ErrorAction SilentlyContinue) {
        throw "$p is running. Stop both game servers before restoring, or the import will fight the live server."
    }
}

$dumps = Get-ChildItem $From -Filter 'acore_*.sql' -File
if ($dumps.Count -eq 0) { throw "no acore_*.sql files in $From" }

Write-Output "About to OVERWRITE these databases from $From :"
foreach ($d in $dumps) { Write-Output ("  {0,-24} {1,8:N1} MB" -f $d.BaseName, ($d.Length / 1MB)) }

if (-not $Force) {
    $answer = Read-Host "Type RESTORE to proceed"
    if ($answer -ne 'RESTORE') { Write-Output "aborted"; exit 1 }
}

$cnf = Join-Path ([System.IO.Path]::GetTempPath()) ("acrest-" + [guid]::NewGuid().ToString('N') + ".cnf")
$cnfBody = "[client]`nuser=acore`npassword=""$dbPass""`nhost=127.0.0.1`nprotocol=tcp`n"
[System.IO.File]::WriteAllText($cnf, $cnfBody, (New-Object System.Text.UTF8Encoding($false)))
$acl = Get-Acl $cnf
$acl.SetAccessRuleProtection($true, $false)
$acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    [System.Security.Principal.WindowsIdentity]::GetCurrent().Name, 'FullControl', 'Allow')))
Set-Acl $cnf $acl

try {
    foreach ($d in $dumps) {
        $db = $d.BaseName
        Write-Output "restoring $db ..."
        # -InFile, not a pipe: PowerShell 5.1 re-encodes piped text and mangles
        # anything non-ASCII on the way into mysql.exe.
        $p = Start-Process -FilePath $mysql -Wait -NoNewWindow -PassThru `
             -ArgumentList "--defaults-file=$cnf", "--default-character-set=utf8mb4", $db `
             -RedirectStandardInput $d.FullName
        if ($p.ExitCode -ne 0) { throw "restore failed for $db (exit $($p.ExitCode))" }
        Write-Output "  ok"
    }
} finally {
    Remove-Item $cnf -Force -ErrorAction SilentlyContinue
}

# ---- verify, and surface the one thing that is always wrong after a move ----
$env:MYSQL_PWD = $dbPass
try {
    Write-Output ""
    Write-Output "--- verification ---"
    & $mysql -u acore -h 127.0.0.1 --protocol=tcp -e `
        "SELECT (SELECT COUNT(*) FROM acore_auth.account) AS accounts, (SELECT COUNT(*) FROM acore_auth.account_access) AS gm_rows, (SELECT COUNT(*) FROM acore_characters.characters) AS chars;" 2>&1 |
        Where-Object { $_ -notmatch 'Using a password' }

    Write-Output ""
    Write-Output "--- realmlist (points at the OLD machine until you fix it) ---"
    & $mysql -u acore -h 127.0.0.1 --protocol=tcp -e `
        "SELECT id,name,address,localAddress,port FROM acore_auth.realmlist;" 2>&1 |
        Where-Object { $_ -notmatch 'Using a password' }
} finally { Remove-Item Env:\MYSQL_PWD -ErrorAction SilentlyContinue }

$lan = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
        Select-Object -First 1 -ExpandProperty IPAddress)

Write-Output ""
Write-Output "NEXT: point the realm at THIS machine, or clients hang after login."
if ($lan) { Write-Output "  this machine's LAN IPv4 looks like: $lan" }
Write-Output "  UPDATE acore_auth.realmlist SET address='<public IP/hostname>', localAddress='$lan' WHERE id=1;"
