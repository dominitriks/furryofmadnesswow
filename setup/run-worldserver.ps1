# Worldserver runner + console relay.
#
# Why this exists: worldserver's CLI thread calls World::StopNow() the moment
# std::getline(std::cin) returns EOF (CliRunnable.cpp:196-201). If we redirect
# stdout the usual way, stdin becomes the null device, EOF fires instantly and
# the server shuts down - potentially mid-import, which permanently corrupts
# the auto-populate (Populate() only runs when SHOW TABLES is empty).
#
# So: keep StandardInput OPEN for the process lifetime and never close it.
# Commands are picked up from cmd.txt so the console stays drivable.

$srv     = 'C:\Users\DomiJesusa\Desktop\wow\server'
$outLog  = "$srv\logs\worldserver-console.log"
$cmdFile = "$srv\cmd.txt"

Remove-Item $cmdFile -ErrorAction SilentlyContinue
"" | Out-File -FilePath $outLog -Encoding utf8

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName               = "$srv\worldserver.exe"
$psi.WorkingDirectory       = $srv          # config path is the RELATIVE "configs/"
$psi.UseShellExecute         = $false
$psi.RedirectStandardInput   = $true
$psi.RedirectStandardOutput  = $true
$psi.RedirectStandardError   = $true
$psi.CreateNoWindow          = $true

$p = New-Object System.Diagnostics.Process
$p.StartInfo = $psi

# Async output pumps so a full pipe buffer can never stall the server.
$sb = New-Object System.Text.StringBuilder
$onOut = {
    if ($EventArgs.Data -ne $null) {
        Add-Content -Path $using:outLog -Value $EventArgs.Data -Encoding utf8
    }
}
Register-ObjectEvent -InputObject $p -EventName OutputDataReceived -Action {
    if ($EventArgs.Data -ne $null) { Add-Content -Path $outLog -Value $EventArgs.Data -Encoding utf8 }
} | Out-Null
Register-ObjectEvent -InputObject $p -EventName ErrorDataReceived -Action {
    if ($EventArgs.Data -ne $null) { Add-Content -Path $outLog -Value ("[stderr] " + $EventArgs.Data) -Encoding utf8 }
} | Out-Null

[void]$p.Start()
$p.BeginOutputReadLine()
$p.BeginErrorReadLine()
Add-Content -Path $outLog -Value ("=== worldserver started pid $($p.Id) at $(Get-Date -Format 'HH:mm:ss') ===") -Encoding utf8

# Relay loop. stdin is never closed, so the CLI never sees EOF.
while (-not $p.HasExited) {
    if (Test-Path $cmdFile) {
        try {
            $cmds = Get-Content $cmdFile -ErrorAction Stop
            Remove-Item $cmdFile -Force -ErrorAction SilentlyContinue
            foreach ($c in $cmds) {
                if ($c -and $c.Trim()) {
                    Add-Content -Path $outLog -Value ">>> $c" -Encoding utf8
                    $p.StandardInput.WriteLine($c)
                    $p.StandardInput.Flush()
                }
            }
        } catch { }
    }
    Start-Sleep -Milliseconds 500
}

Add-Content -Path $outLog -Value ("=== worldserver exited code $($p.ExitCode) at $(Get-Date -Format 'HH:mm:ss') ===") -Encoding utf8
