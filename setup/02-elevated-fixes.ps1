# Phase 2.5 - runs ELEVATED. Logs everything so the outcome is verifiable afterwards.
$log = 'C:\Users\DomiJesusa\Desktop\wow\setup\02-elevated-fixes.log'
function W($m) { $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m; Add-Content -Path $log -Value $line -Encoding utf8 }

Set-Content -Path $log -Value "=== Phase 2.5 elevated fixes ===" -Encoding utf8
W ("Elevated: " + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))

# --- A. Defender exclusions -------------------------------------------------
# Fixes the file locking that forced -p:TrackFileAccess=false, which made every
# build a full rebuild. With these in place incremental builds work again.
foreach ($p in @('C:\Users\DomiJesusa\Desktop\wow\build','C:\Users\DomiJesusa\Desktop\wow\source')) {
    try { Add-MpPreference -ExclusionPath $p -ErrorAction Stop; W "exclusion added: $p" }
    catch { W "exclusion FAILED for ${p}: $($_.Exception.Message)" }
}
try { W ("exclusions now: " + ((Get-MpPreference).ExclusionPath -join ' | ')) } catch { W "could not read exclusions: $($_.Exception.Message)" }

# --- B. MySQL as a Windows service -----------------------------------------
$mysqld = 'C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqld.exe'
$ini    = 'C:\Users\DomiJesusa\Desktop\wow\mysql\my.ini'

# The user-level instance holds port 3306; the service cannot bind until it exits.
$running = Get-Process mysqld -ErrorAction SilentlyContinue
if ($running) {
    W "stopping user-level mysqld (pids: $($running.Id -join ','))"
    $running | Stop-Process -Force
    Start-Sleep -Seconds 8
}
W ("mysqld still running: " + ((Get-Process mysqld -ErrorAction SilentlyContinue | Measure-Object).Count))

$existing = Get-Service -Name MySQL84 -ErrorAction SilentlyContinue
if ($existing) {
    W "service MySQL84 already exists (status $($existing.Status)) - skipping --install"
} else {
    W "installing service MySQL84"
    & $mysqld --install MySQL84 --defaults-file=$ini
    W "mysqld --install exit code: $LASTEXITCODE"
}

try {
    Start-Service -Name MySQL84 -ErrorAction Stop
    Start-Sleep -Seconds 10
    $svc = Get-Service -Name MySQL84
    W "service status: $($svc.Status) / startType: $($svc.StartType)"
} catch {
    W "Start-Service FAILED: $($_.Exception.Message)"
    # Fallback: bring the user-level instance back so the databases stay reachable.
    W "falling back to user-level mysqld so the DB stays up"
    Start-Process -FilePath $mysqld -ArgumentList "--defaults-file=$ini" -WindowStyle Hidden
    Start-Sleep -Seconds 10
}

# --- verify DB is reachable either way -------------------------------------
$mysql = 'C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe'
$out = & $mysql -u acore -pacore --protocol=tcp -h 127.0.0.1 -N -e "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'acore%';" 2>&1
W ("acore db count query -> " + ($out -join ' '))
W "=== done ==="
