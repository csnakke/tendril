import { existsSync } from 'node:fs'

/**
 * A macOS app started from Finder, the Dock or `open` gets only the system
 * PATH (/usr/bin:/bin:/usr/sbin:/sbin), not the one a Terminal shell builds.
 * Homebrew's (and MacPorts') programs Tendril runs — pass, gpg, rsync,
 * pinentry-mac, tmux — would look missing, and `pass` itself runs gpg, brew
 * and GNU getopt from there. Their folders go first on PATH, so Tendril and
 * everything it starts (shells, ssh, pass) find what the Terminal finds.
 */
export function addSystemPaths(): void {
  if (process.platform !== 'darwin') return
  const have = (process.env['PATH'] ?? '').split(':').filter(Boolean)
  const extra = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin', '/opt/local/bin', '/opt/local/sbin'].filter(
    (d) => !have.includes(d) && existsSync(d)
  )
  if (extra.length) process.env['PATH'] = [...extra, ...have].join(':')
}
