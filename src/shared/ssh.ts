/**
 * Saved SSH hosts (Settings › SSH), remote listings and transfers: the shapes
 * both processes share. Secrets are never part of these: keys, passwords and
 * passphrases live in `pass`, and a host only records whether it has them.
 */

export type ForwardType = 'L' | 'R' | 'D'

export interface SshForward {
  id: string
  /** L: a local port reaches host:port from the server. R: a server port reaches host:port from here. D: SOCKS proxy on a local port. */
  type: ForwardType
  /** The port that listens (local for L and D, on the server for R). */
  bindPort: number
  /** Where L and R lead; unused for D. */
  host: string
  port: number
  /** Listen on all interfaces instead of localhost only. */
  lan: boolean
  /** Started with the connection. */
  enabled: boolean
}

export interface SshHost {
  id: string
  /** Shown in the explorer, and the `pass` folder: tendril/ssh/<name>/{key,password,passphrase}. */
  name: string
  hostname: string
  user: string
  port: number
  hasKey: boolean
  hasPassword: boolean
  hasPassphrase: boolean
  /** A sudo password is saved (tendril/ssh/<name>/sudo). */
  hasSudo: boolean
  /** sudo on this server takes the login password: no separate sudo password. */
  sudoSameAsLogin: boolean
  /**
   * Auto-Paste Guard: paste the sudo password by itself, only on prompts that
   * carry the session's secret marker (generic prompts). Off: only Ctrl+Alt+P pastes.
   */
  autoPasteGuard: boolean
  forwards: SshForward[]
}

/** Secrets typed in Settings, on their way to `pass`. Absent = keep what is saved; `clear` removes. */
export interface SshSecrets {
  key?: string
  /** A key file to read (Browse…), instead of pasted text. */
  keyPath?: string
  password?: string
  passphrase?: string
  sudo?: string
  clear?: ('key' | 'password' | 'passphrase' | 'sudo')[]
}

/** A saved secret Settings may show (eye button), after the store's master passphrase. */
export type RevealTarget =
  | { kind: 'host'; id: string; field: 'password' | 'passphrase' | 'sudo' }
  | { kind: 'localSudo' }
  | { kind: 'openRouter' }

export type SshHostInput = Omit<SshHost, 'hasKey' | 'hasPassword' | 'hasPassphrase' | 'hasSudo'>

export const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** A hostname or address ssh will not read as an option. */
export const HOSTNAME = /^(?!-)[A-Za-z0-9._:%[\]-]{1,253}$/
export const USER = /^(?!-)[A-Za-z0-9._@-]{1,64}$/

/** Problems with a host's fields, in a sentence each; empty when it can be saved. */
export function hostProblems(h: SshHostInput): string[] {
  const out: string[] = []
  if (!HOST_NAME.test(h.name)) out.push('Name: letters, digits, dot, dash or underscore (starting with a letter or digit).')
  if (!HOSTNAME.test(h.hostname)) out.push('Hostname: a host name or IP address.')
  if (!USER.test(h.user)) out.push('User: the login name on the server.')
  if (!Number.isInteger(h.port) || h.port < 1 || h.port > 65535) out.push('Port: 1 to 65535.')
  for (const f of h.forwards) {
    const what = f.type === 'L' ? 'Local' : f.type === 'R' ? 'Remote' : 'Dynamic'
    if (!Number.isInteger(f.bindPort) || f.bindPort < 1 || f.bindPort > 65535) out.push(`${what} forward: the listening port must be 1 to 65535.`)
    if (f.type !== 'D' && (!HOSTNAME.test(f.host) || !Number.isInteger(f.port) || f.port < 1 || f.port > 65535)) out.push(`${what} forward: a target host and port (1 to 65535).`)
  }
  return out
}

export const forwardLabel = (f: SshForward): string =>
  f.type === 'D' ? `SOCKS :${f.bindPort}` : f.type === 'L' ? `:${f.bindPort} → ${f.host}:${f.port}` : `server :${f.bindPort} → ${f.host}:${f.port}`

export interface RemoteEntry {
  name: string
  path: string
  isDir: boolean
  isLink: boolean
  size: number
  /** Seconds since the epoch; 0 when unknown. */
  mtime: number
}

export interface ForwardState {
  id: string
  label: string
  on: boolean
  error?: string
}

export interface RemoteState {
  connected: boolean
  /** Saved host name, or user@host for a quick connection. */
  label: string
  hostId: string | null
  home: string
  forwards: ForwardState[]
  error?: string
}

export type TransferState = 'queued' | 'running' | 'retrying' | 'done' | 'failed' | 'stopped'

export interface Transfer {
  id: number
  direction: 'up' | 'down'
  name: string
  /** Where it goes: a remote folder (up) or a local one (down). */
  dest: string
  host: string
  state: TransferState
  /** 0..100; null when the engine cannot tell (sftp). */
  percent: number | null
  bytes: number
  /** "12.4MB/s", as rsync prints it. */
  speed: string
  /** "0:01:23". */
  eta: string
  attempt: number
  engine: 'rsync' | 'sftp'
  message?: string
}

/** A password or confirmation the window shows on behalf of ssh (askpass). */
export interface SshPrompt {
  id: number
  title: string
  detail: string
  kind: 'secret' | 'confirm' | 'text'
  /** Offer "Save in pass". */
  canSave: boolean
}
