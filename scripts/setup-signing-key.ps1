<#
  Create the release signing key. Run once, ever.

  The PowerShell twin of setup-signing-key.sh, and on Windows it is the one to
  use. Typing `bash` there resolves to WSL, not to Git Bash — a different
  machine with a different $HOME, so the key lands somewhere the Windows-side
  scripts cannot see and everything afterwards reports "no signing key" while a
  key plainly exists.

  Two Windows-specific things this handles, both of which stop gpg dead:

  1. gpg is usually not on PATH. Git for Windows ships one under its own
     install directory, wherever that was put.

  2. Git for Windows' gpg writes `use-keyboxd` into ~/.gnupg/common.conf, which
     makes every later run require the keyboxd daemon. gpg then looks for it at
     the POSIX path /usr/lib/gnupg/keyboxd, which only resolves inside the MSYS
     environment — so it works in Git Bash and fails from PowerShell, from Node,
     and from anything the release scripts actually run under.

     The fix is not to edit the user's global GnuPG configuration. This project
     gets its own GNUPGHOME under ~/.aevistle, beside the Android signing key,
     with a config that does not ask for a daemon. Nothing outside this project
     changes, and the key travels with the rest of the key material.

  Why this is separate from the release flow: generating a private key must not
  be repeatable by accident. A second key produces releases signed with
  something other than the published fingerprint, which looks exactly like the
  compromise a signature exists to reveal.

  Everything after this is automatic:
    npm run release:sign -- v0.1.6    sign, verify, publish
    npm run check:signing             fail if a published release is unsigned
#>

$ErrorActionPreference = 'Stop'

$homeDir  = Join-Path $HOME '.aevistle'
$gnupgDir = Join-Path $homeDir 'gnupg'
$props    = Join-Path $homeDir 'gpg.properties'
$name     = 'Aevistle Release Signing'
# The GitHub noreply address on purpose: a GPG uid is published to everyone who
# ever verifies a download, and the real address is a privacy red line here.
$email    = '199806313+Fusheng201@users.noreply.github.com'

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
    $git = (Get-Command git -ErrorAction SilentlyContinue).Source
    if ($git) { $candidates += Join-Path (Split-Path (Split-Path $git)) 'usr\bin\gpg.exe' }
    $gpg = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $gpg) {
    Write-Error 'gpg not found. It ships with Git for Windows (usr\bin\gpg.exe) or Gpg4win.'
    exit 1
}

# --- a GNUPGHOME of our own --------------------------------------------------

New-Item -ItemType Directory -Force -Path $gnupgDir | Out-Null
# Permissions matter to gpg itself: it refuses to use a home directory other
# people can read, and says so in a way that reads like a different problem.
try {
    $acl = Get-Acl $gnupgDir
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $env:USERNAME, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    Set-Acl -Path $gnupgDir -AclObject $acl
} catch {
    Write-Output "  (could not tighten permissions on $gnupgDir — continuing)"
}

# Empty rather than absent: an empty common.conf is what stops gpg writing
# `use-keyboxd` into it on first use, which is the whole problem being avoided.
Set-Content -Path (Join-Path $gnupgDir 'common.conf') -Value '' -Encoding ascii

# --- the path gpg will actually understand -----------------------------------
#
# Git for Windows' gpg is an MSYS binary. Handed a Windows absolute path it does
# not recognise one — it reads it as a *relative* POSIX path and prepends the
# working directory, producing something like
# `/d/Documents/.../C:\Users\<name>\.aevistle\gnupg` and a "No such file or
# directory" naming a path nobody asked for. It wants `/c/Users/...`.
#
# Applied only to that build: Gpg4win takes Windows paths natively.

function ConvertTo-GpgPath([string] $WindowsPath, [string] $GpgExe) {
    if ($GpgExe -notlike '*\Git\*' -and $GpgExe -notlike '*\usr\bin\*') { return $WindowsPath }
    $full = [System.IO.Path]::GetFullPath($WindowsPath)
    if ($full -match '^([A-Za-z]):[\\/](.*)$') {
        return '/' + $Matches[1].ToLower() + '/' + ($Matches[2] -replace '\\', '/')
    }
    return $WindowsPath
}

$gnupgArg = ConvertTo-GpgPath $gnupgDir $gpg

Write-Output "Using $gpg"
Write-Output "Key home: $gnupgDir"
if ($gnupgArg -ne $gnupgDir) { Write-Output "  (given to gpg as $gnupgArg)" }
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
    & $gpg --homedir $gnupgArg --batch --gen-key $paramsFile
    if ($LASTEXITCODE -ne 0) { throw "gpg --gen-key failed with exit code $LASTEXITCODE" }
} finally {
    Remove-Item $paramsFile -Force -ErrorAction SilentlyContinue
}

$fpr = (& $gpg --homedir $gnupgArg --list-keys --with-colons $email |
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
gnupghome=$gnupgDir
"@ | Set-Content -Path $props -Encoding utf8

# An armoured backup of the secret key, so losing the GnuPG home does not mean
# losing the ability to sign.
& $gpg --homedir $gnupgArg --batch --yes --pinentry-mode loopback --passphrase $pass `
       --export-secret-keys --armor $fpr |
    Set-Content -Path (Join-Path $homeDir 'aevistle-signing-key.asc') -Encoding ascii
& $gpg --homedir $gnupgArg --armor --export $fpr |
    Set-Content -Path (Join-Path $homeDir 'aevistle-public-key.asc') -Encoding ascii

Write-Output ''
Write-Output 'Done. Fingerprint:'
Write-Output "  $fpr"
Write-Output ''
Write-Output "Written to ${homeDir}:"
Write-Output '  gpg.properties            fingerprint, passphrase, key home'
Write-Output '  gnupg\                    this project''s own GnuPG home'
Write-Output '  aevistle-signing-key.asc  encrypted backup of the private key'
Write-Output '  aevistle-public-key.asc   the public half, published with each release'
Write-Output ''
Write-Output 'Nothing else needs doing. Tell Claude, and the release signs itself.'
