# Phase LAN - runs ELEVATED. Allows other machines on the local subnet to reach
# the auth (3724) and world (8085) servers.
#
# Deliberately narrow:
#   - bound to the two specific executables, not the ports globally
#   - RemoteAddress = LocalSubnet, so this does NOT expose anything to the
#     internet even though the Wi-Fi is classified "Public"
#   - no router port-forwarding is touched; this is LAN-only
$BASE = Split-Path $PSScriptRoot -Parent   # wow\ - derived, so this script survives a machine move

$log = "$BASE\setup\06-firewall-lan.log"
$srv = "$BASE\server"
function W($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding utf8 }

Set-Content -Path $log -Value "=== LAN firewall rules ===" -Encoding utf8
W ("Elevated: " + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))

$rules = @(
    @{ Name = 'AzerothCore authserver (TCP 3724)';  Port = 3724; Exe = "$srv\authserver.exe" },
    @{ Name = 'AzerothCore worldserver (TCP 8085)'; Port = 8085; Exe = "$srv\worldserver.exe" }
)

foreach ($r in $rules) {
    Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    try {
        New-NetFirewallRule -DisplayName $r.Name `
            -Direction Inbound -Action Allow -Protocol TCP `
            -LocalPort $r.Port -Program $r.Exe `
            -RemoteAddress LocalSubnet `
            -Profile Any -Enabled True | Out-Null
        W ("created: {0}  port {1}  scope LocalSubnet" -f $r.Name, $r.Port)
    } catch { W ("FAILED {0}: {1}" -f $r.Name, $_.Exception.Message) }
}

W "--- resulting rules ---"
foreach ($r in $rules) {
    $fr = Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
    if ($fr) {
        $pf = $fr | Get-NetFirewallPortFilter
        $af = $fr | Get-NetFirewallAddressFilter
        W ("  {0} | enabled={1} action={2} port={3} remote={4}" -f $fr.DisplayName, $fr.Enabled, $fr.Action, $pf.LocalPort, $af.RemoteAddress)
    } else { W ("  {0} MISSING" -f $r.Name) }
}
W "=== done ==="
