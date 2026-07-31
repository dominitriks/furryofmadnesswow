# Keeps wow.level8.bg pointed at this machine's public address.
#
# The ISP hands out a dynamic address. Players connect to the hostname, and the
# realmlist row holds the hostname too - so when this script fixes DNS, nothing
# else has to be touched. authserver re-resolves the name every
# RealmsStateUpdateDelay (20s), which is why there is no restart here, unlike
# the MU side where the address is announced once at startup.
#
# Needs a Cloudflare API token with Zone:DNS:Edit on level8.bg. The MU project
# already has one and the two servers share this machine, so it is read from
# there rather than duplicated.

$ErrorActionPreference = 'Stop'

$hostname  = 'wow.level8.bg'
$zoneName  = 'level8.bg'
$tokenFile = 'Z:\MU ONLINE\ops\cloudflare-token.txt'
$stateFile = "$PSScriptRoot\dns-last-ip.txt"
$logFile   = "$PSScriptRoot\dns.log"

function Write-Log($message) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
    $line | Out-File -Append -FilePath $logFile -Encoding utf8
    Write-Output $line
}

if (-not (Test-Path $tokenFile)) { Write-Log "NO TOKEN: $tokenFile missing"; exit 2 }
$token = (Get-Content $tokenFile -Raw).Trim()
if (-not $token) { Write-Log "NO TOKEN: $tokenFile is empty"; exit 2 }

$headers = @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' }

# --- current public address -------------------------------------------------
# Three providers: one being down must not stall the record on a stale address.
$publicIp = $null
foreach ($service in 'https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com') {
    try {
        $candidate = (Invoke-RestMethod -Uri $service -TimeoutSec 15).ToString().Trim()
        if ($candidate -match '^\d{1,3}(\.\d{1,3}){3}$') { $publicIp = $candidate; break }
    } catch { continue }
}
if (-not $publicIp) { Write-Log "could not determine the public address"; exit 3 }

if ((Test-Path $stateFile) -and ((Get-Content $stateFile -Raw).Trim() -eq $publicIp)) {
    Write-Log "unchanged ($publicIp)"
    exit 0
}

# --- zone and record --------------------------------------------------------
try {
    $zone = Invoke-RestMethod -Headers $headers -Method Get `
        -Uri "https://api.cloudflare.com/client/v4/zones?name=$zoneName"
    if (-not $zone.success -or $zone.result.Count -eq 0) {
        Write-Log "zone $zoneName not found - check the token permissions"; exit 4
    }
    $zoneId = $zone.result[0].id

    $record = Invoke-RestMethod -Headers $headers -Method Get `
        -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records?type=A&name=$hostname"

    # proxied stays false. The game speaks its own protocol on raw TCP 3724/8085
    # and Cloudflare's proxy only forwards HTTP - orange-clouding this record
    # makes the realm unreachable, not faster.
    $body = @{ type = 'A'; name = $hostname; content = $publicIp; ttl = 60; proxied = $false } | ConvertTo-Json

    if ($record.result.Count -gt 0) {
        if ($record.result[0].content -eq $publicIp) {
            Set-Content -Path $stateFile -Value $publicIp
            Write-Log "already correct in DNS ($publicIp)"; exit 0
        }
        $result = Invoke-RestMethod -Headers $headers -Method Put -Body $body `
            -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records/$($record.result[0].id)"
        $action = 'updated'
    } else {
        $result = Invoke-RestMethod -Headers $headers -Method Post -Body $body `
            -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records"
        $action = 'created'
    }

    if (-not $result.success) {
        Write-Log "Cloudflare rejected the change: $($result.errors | ConvertTo-Json -Compress)"; exit 5
    }

    Set-Content -Path $stateFile -Value $publicIp
    Write-Log "$action $hostname -> $publicIp"
}
catch { Write-Log "FAILED: $_"; exit 6 }
