# Phase 4.5 - runs ELEVATED. Points the production hostname at this machine.
$log   = 'C:\Users\DomiJesusa\Desktop\wow\setup\03-hosts-entry.log'
$hosts = "$env:SystemRoot\System32\drivers\etc\hosts"
function W($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding utf8 }

Set-Content -Path $log -Value "=== Phase 4.5 hosts entry ===" -Encoding utf8

# Back up before touching a system file.
$backup = 'C:\Users\DomiJesusa\Desktop\wow\setup\hosts.backup'
Copy-Item -Path $hosts -Destination $backup -Force
W "backed up original hosts -> $backup"

$existing = Get-Content $hosts
W ("original line count: " + $existing.Count)

if ($existing -match 'furryofmadness') {
    W "furryofmadness entries ALREADY present - not appending again"
} else {
    $block = @(
        ''
        '# --- AzerothCore dev server (added by Claude, Phase 4.5) ---'
        '# Lets the server + client use the production hostname locally.'
        '# Going public = point real DNS at your edge and remove these two lines.'
        '127.0.0.1       logon.furryofmadness.com'
        '127.0.0.1       furryofmadness.com'
    )
    Add-Content -Path $hosts -Value $block -Encoding ascii
    W "appended 2 host entries"
}

# Flush the resolver so the change takes effect immediately.
ipconfig /flushdns | Out-Null
W "dns cache flushed"

foreach ($n in @('logon.furryofmadness.com','furryofmadness.com')) {
    try {
        $r = Resolve-DnsName -Name $n -ErrorAction Stop | Where-Object { $_.IPAddress }
        W ("$n -> " + (($r.IPAddress) -join ', '))
    } catch { W "$n -> RESOLVE FAILED: $($_.Exception.Message)" }
}
W "=== done ==="
