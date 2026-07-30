# Phase 6 - the no-client verification battery.
# Everything here is provable WITHOUT a WoW client. Read-only: it never writes
# to the databases or the server tree.
$srv   = 'C:\Users\DomiJesusa\Desktop\wow\server'
$mysql = 'C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe'
$log   = 'C:\Users\DomiJesusa\Desktop\wow\setup\05-verify.log'
function W($m) { $l = $m; Write-Output $l; Add-Content -Path $log -Value $l -Encoding utf8 }
function Q($sql) { & $mysql -u acore -pacore --protocol=tcp -h 127.0.0.1 -N -B -e $sql 2>$null }

Set-Content -Path $log -Value ("=== Phase 6 verification  " + (Get-Date)) -Encoding utf8

W "`n--- 1. binaries + runtime DLLs present ---"
foreach ($f in @('worldserver.exe','authserver.exe','dbimport.exe','libmysql.dll','libcrypto-3-x64.dll','libssl-3-x64.dll')) {
    W ("  {0,-22} {1}" -f $f, $(if (Test-Path (Join-Path $srv $f)) { 'OK' } else { 'MISSING' }))
}

W "`n--- 2. world DB populated (expected magnitudes from the shipped dumps) ---"
$checks = @(
    @{ t='creature_template';   db='acore_world'; min=29947 },
    @{ t='item_template';       db='acore_world'; min=46096 },
    @{ t='gameobject_template'; db='acore_world'; min=21581 },
    @{ t='quest_template';      db='acore_world'; min=9464  },
    @{ t='creature';            db='acore_world'; min=149879}
)
foreach ($c in $checks) {
    $n = (Q "SELECT COUNT(*) FROM $($c.db).$($c.t);")
    $v = 0; [void][int]::TryParse("$n", [ref]$v)
    W ("  {0,-20} {1,8}   expected >= {2,-8} {3}" -f $c.t, $n, $c.min, $(if ($v -ge $c.min) { 'OK' } else { 'LOW/EMPTY' }))
}

W "`n--- 3. all four databases have an updates table (proves auto-populate ran) ---"
foreach ($db in @('acore_auth','acore_characters','acore_world','acore_playerbots')) {
    $n = (Q "SELECT COUNT(*) FROM $db.updates;")
    W ("  {0,-18} updates rows = {1}" -f $db, $(if ($n) { $n } else { 'NO updates TABLE' }))
}
W ("  playerbots_names   = " + (Q "SELECT COUNT(*) FROM acore_characters.playerbots_names;") + "   (expect 100000)")
W ("  world db_version   = " + (Q "SELECT db_version FROM acore_world.version LIMIT 1;"))

W "`n--- 4. realmlist row (address must be reachable BY THE CLIENT) ---"
Q "SELECT id,name,address,localAddress,localSubnetMask,port,gamebuild FROM acore_auth.realmlist;" | ForEach-Object { W ("  " + $_) }

W "`n--- 5. hostname resolution (the hosts entry is load-bearing) ---"
foreach ($h in @('logon.furryofmadness.com','furryofmadness.com')) {
    try { $r = (Resolve-DnsName $h -ErrorAction Stop | Where-Object IPAddress).IPAddress -join ',' ; W ("  {0,-26} -> {1}" -f $h, $r) }
    catch { W ("  {0,-26} -> RESOLVE FAILED (realm would silently vanish)" -f $h) }
}

W "`n--- 6. TCP listeners ---"
foreach ($p in @(3724, 8085)) {
    $t = Test-NetConnection -ComputerName 127.0.0.1 -Port $p -WarningAction SilentlyContinue
    W ("  port {0}  TcpTestSucceeded = {1}" -f $p, $t.TcpTestSucceeded)
}
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in 3724,8085,3443,7878,8888 } |
    ForEach-Object { W ("  listening {0}:{1}  pid {2} ({3})" -f $_.LocalAddress, $_.LocalPort, $_.OwningProcess, (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName) }

W "`n--- 7. GM account ---"
Q "SELECT a.id, a.username, IFNULL(aa.gmlevel,'NONE'), IFNULL(aa.RealmID,'NONE') FROM acore_auth.account a LEFT JOIN acore_auth.account_access aa ON aa.id=a.id;" |
    ForEach-Object { W ("  " + $_) }
W "  (expect gmlevel=3 and RealmID=-1 for the admin account)"

W "`n--- 8. startup log scan for the known failure strings ---"
$sl = Join-Path $srv 'logs\Server.log'
if (Test-Path $sl) {
    $pat = 'Incorrect DataDir|not found by path|not found or not compatible|_outdated_ DBC|Failed to find map files|incompatible map version|Applying of file .* failed'
    $hits = Select-String -Path $sl -Pattern $pat -ErrorAction SilentlyContinue
    if ($hits) { $hits | Select-Object -First 10 | ForEach-Object { W ("  !! " + $_.Line) } } else { W "  no known failure strings found" }
    $ok = Select-String -Path $sl -Pattern 'World Initialized in|Using DataDir|playerbots.conf' -ErrorAction SilentlyContinue
    $ok | Select-Object -Last 6 | ForEach-Object { W ("  ok " + $_.Line.Trim()) }
} else { W "  Server.log not present yet" }

W "`n=== done ==="
