<#
  Create the release signing key. Run once, ever.

  The PowerShell twin of setup-signing-key.sh, and on Windows it is the one to
  use. Typing `bash` there resolves to WSL, not to Git Bash — a different
  machine with a different $HOME, so the key lands somewhere the Windows-side
  scripts cannot see and everything afterwards reports "no signing key" while a
  key plainly exists.

  gpg itself is usually not on PATH in PowerShell. Git for Windows ships one
  under its own install directory, wherever that was put; this looks there.

  Why this is separate from the release flow: generating a private key must not
  be repeatable by accident. A second key produces releases signed with
  something other than the published fingerprint, which looks exactly like the
  compromise a signature exists to reveal.

  Everything after this is automatic:
    npm run release:sign -- v0.1.6    sign, verify, publish
    npm run check:signing             fail if a published release is unsigned
#>

$ErrorActionPreference = 'Stop'

$homeDir = Join-Path $HOME '.aevistle'
$props   = Join-Path $homeDir 'gpg.properties'
$name    = 'Aevistle Release Signing'
# The GitHub noreply address on purpose: a GPG uid is published to everyone who
# ever verifies a download, and the real address is a privacy red line here.
$email   = '199806313+Fusheng201@users.noreply.github.com'

New-Item -ItemType Directory -Force -Path $homeDir | Out-Null

if (Test-Path $props) {
    Write-Output 'A signing key already exists:'
    Select-String -Path $props -Pattern '^fingerprint=' | ForEach-Object { "  $($_.Line)" }
    Write-Output ''
    Write-Output 'Refusing to generate a second one. Every release signed with the old key'
    Write-Output 'becomes unverifiable against a new fingerprint.'
    exit 0
}

# --- find gpg ---------------------------------------------------------------

$gpg = (Get-Command gpg -ErrorAction SilentlyContinue).Source
if (-not $gpg) {
    $candidates = @()
    foreach ($d in 'C', 'D', 'E') {
        $candidates += "${d}:\Program Files\Git\usr\bin\gpg.exe"
        $candidates += "${d}:\Program Files (x86)\Git\usr\bin\gpg.exe"
        $candidates += "${d}:\Program Files\GnuPG\bin\gpg.exe"
        $candidates += "${d}:\APPS\Git\usr\bin\gpg.exe"
    }
    # Last resort: look beside git itself, which covers an install nobody would
    # guess the path of.
    $git = (Get-Command git -ErrorAction SilentlyContinue).Source
    if ($git) {
        $candidates += Join-Path (Split-Path (Split-Path $git)) 'usr\bin\gpg.exe'
    }
    $gpg = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $gpg) {
    Write-Error 'gpg not found. It ships with Git for Windows (usr\bin\gpg.exe) or Gpg4win.'
    exit 1
}
Write-Output "Using $gpg"
Write-Output 'Generating a 4096-bit RSA signing key. This takes a minute or two.'

# --- passphrase --------------------------------------------------------------
# 32 bytes from the OS CSPRNG, base64. Same shape and strength as the keystore
# passphrase already sitting in this directory.

$bytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$pass = [Convert]::ToBase64String($bytes).TrimEnd('=')

$paramsFile = Join-Path ([System.IO.Path]::GetTempPath()) "aevistle-gpg-$([guid]::NewGuid()).txt"
@"
%echo Generating Aevistle release signing key
Key-Type: RSA
Key-Length: 4096
Key-Usage: sign
Name-Real: $name
Name-Email: $email
Expire-Date: 5y
Passphrase: $pass
%commit
"@ | Set-Content -Path $paramsFile -Encoding utf8

try {
    & $gpg --batch --gen-key $paramsFile
    if ($LASTEXITCODE -ne 0) { throw "gpg --gen-key failed with exit code $LASTEXITCODE" }
} finally {
    Remove-Item $paramsFile -Force -ErrorAction SilentlyContinue
}

$fpr = (& $gpg --list-keys --with-colons $email |
        Where-Object { $_ -like 'fpr:*' } |
        Select-Object -First 1).Split(':')[9]
if (-not $fpr) { Write-Error 'Could not read the fingerprint back — generation failed.'; exit 1 }

# --- record it ---------------------------------------------------------------

@"
# Aevistle release signing key.
#
# Never commit this file. It lives here rather than in the repository for the
# same reason aevistle-release.jks does — this directory is outside the working
# tree, so git cannot see it at all.
fingerprint=$fpr
passphrase=$pass
uid=$name <$email>
"@ | Set-Content -Path $props -Encoding utf8

# An armoured backup of the secret key, so losing the GnuPG home does not mean
# losing the ability to sign.
& $gpg --batch --yes --pinentry-mode loopback --passphrase $pass `
       --export-secret-keys --armor $fpr |
    Set-Content -Path (Join-Path $homeDir 'aevistle-signing-key.asc') -Encoding ascii
& $gpg --armor --export $fpr |
    Set-Content -Path (Join-Path $homeDir 'aevistle-public-key.asc') -Encoding ascii

Write-Output ''
Write-Output 'Done. Fingerprint:'
Write-Output "  $fpr"
Write-Output ''
Write-Output "Written to ${homeDir}:"
Write-Output '  gpg.properties            fingerprint + passphrase'
Write-Output '  aevistle-signing-key.asc  encrypted backup of the private key'
Write-Output '  aevistle-public-key.asc   the public half, published with each release'
Write-Output ''
Write-Output 'Nothing else needs doing. Tell Claude, and the release signs itself.'
