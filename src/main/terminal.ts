import { promises as fs } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { spawn, type IPty } from 'node-pty'
import { askEnv } from './ssh/askpass'
import { SudoFill } from './ssh/sudo'
import { setTerminalHost } from './ssh/sudoState'

/**
 * The terminal panel's shells. Each runs in a pseudo-terminal (node-pty) owned
 * by the main process; the window only ever sees its output and sends it
 * keystrokes and a size. Everything is killed with the window.
 *
 * ssh run in it asks for passwords through Tendril (askpass: answered from
 * `pass`, else a dialog), and sudo's prompt is filled from `pass` (ssh/sudo.ts).
 */

const terms = new Map<number, IPty>()
const fills = new Map<number, SudoFill>()
let seq = 0

/** The user's login shell, the way the platform's own terminal starts it. */
async function shell(): Promise<{ file: string; args: string[] }> {
  if (process.platform === 'win32') return { file: process.env['COMSPEC'] || 'powershell.exe', args: [] }
  const candidates = [safeUserShell(), process.env['SHELL'], process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash', '/bin/sh']
  for (const file of candidates) {
    if (!file) continue
    try {
      await fs.access(file, fs.constants.X_OK)
      // macOS Terminal opens login shells (they read ~/.zprofile); Linux terminals do not.
      return { file, args: process.platform === 'darwin' ? ['-l'] : [] }
    } catch {
      /* try the next one */
    }
  }
  return { file: '/bin/sh', args: [] }
}

function safeUserShell(): string | null {
  try {
    return userInfo().shell
  } catch {
    return null
  }
}

/** The folder the window asked for, if it is one; otherwise home. */
async function startDir(cwd: unknown): Promise<string> {
  if (typeof cwd === 'string' && cwd) {
    try {
      if ((await fs.stat(cwd)).isDirectory()) return cwd
    } catch {
      /* gone or unreadable */
    }
  }
  return homedir()
}

const dims = (n: unknown, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(1000, Math.max(2, Math.floor(n))) : fallback

export async function startTerminal(
  cols: unknown,
  rows: unknown,
  cwd: unknown,
  onData: (id: number, data: string) => void,
  onExit: (id: number, code: number) => void
): Promise<number> {
  const { file, args } = await shell()
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  // Set by Tendril's Linux launcher for Electron's sandbox; not the shell's business.
  delete env['CHROME_DEVEL_SANDBOX']
  Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Tendril' })
  const ask = process.platform === 'win32' ? null : await askEnv({ terminal: true }).catch(() => null)
  if (ask) Object.assign(env, ask.env)
  const pty = spawn(file, args, { name: 'xterm-256color', cols: dims(cols, 80), rows: dims(rows, 24), cwd: await startDir(cwd), env })
  const id = ++seq
  terms.set(id, pty)
  const sudo = new SudoFill(pty, id)
  fills.set(id, sudo)
  pty.onData((data) => {
    onData(id, data)
    sudo.feed(data)
  })
  pty.onExit(({ exitCode }) => {
    terms.delete(id)
    fills.delete(id)
    setTerminalHost(id, null)
    ask?.release()
    onExit(id, exitCode)
  })
  return id
}

/** Ctrl+Alt+P: paste the saved sudo password; resolves with why not, when there is none. */
export function pasteSudo(id: unknown): Promise<string | null> {
  const fill = fills.get(id as number)
  return fill ? fill.pasteByHand() : Promise.resolve('The terminal is not running.')
}

export function writeTerminal(id: unknown, data: unknown): void {
  if (typeof data === 'string') terms.get(id as number)?.write(data)
}

export function resizeTerminal(id: unknown, cols: unknown, rows: unknown): void {
  try {
    terms.get(id as number)?.resize(dims(cols, 80), dims(rows, 24))
  } catch {
    /* the shell exited between the resize and now */
  }
}

export function killTerminal(id: unknown): void {
  const pty = terms.get(id as number)
  terms.delete(id as number)
  try {
    pty?.kill()
  } catch {
    /* already gone */
  }
}

export function killAllTerminals(): void {
  for (const id of [...terms.keys()]) killTerminal(id)
}
