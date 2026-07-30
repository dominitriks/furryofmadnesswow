# Authserver launcher.
#
# authserver has no CliRunnable, so unlike worldserver it has no stdin-EOF
# shutdown hazard and can be launched with plain output redirection.
$srv    = 'C:\Users\DomiJesusa\Desktop\wow\server'
$outLog = "$srv\logs\authserver-console.log"

$p = Start-Process -FilePath "$srv\authserver.exe" `
    -WorkingDirectory $srv `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError "$srv\logs\authserver-console.err" `
    -WindowStyle Hidden -PassThru

"authserver pid $($p.Id) started $(Get-Date -Format 'HH:mm:ss')"
