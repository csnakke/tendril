import { randomBytes } from 'node:crypto'

/**
 * What sudo auto-paste needs to know across the terminal and SSH code:
 *
 * - a version per saved sudo password ('local', or a saved host's name),
 *   bumped whenever that password is saved; a terminal that saw a password
 *   rejected pastes again only once the version moved (the password changed);
 * - the secret marker of each SSH shell Tendril opened, and its host: sudo on
 *   that server prints it in its prompt (SUDO_PROMPT), so only real prompts
 *   of that session carry it;
 * - which saved host a terminal's SSH shell belongs to, for Ctrl+Alt+P.
 */

const versions = new Map<string, number>()
const markers = new Map<string, string>()
const terminalHosts = new Map<number, string>()

export const LOCAL = 'local'

export function sudoVersion(key: string): number {
  return versions.get(key) ?? 0
}

/** A sudo password was saved: terminals that gave up on it may paste again. */
export function bumpSudoVersion(key: string): void {
  versions.set(key, sudoVersion(key) + 1)
}

/** A new marker for an SSH shell on `host` (a saved host's name). */
export function newMarker(host: string): string {
  const marker = randomBytes(12).toString('hex')
  markers.set(marker, host)
  return marker
}

export const hostOfMarker = (marker: string): string | undefined => markers.get(marker)

export function setTerminalHost(terminal: number, host: string | null): void {
  if (host) terminalHosts.set(terminal, host)
  else terminalHosts.delete(terminal)
}

export const terminalHost = (terminal: number): string | undefined => terminalHosts.get(terminal)

/** A host renamed or deleted: its sessions point at the new name, or at nothing. */
export function renameSudoHost(from: string, to: string | null): void {
  for (const [m, h] of markers) if (h === from) to ? markers.set(m, to) : markers.delete(m)
  for (const [t, h] of terminalHosts) if (h === from) to ? terminalHosts.set(t, to) : terminalHosts.delete(t)
  if (to) versions.set(to, sudoVersion(from) + 1)
  versions.delete(from)
}
