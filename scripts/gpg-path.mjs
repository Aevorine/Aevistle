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
  if (probe.status === 0) return 'gpg'

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
