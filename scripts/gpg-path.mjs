/**
 * Find gpg, wherever this machine keeps it.
 *
 * On Windows it is usually not on PATH. Git for Windows ships one in
 * `<install>/usr/bin`, and that install is wherever the user put it — this
 * machine has it on D:. Gpg4win puts its own under Program Files. A script that
 * just calls `gpg` works in Git Bash, silently fails in PowerShell, and the
 * failure looks like "signing is broken" rather than "the shell could not find
 * the program".
 *
 * Returns an absolute path, or null. Callers must say which it was — a signing
 * step that cannot find gpg has to stop, not skip.
 */

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

/** Drives to look at for a Git for Windows install. */
const DRIVES = ['C', 'D', 'E']

const CANDIDATES = [
  ...DRIVES.flatMap((d) => [
    `${d}:/Program Files/Git/usr/bin/gpg.exe`,
    `${d}:/Program Files (x86)/Git/usr/bin/gpg.exe`,
    `${d}:/Program Files/GnuPG/bin/gpg.exe`,
    `${d}:/Program Files (x86)/GnuPG/bin/gpg.exe`,
    `${d}:/APPS/Git/usr/bin/gpg.exe`,
    `${d}:/Git/usr/bin/gpg.exe`,
  ]),
  '/usr/bin/gpg',
  '/usr/local/bin/gpg',
  '/opt/homebrew/bin/gpg',
]

export function findGpg() {
  // PATH first — if the user has arranged for it, that is the one they mean.
  const probe = spawnSync('gpg', ['--version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (probe.status === 0) {
    /*
     * Resolved to a real path on Windows rather than returned as a bare name.
     *
     * `toGpgPath` has to know *which* gpg this is — the MSYS build wants POSIX
     * paths and Gpg4win wants Windows ones — and a bare "gpg" answers neither
     * question. Returning it unresolved made the conversion silently skip in
     * Git Bash, where the gpg on PATH is precisely the one that needs it.
     */
    if (process.platform !== 'win32') return 'gpg'
    const where = spawnSync('where', ['gpg'], { encoding: 'utf8', shell: true })
    const first = (where.stdout ?? '').split(/\r?\n/).find((l) => l.trim().length > 0)
    return first?.trim() || 'gpg'
  }

  for (const candidate of CANDIDATES) {
    if (existsSync(candidate)) return path.normalize(candidate)
  }

  // Last resort on Windows: ask where git is, and look beside it. Covers an
  // install in a directory nobody would guess.
  if (process.platform === 'win32') {
    const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8', shell: true })
    if (git.status === 0) {
      const guess = path.join(git.stdout.trim(), '..', '..', '..', 'usr', 'bin', 'gpg.exe')
      if (existsSync(guess)) return path.normalize(guess)
    }
  }

  return null
}

export const GPG_HINT =
  'gpg was not found. On Windows it ships with Git for Windows (usr/bin/gpg.exe) ' +
  'or Gpg4win; on macOS `brew install gnupg`; on Debian/Ubuntu `sudo apt install gnupg`.'

/**
 * A path in the form the resolved gpg will understand.
 *
 * Git for Windows' gpg is an MSYS binary and does not recognise a Windows
 * absolute path. Handed `C:\Users\…` it reads a *relative* POSIX path and
 * prepends the working directory, then reports "No such file or directory"
 * naming a path that is a concatenation of two unrelated ones — which reads as
 * a missing directory rather than as a path it never understood.
 *
 * Gpg4win's build takes Windows paths natively, so the conversion is applied
 * only when the binary in use is the MSYS one.
 */
const SEP = /[\\/]/g

export function toGpgPath(windowsPath, gpgExe) {
  if (process.platform !== 'win32') return windowsPath
  const msys = /[\\/](?:Git|usr)[\\/]/i.test(gpgExe ?? '')
  if (!msys) return windowsPath
  const resolved = path.resolve(windowsPath)
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(resolved)
  if (!m) return windowsPath
  return `/${m[1].toLowerCase()}/${m[2].replace(SEP, '/')}`
}
