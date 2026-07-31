# Make source\modules\ match setup\modules.txt.
#
#   .\apply-modules.ps1            clone what is missing, check out the right commits
#   .\apply-modules.ps1 -DryRun    report only
#
# WHY THIS EXISTS
#   source\ is gitignored - it is someone else's code and gigabytes of it - so
#   modules cannot travel through git as files. The manifest travels instead,
#   and this replays it. Without this, someone adds a module on one machine, the
#   host pulls, sees nothing new under source\, and the module silently is not
#   there: the server boots fine and just does not have the feature.
#
# EXIT CODES
#   0  nothing changed
#   10 something changed -> A REBUILD IS REQUIRED
#   1  error

param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$BASE = Split-Path $PSScriptRoot -Parent
$modRoot = Join-Path $BASE 'source\modules'
$manifest = Join-Path $PSScriptRoot 'modules.txt'

if (-not (Test-Path $manifest)) { throw "missing $manifest" }
if (-not (Test-Path (Join-Path $BASE 'source'))) {
    throw "source\ does not exist. Clone the core first - see NOVA-MASHINA.md section 4.1"
}
New-Item -ItemType Directory -Force -Path $modRoot | Out-Null

$git = 'git'
if (Test-Path 'C:\Program Files\Git\cmd\git.exe') { $git = 'C:\Program Files\Git\cmd\git.exe' }

$wanted = @()
foreach ($line in [System.IO.File]::ReadAllLines($manifest)) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $parts = $t -split '\s*\|\s*'
    if ($parts.Count -ne 3) { throw "bad line in modules.txt: $t" }
    $wanted += @{ folder = $parts[0].Trim(); url = $parts[1].Trim(); commit = $parts[2].Trim() }
}

$changed = 0

foreach ($m in $wanted) {
    $path = Join-Path $modRoot $m.folder
    Write-Output ""
    Write-Output "[$($m.folder)]"

    if (-not (Test-Path (Join-Path $path '.git'))) {
        Write-Output "  not present"
        if ($DryRun) { Write-Output "  would clone $($m.url)"; $changed++; continue }
        Write-Output "  cloning $($m.url) ..."
        & $git clone -q $m.url $path
        if ($LASTEXITCODE -ne 0) { throw "clone failed for $($m.folder)" }
        & $git -C $path checkout -q $m.commit
        if ($LASTEXITCODE -ne 0) { throw "checkout $($m.commit) failed for $($m.folder)" }
        Write-Output "  cloned at $($m.commit.Substring(0,10))"
        $changed++
        continue
    }

    $head = (& $git -C $path rev-parse HEAD).Trim()
    if ($head -eq $m.commit) {
        Write-Output "  already at $($m.commit.Substring(0,10))"
        continue
    }

    # A dirty tree means local edits - most likely one of setup\patches\ applied
    # on top. Checking out would silently throw that work away, so refuse.
    $dirty = & $git -C $path status --porcelain
    if ($dirty) {
        Write-Warning "  has LOCAL MODIFICATIONS - not touching it."
        Write-Warning "  Wanted $($m.commit.Substring(0,10)), currently $($head.Substring(0,10))."
        Write-Warning "  These are probably setup\patches\ applied on top. Resolve by hand:"
        $dirty | ForEach-Object { Write-Warning "     $_" }
        continue
    }

    Write-Output "  at $($head.Substring(0,10)), want $($m.commit.Substring(0,10))"
    if ($DryRun) { Write-Output "  would fetch + checkout"; $changed++; continue }
    & $git -C $path fetch -q --all
    & $git -C $path checkout -q $m.commit
    if ($LASTEXITCODE -ne 0) { throw "checkout $($m.commit) failed for $($m.folder)" }
    Write-Output "  now at $($m.commit.Substring(0,10))"
    $changed++
}

# Anything present on disk but absent from the manifest is reported, never
# deleted - removing a module is a decision, not a side effect of running this.
Write-Output ""
$known = $wanted | ForEach-Object { $_.folder }
foreach ($d in (Get-ChildItem $modRoot -Directory -ErrorAction SilentlyContinue)) {
    if ($d.Name -eq 'CMakeLists.txt') { continue }
    if ($known -notcontains $d.Name) {
        Write-Warning "$($d.Name) is on disk but NOT in modules.txt - it is still being built in."
        Write-Warning "  Add it to the manifest, or delete the folder and rebuild."
    }
}

Write-Output ""
if ($changed -eq 0) {
    Write-Output "modules already match the manifest - no rebuild needed"
    exit 0
}

Write-Output "$changed module(s) changed."
Write-Output ""
Write-Output "A REBUILD IS REQUIRED. The module list is a file(GLOB) with no"
Write-Output "CONFIGURE_DEPENDS, so creating a folder does not re-run CMake by itself:"
Write-Output ""
Write-Output '  $env:PATH="C:\Program Files\Git\cmd;C:\Program Files\CMake\bin;$env:PATH"'
Write-Output "  cd $BASE\build"
Write-Output "  cmake .                                             # picks up the new folder"
Write-Output "  cmake --build . --config RelWithDebInfo --parallel 1"
Write-Output "  cmake --build . --config RelWithDebInfo --target install   # server must be STOPPED"
Write-Output ""
Write-Output "Then copy the module's .conf.dist to a .conf and run apply-settings.ps1 -"
Write-Output "a .conf.dist is NEVER read, so the module would run on its built-in defaults."
exit 10
