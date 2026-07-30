# One-shot launcher for the AzerothCore server.
# Right-click -> "Run with PowerShell", or:  powershell -ExecutionPolicy Bypass -File START-SERVER.ps1
#
# MySQL is a Windows service (MySQL84) and starts automatically on boot.
# The two game servers do NOT - this script brings them up.

$base = 'C:\Users\DomiJesusa\Desktop\wow'

Write-Host "=== AzerothCore launcher ===" -ForegroundColor Cyan

# 1. MySQL must be up before either server, or the DB pools fail to open.
$svc = Get-Service MySQL84 -ErrorAction SilentlyContinue
if (-not $svc) {
    Write-Host "MySQL84 service not found." -ForegroundColor Red; exit 1
}
if ($svc.Status -ne 'Running') {
    Write-Host "Starting MySQL84..." -ForegroundColor Yellow
    Start-Service MySQL84; Start-Sleep -Seconds 8
}
Write-Host ("MySQL84: " + (Get-Service MySQL84).Status) -ForegroundColor Green

# 2. Worldserver, via the relay (keeps stdin open so the console stays usable
#    and the server does not self-terminate on EOF).
if (Get-Process worldserver -ErrorAction SilentlyContinue) {
    Write-Host "worldserver already running" -ForegroundColor Green
} else {
    Write-Host "Starting worldserver (world init takes ~40s)..." -ForegroundColor Yellow
    Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"$base\setup\run-worldserver.ps1" -WindowStyle Hidden
    $deadline = (Get-Date).AddMinutes(5)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        $log = "$base\server\logs\worldserver-console.log"
        if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'World Initialized' -ErrorAction SilentlyContinue)) { break }
    }
    Write-Host "worldserver ready" -ForegroundColor Green
}

# 3. Authserver last - it logs the realm address it hands to clients.
if (Get-Process authserver -ErrorAction SilentlyContinue) {
    Write-Host "authserver already running" -ForegroundColor Green
} else {
    Write-Host "Starting authserver..." -ForegroundColor Yellow
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$base\setup\run-authserver.ps1" | Out-Null
    Start-Sleep -Seconds 12
}

# 4. Admin panel (localhost only)
if (Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction SilentlyContinue) {
    Write-Host "panel already running" -ForegroundColor Green
} else {
    Write-Host "Starting panel..." -ForegroundColor Yellow
    Start-Process node.exe -ArgumentList 'server.js' -WorkingDirectory "$base\panel" `
        -WindowStyle Hidden -RedirectStandardOutput "$base\panel\panel.log" -RedirectStandardError "$base\panel\panel.err"
    Start-Sleep -Seconds 4
}
Write-Host "panel: http://localhost:8080" -ForegroundColor Green

# 5. Report
Write-Host "`n=== status ===" -ForegroundColor Cyan
foreach ($p in @('worldserver','authserver')) {
    $n = (Get-Process $p -ErrorAction SilentlyContinue | Measure-Object).Count
    Write-Host ("  {0,-12} {1}" -f $p, $(if ($n) { 'running' } else { 'NOT RUNNING' })) -ForegroundColor $(if ($n) { 'Green' } else { 'Red' })
}
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in 3724, 8085 } |
    ForEach-Object { Write-Host ("  listening {0}:{1}" -f $_.LocalAddress, $_.LocalPort) -ForegroundColor Green }
Select-String -Path "$base\server\logs\Auth.log" -Pattern 'Added realm' -ErrorAction SilentlyContinue |
    Select-Object -Last 1 | ForEach-Object { Write-Host ("  " + $_.Line.Trim()) -ForegroundColor Green }

Write-Host "`nTo send console commands (e.g. 'server info'):" -ForegroundColor Cyan
Write-Host "  'server info' | Set-Content '$base\server\cmd.txt' -Encoding ascii"
Write-Host "  then read: $base\server\logs\worldserver-console.log"
Write-Host "`nTo stop:  'server shutdown 1' | Set-Content '$base\server\cmd.txt' -Encoding ascii ; Stop-Process -Name authserver"
