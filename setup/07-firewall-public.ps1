# Runs ELEVATED. Widens the two AzerothCore rules from LocalSubnet to Any,
# so traffic arriving via router port-forwarding is accepted.
#
# This is the step that actually exposes the server to the internet. Still
# scoped to the two specific executables and the two specific ports - it does
# NOT open the machine generally. MySQL/3306 is untouched and stays on 127.0.0.1.
$BASE = Split-Path $PSScriptRoot -Parent   # wow\ - derived, so this script survives a machine move

$log = "$BASE\setup\07-firewall-public.log"
$srv = "$BASE\server"
function W($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding utf8 }
Set-Content -Path $log -Value "=== widen firewall to Any ===" -Encoding utf8

$rules = @(
    @{ Name = 'AzerothCore authserver (TCP 3724)';  Port = 3724; Exe = "$srv\authserver.exe" },
    @{ Name = 'AzerothCore worldserver (TCP 8085)'; Port = 8085; Exe = "$srv\worldserver.exe" }
)
foreach ($r in $rules) {
    Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    try {
        New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Action Allow -Protocol TCP `
            -LocalPort $r.Port -Program $r.Exe -RemoteAddress Any -Profile Any -Enabled True | Out-Null
        W ("created: {0} port {1} scope Any" -f $r.Name, $r.Port)
    } catch { W ("FAILED {0}: {1}" -f $r.Name, $_.Exception.Message) }
}
W "--- resulting rules ---"
foreach ($r in $rules) {
    $fr = Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
    if ($fr) {
        $pf = $fr | Get-NetFirewallPortFilter; $af = $fr | Get-NetFirewallAddressFilter
        W ("  {0} | enabled={1} port={2} remote={3}" -f $fr.DisplayName, $fr.Enabled, $pf.LocalPort, $af.RemoteAddress)
    }
}
# Sanity: confirm 3306 is NOT allowed inbound by any rule we own.
W ("MySQL 3306 rules owned by us: " + ((Get-NetFirewallRule -DisplayName "AzerothCore*" | Get-NetFirewallPortFilter | Where-Object { $_.LocalPort -eq 3306 } | Measure-Object).Count))
W "=== done ==="
