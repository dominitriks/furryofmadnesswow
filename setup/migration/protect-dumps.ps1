# Encrypt / decrypt the database dumps that travel through the PUBLIC git repo.
#
#   .\protect-dumps.ps1              encrypt  *.sql.gz  ->  *.sql.gz.enc
#   .\protect-dumps.ps1 -Decrypt     decrypt  *.sql.gz.enc -> *.sql.gz
#
# WHY THIS EXISTS
#   acore_auth.account stores each account's SRP6 `salt` and `verifier`. Those
#   are password equivalents: anyone holding them can mount an offline attack on
#   every account, including the GM ones, on a server whose ports 3724/8085 are
#   open to the internet. The table also holds email addresses and last_ip.
#   github.com/dominitriks/furryofmadnesswow is PUBLIC, and a public push is
#   crawled and mirrored within minutes - deleting the file later does not
#   un-publish it, because it stays in the git history and in every clone.
#
#   So the dumps are encrypted before they are committed. The passphrase never
#   enters the repo: it lives in setup\CREDENTIALS.txt, which is gitignored and
#   travels with you separately.
#
# Uses only .NET types built into Windows - nothing to install on the new machine.
#
# Format:  MAGIC(8) | salt(16) | iv(16) | AES-256-CBC ciphertext | HMAC-SHA256(32)
# The HMAC covers magic+salt+iv+ciphertext and is verified BEFORE decrypting, so
# a corrupted or tampered file fails loudly instead of yielding garbage SQL.

param(
    [switch]$Decrypt,
    [string]$Passphrase
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

$MAGIC = [byte[]]@(0x41, 0x43, 0x57, 0x4F, 0x57, 0x45, 0x4E, 0x31)  # "ACWOWEN1"
$ITER  = 200000

function Get-Keys([string]$pass, [byte[]]$salt) {
    $kdf = New-Object System.Security.Cryptography.Rfc2898DeriveBytes(
        $pass, $salt, $ITER, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
    try {
        $all = $kdf.GetBytes(64)
        return @{ Aes = $all[0..31]; Hmac = $all[32..63] }
    } finally { $kdf.Dispose() }
}

if (-not $Passphrase) {
    $sec = Read-Host -AsSecureString ("Passphrase (see CREDENTIALS.txt, section MIGRATION DUMPS)")
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { $Passphrase = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
if ([string]::IsNullOrWhiteSpace($Passphrase)) { throw "no passphrase given" }

$pattern = if ($Decrypt) { '*.sql.gz.enc' } else { '*.sql.gz' }
$files = Get-ChildItem $here -Filter $pattern -File
if ($files.Count -eq 0) { throw "nothing matching $pattern in $here" }

foreach ($f in $files) {
    if ($Decrypt) {
        $raw = [System.IO.File]::ReadAllBytes($f.FullName)
        if ($raw.Length -lt (8 + 16 + 16 + 32)) { throw "$($f.Name) is too short to be valid" }
        for ($i = 0; $i -lt 8; $i++) { if ($raw[$i] -ne $MAGIC[$i]) { throw "$($f.Name) is not a protected dump" } }

        $salt = $raw[8..23]
        $iv   = $raw[24..39]
        $mac  = $raw[($raw.Length - 32)..($raw.Length - 1)]
        $body = $raw[0..($raw.Length - 33)]
        $ct   = $raw[40..($raw.Length - 33)]

        $keys = Get-Keys $Passphrase $salt
        $h = New-Object System.Security.Cryptography.HMACSHA256(, $keys.Hmac)
        $calc = $h.ComputeHash($body); $h.Dispose()
        # Fixed-time compare: never branch out early on a MAC check.
        $diff = 0
        for ($i = 0; $i -lt 32; $i++) { $diff = $diff -bor ($calc[$i] -bxor $mac[$i]) }
        if ($diff -ne 0) { throw "$($f.Name): WRONG PASSPHRASE or the file has been altered" }

        $aes = [System.Security.Cryptography.Aes]::Create()
        $aes.KeySize = 256; $aes.Key = $keys.Aes; $aes.IV = $iv
        $aes.Mode = 'CBC'; $aes.Padding = 'PKCS7'
        $dec = $aes.CreateDecryptor()
        try { $plain = $dec.TransformFinalBlock($ct, 0, $ct.Length) }
        finally { $dec.Dispose(); $aes.Dispose() }

        $out = Join-Path $here ($f.Name -replace '\.enc$', '')
        [System.IO.File]::WriteAllBytes($out, $plain)
        Write-Output ("decrypted {0,-28} -> {1:N2} MB" -f $f.Name, ($plain.Length / 1MB))
    }
    else {
        $plain = [System.IO.File]::ReadAllBytes($f.FullName)
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        $salt = New-Object byte[] 16; $rng.GetBytes($salt)
        $iv   = New-Object byte[] 16; $rng.GetBytes($iv)
        $rng.Dispose()

        $keys = Get-Keys $Passphrase $salt
        $aes = [System.Security.Cryptography.Aes]::Create()
        $aes.KeySize = 256; $aes.Key = $keys.Aes; $aes.IV = $iv
        $aes.Mode = 'CBC'; $aes.Padding = 'PKCS7'
        $enc = $aes.CreateEncryptor()
        try { $ct = $enc.TransformFinalBlock($plain, 0, $plain.Length) }
        finally { $enc.Dispose(); $aes.Dispose() }

        $body = $MAGIC + $salt + $iv + $ct
        $h = New-Object System.Security.Cryptography.HMACSHA256(, $keys.Hmac)
        $mac = $h.ComputeHash($body); $h.Dispose()

        $out = "$($f.FullName).enc"
        [System.IO.File]::WriteAllBytes($out, ($body + $mac))
        Write-Output ("encrypted {0,-28} -> {1}" -f $f.Name, (Split-Path $out -Leaf))
    }
}
