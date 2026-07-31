# Pulls what the other machine pushed and applies exactly what changed.
#
# Two people, one server. Whoever is not hosting fixes things, commits, pushes;
# the host runs this. The point is that "apply it" means something different for
# every kind of change, and forgetting which is how a fix looks applied while the
# server keeps running the old behaviour:
#
#   server-settings.conf  -> replay onto the live .conf files, restart
#   setup/sql/**          -> run once against the database, server must be down
#   setup/patches/**      -> the C++ changed; needs a rebuild, which this will
#                            NOT do silently because it takes half an hour
#   panel/, cloud/        -> restart that service
#   the website           -> deploy, which happens from wherever, not here
#
#   powershell -ExecutionPolicy Bypass -File setup\pull-and-apply.ps1
#   ... -DryRun    pull and report, change nothing

param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$BASE = Split-Path $PSScriptRoot -Parent
Set-Location $BASE

function Say($m)  { Write-Host $m }
function Head($m) { Write-Host "`n$m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "  $m" -ForegroundColor Yellow }
function Good($m) { Write-Host "  $m" -ForegroundColor Green }

Head "1. Дърпам от git"

$dirty = git status --porcelain
if ($dirty) {
    Warn "има непокоммитнати промени тук:"
    $dirty -split "`n" | Select-Object -First 10 | ForEach-Object { Warn "    $_" }
    Warn "rebase върху тях ще спре по средата. Коммитни ги или ги остави настрани първо."
    exit 1
}

$before = (git rev-parse HEAD).Trim()
git pull --rebase
if ($LASTEXITCODE -ne 0) { Warn "git pull се провали - оправи го и пусни пак"; exit 1 }
$after = (git rev-parse HEAD).Trim()

if ($before -eq $after) {
    Good "няма нищо ново"
    $changed = @()
} else {
    $changed = @(git diff --name-only $before $after)
    Good "$($changed.Count) променени файла:"
    git log --oneline "$before..$after" | ForEach-Object { Say "    $_" }
}

$hit = { param($pattern) @($changed | Where-Object { $_ -match $pattern }).Count -gt 0 }

$needSettings = & $hit 'setup/server-settings\.conf'
$needSql      = & $hit '^setup/sql/'
$needBuild    = & $hit '^setup/patches/'
# source\ is gitignored, so a new module arrives as a line in this manifest, not
# as files. Miss it and the module is simply absent - the server boots happily
# and just does not have the feature.
$needModules  = & $hit 'setup/modules\.txt'
$needPanel    = & $hit '^panel/'
$needApi      = & $hit '^cloud/home-api/'
$needAgent    = & $hit '^cloud/agent/'
$needSite     = & $hit '^cloud/web/'

if (-not ($needSettings -or $needSql -or $needBuild -or $needModules -or $needPanel -or $needApi -or $needAgent -or $needSite)) {
    Head "Нищо за прилагане"
    Good "промените не засягат нищо, което се пуска на тази машина"
    exit 0
}

Head "2. Какво трябва да се направи"
if ($needBuild)    { Warn "пач по C++ кода  -> ИСКА ПОСТРОЯВАНЕ НАНОВО (не се прави оттук)" }
if ($needModules)  { Warn "списъкът с модули се промени -> apply-modules.ps1 + ПОСТРОЯВАНЕ" }
if ($needSql)      { Say  "  промени по базата -> apply-sql.ps1 (сървърът трябва да е спрян)" }
if ($needSettings) { Say  "  настройки        -> apply-settings.ps1 + рестарт" }
if ($needPanel)    { Say  "  панел            -> npm install + рестарт на панела" }
if ($needApi)      { Say  "  играчко API      -> npm install + рестарт" }
if ($needAgent)    { Say  "  облачен агент    -> npm install + рестарт" }
if ($needSite)     { Say  "  сайт             -> деплой (от папката на сайта, не оттук)" }

if ($DryRun) { Head "-DryRun: нищо не е променено"; exit 0 }

# Before anything else: cloning a module touches no running process, and knowing
# a rebuild is due changes what the rest of this run is worth doing.
if ($needModules) {
    Head "Синхронизирам модулите със setup\modules.txt"
    & "$PSScriptRoot\apply-modules.ps1"
    $modCode = $LASTEXITCODE
    if ($modCode -eq 10) {
        $needBuild = $true
        Warn "модулите се промениха -> ИСКА ПОСТРОЯВАНЕ НАНОВО, иначе новото не съществува"
    }
    elseif ($modCode -ne 0) { Warn "apply-modules се провали"; exit 1 }
}

$mustStop = $needSql -or $needSettings
if ($mustStop -and (Get-Process worldserver -ErrorAction SilentlyContinue)) {
    Head "3. Спирам света"
    'server shutdown 1' | Set-Content "$BASE\server\cmd.txt" -Encoding ascii
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Process worldserver -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep 3 }
    Get-Process worldserver -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-Process authserver  -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep 3
    Good "спрян"
    $restartNeeded = $true
}

if ($needSql) {
    Head "Прилагам промените по базата"
    & "$PSScriptRoot\apply-sql.ps1"
    if ($LASTEXITCODE -ne 0) { Warn "apply-sql се провали - сървърът остава спрян нарочно"; exit 1 }
}

if ($needSettings) {
    Head "Прилагам настройките"
    & "$PSScriptRoot\apply-settings.ps1"
    if ($LASTEXITCODE -ne 0) { Warn "apply-settings се провали"; exit 1 }
}

foreach ($svc in @(
    @{ On = $needPanel; Dir = "$BASE\panel";           Port = 8080; Name = 'панел' },
    @{ On = $needApi;   Dir = "$BASE\cloud\home-api";  Port = 8091; Name = 'играчко API' },
    @{ On = $needAgent; Dir = "$BASE\cloud\agent";     Port = 0;    Name = 'облачен агент' }
)) {
    if (-not $svc.On) { continue }
    Head "Обновявам $($svc.Name)"
    Push-Location $svc.Dir
    npm install --no-audit --no-fund 2>&1 | Select-Object -Last 1
    Pop-Location
    # Only this service's process: matched by its own folder, so restarting the
    # panel never takes the API down with it.
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$($svc.Dir)*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep 2
    Start-Process node.exe -ArgumentList 'server.js' -WorkingDirectory $svc.Dir -WindowStyle Hidden `
        -RedirectStandardOutput "$($svc.Dir)\service.log" -RedirectStandardError "$($svc.Dir)\service.err"
    Start-Sleep 3
    if ($svc.Port -gt 0) {
        if (Get-NetTCPConnection -State Listen -LocalPort $svc.Port -ErrorAction SilentlyContinue) {
            Good "$($svc.Name) слуша на $($svc.Port)"
        } else {
            Warn "$($svc.Name) НЕ тръгна - виж $($svc.Dir)\service.err"
        }
    } else { Good "$($svc.Name) рестартиран" }
}

if ($restartNeeded) {
    Head "Пускам сървъра наново"
    & "$BASE\START-SERVER.ps1"
}

Head "Готово"
if ($needModules) {
    Warn "ВНИМАНИЕ: списъкът с модули се промени. Редът е важен:"
    Warn "  1. cd build ; cmake . ; cmake --build . --config RelWithDebInfo --parallel 1"
    Warn "  2. cmake --build . --config RelWithDebInfo --target install   (сървърът СПРЯН)"
    Warn "  3. .\setup\apply-settings.ps1        <- ПУСНИ ГО ПАК СЛЕД ПОСТРОЯВАНЕТО"
    Warn ""
    Warn "Точка 3 не е излишна: настройките на нов модул току-що бяха ПРОПУСНАТИ,"
    Warn "защото .conf.dist се появява едва при install. Без второто пускане модулът"
    Warn "тръгва с вградените си стойности и изглежда настроен, без да е."
}
if ($needBuild) {
    Warn "ВНИМАНИЕ: има нов пач по C++ кода, а той НЕ е приложен."
    Warn "Докато не се построи наново, сървърът върви със стария код:"
    Warn "  cd source\modules\mod-playerbots"
    Warn "  git apply --ignore-space-change ..\..\..\setup\patches\<новият>.patch"
    Warn "  после построяване по MIGRATION.md, раздел 2.4"
}
if ($needSite) {
    Warn "Сайтът е променен - деплойва се от неговата папка, не оттук."
}
