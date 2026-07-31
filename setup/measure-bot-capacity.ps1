# Finds how many playerbots THIS machine carries, by measuring instead of guessing.
#
# Method: raise the bot count in steps, and at each step let the world settle,
# then sample the server tick for several minutes. The tick (diff) is the honest
# number - it is how long one world update takes, so when it climbs past ~100ms
# players feel it as delay. RAM is recorded too, but on 64 GB it will not be the
# limit; the world thread will be.
#
# Each step is a full restart: bot counts are read at startup, not live.
#
#   powershell -ExecutionPolicy Bypass -File setup\measure-bot-capacity.ps1
#
# WARNING: raising the count creates real accounts and characters in the
# database. Lowering it afterwards does NOT delete them.

param(
    [int[]]$Steps = @(40, 80, 150, 250),
    [int]$SampleMinutes = 4,
    [int]$SettleMinutes = 5
)

$ErrorActionPreference = 'Stop'
$BASE = Split-Path $PSScriptRoot -Parent
$conf = "$BASE\server\configs\modules\playerbots.conf"
$out  = "$PSScriptRoot\bot-capacity.log"
$csv  = "$PSScriptRoot\bot-capacity.csv"

function W($m) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m
    Add-Content -Path $out -Value $line -Encoding utf8
    Write-Output $line
}

function Set-BotCount([int]$n) {
    $t = [System.IO.File]::ReadAllText($conf)
    $t = $t -replace '(?m)^AiPlayerbot\.MinRandomBots\s*=.*$', "AiPlayerbot.MinRandomBots = $n"
    $t = $t -replace '(?m)^AiPlayerbot\.MaxRandomBots\s*=.*$', "AiPlayerbot.MaxRandomBots = $n"
    # UTF-8 without BOM: a BOM makes the core fail to read line 1 of the file.
    [System.IO.File]::WriteAllText($conf, $t, (New-Object System.Text.UTF8Encoding($false)))
}

function Stop-World {
    if (Get-Process worldserver -ErrorAction SilentlyContinue) {
        'server shutdown 1' | Set-Content "$BASE\server\cmd.txt" -Encoding ascii
        $deadline = (Get-Date).AddSeconds(90)
        while ((Get-Process worldserver -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 3
        }
        # A world that ignored the shutdown would otherwise hold the DB and the
        # port, and the next step would measure the old process.
        Get-Process worldserver -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Seconds 3
    }
}

function Start-World {
    $log = "$BASE\server\logs\worldserver-console.log"
    if (Test-Path $log) { Clear-Content $log -ErrorAction SilentlyContinue }
    Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"$BASE\setup\run-worldserver.ps1" -WindowStyle Hidden
    $deadline = (Get-Date).AddMinutes(8)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'World Initialized' -ErrorAction SilentlyContinue)) { return $true }
        if (-not (Get-Process worldserver -ErrorAction SilentlyContinue)) { return $false }
    }
    return $false
}

function Get-Status {
    try { return (Invoke-WebRequest 'http://localhost:8080/api/status' -UseBasicParsing -TimeoutSec 20).Content | ConvertFrom-Json }
    catch { return $null }
}

Set-Content -Path $out -Value "=== bot capacity sweep $(Get-Date -Format 'yyyy-MM-dd HH:mm') ===" -Encoding utf8
Set-Content -Path $csv -Value "bots_target,bots_online,players,diff_avg_ms,diff_p95_ms,diff_max_ms,ram_mb,cpu_pct,verdict" -Encoding utf8

$cpuName = (Get-CimInstance Win32_Processor).Name.Trim()
W "machine: $cpuName, $([math]::Round((Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize/1MB,0)) GB"
W "steps: $($Steps -join ', ') | settle ${SettleMinutes}m | sample ${SampleMinutes}m"

foreach ($target in $Steps) {
    W ""
    W "--- step: $target bots ---"
    Stop-World
    Set-BotCount $target
    if (-not (Start-World)) {
        W "worldserver did not come up at $target bots - stopping the sweep here"
        Add-Content $csv "$target,,,,,,,,failed to start"
        break
    }
    W "world up; settling ${SettleMinutes}m while bots log in"

    # Bots log in gradually. Stop settling early once the count stops climbing,
    # so a step that fills fast does not waste the whole window.
    $settleEnd = (Get-Date).AddMinutes($SettleMinutes)
    $lastCount = -1; $stable = 0
    while ((Get-Date) -lt $settleEnd) {
        Start-Sleep -Seconds 30
        $s = Get-Status
        $n = if ($s) { [int]$s.botsOnline } else { -1 }
        if ($n -ge 0 -and $n -eq $lastCount) { $stable++ } else { $stable = 0 }
        $lastCount = $n
        W "  settling: $n bots online"
        if ($stable -ge 3 -and $n -ge ($target * 0.9)) { W "  count stable, sampling early"; break }
    }

    W "sampling for ${SampleMinutes}m"
    $diffs = @(); $rams = @(); $cpus = @(); $online = 0; $players = 0
    $sampleEnd = (Get-Date).AddMinutes($SampleMinutes)
    while ((Get-Date) -lt $sampleEnd) {
        Start-Sleep -Seconds 15
        $s = Get-Status
        if (-not $s) { continue }
        if ($s.perf.diff -ne $null) { $diffs += [double]$s.perf.diff }
        if ($s.proc.worldserver.ramMB) { $rams += [double]$s.proc.worldserver.ramMB }
        $online = [int]$s.botsOnline; $players = [int]$s.playersOnline
        $c = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -eq '_Total' }
        if ($c) { $cpus += [double]$c.PercentProcessorTime }
    }

    if ($diffs.Count -eq 0) {
        W "no samples collected at $target - panel unreachable?"
        Add-Content $csv "$target,$online,$players,,,,,,no samples"
        continue
    }

    $sorted = $diffs | Sort-Object
    $avg = [math]::Round(($diffs | Measure-Object -Average).Average, 1)
    $p95 = [math]::Round($sorted[[math]::Min([int][math]::Floor($sorted.Count * 0.95), $sorted.Count - 1)], 1)
    $max = [math]::Round(($diffs | Measure-Object -Maximum).Maximum, 1)
    $ram = if ($rams.Count) { [math]::Round(($rams | Measure-Object -Average).Average, 0) } else { 0 }
    $cpu = if ($cpus.Count) { [math]::Round(($cpus | Measure-Object -Average).Average, 0) } else { 0 }

    # 100ms is where a world update starts being visible as delay in the client.
    $verdict = if ($p95 -lt 50) { 'comfortable' } elseif ($p95 -lt 100) { 'workable' } else { 'over budget' }

    W "RESULT $target bots: online=$online avg=${avg}ms p95=${p95}ms max=${max}ms ram=${ram}MB cpu=${cpu}% -> $verdict"
    Add-Content $csv "$target,$online,$players,$avg,$p95,$max,$ram,$cpu,$verdict"

    if ($p95 -ge 100) { W "p95 over budget - stopping before the next step"; break }
}

W ""
W "=== sweep done. Results in $csv ==="
