# Build AzerothCore-HUD.exe.
#
# No Visual Studio or SDK needed: csc.exe ships with the .NET Framework that is
# already part of Windows. That is why the HUD is plain WinForms - it must build
# on a fresh machine with nothing installed.
#
# The exe is gitignored, so this MUST be run once after cloning on a new box.

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$BASE = Split-Path (Split-Path $here -Parent) -Parent   # hud-launcher -> panel -> wow
$out  = Join-Path $BASE 'AzerothCore-HUD.exe'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc - is .NET Framework 4.x present?" }

if (Get-Process -Name 'AzerothCore-HUD' -ErrorAction SilentlyContinue) {
    Write-Output "HUD is running - stopping it so the exe can be replaced"
    Stop-Process -Name 'AzerothCore-HUD' -Force
    Start-Sleep -Seconds 2
}

$refs = @(
    '/reference:System.dll'
    '/reference:System.Windows.Forms.dll'
    '/reference:System.Drawing.dll'
    '/reference:System.Web.Extensions.dll'
    '/reference:System.Core.dll'
)

& $csc /nologo /target:winexe /optimize+ "/out:$out" $refs (Join-Path $here 'HudGui.cs')
if ($LASTEXITCODE -ne 0) { throw "compile failed" }

Write-Output ("built {0} ({1:N0} bytes)" -f $out, (Get-Item $out).Length)
Write-Output "The HUD finds panel\server.js by walking up from its own location - no path to edit."
