import { promises as fs } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { spawn, type IPty } from 'node-pty'
import { askEnv } from './ssh/askpass'
import { shq } from './ssh/connection'
import { SudoFill, type SudoShell } from './ssh/sudo'
import { setTerminalHost } from './ssh/sudoState'
import { killTmuxSession, killTmuxSessions, openWindow, paneLastLine, panes, pasteIntoPane, tmuxEnv, tmuxLaunch } from './tmux'

/**
 * The terminal panel's shells. Each runs in a pseudo-terminal (node-pty) owned
 * by the main process; the window only ever sees its output and sends it
 * keystrokes and a size. Everything is killed with the window.
 *
 * Each runs in a tmux session of Tendril's own (tmux.ts), or straight in the
 * shell when tmux is not installed.
 *
 * ssh run in it asks for passwords through Tendril (askpass: answered from
 * `pass`, else a dialog), and sudo's prompt is filled from `pass` (ssh/sudo.ts).
 */

const terms = new Map<number, IPty>()
const fills = new Map<number, SudoFill>()
/** Terminals running in a tmux session. */
const tmuxed = new Set<number>()
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
  // A macOS app gets no locale; Terminal.app gives its shells a UTF-8 one, so
  // non-ASCII text (Kali's ㉿, accents, emoji) is read and drawn as such.
  if (process.platform === 'darwin' && ![env['LC_ALL'], env['LC_CTYPE'], env['LANG']].some((v) => /utf-?8/i.test(v ?? ''))) env['LANG'] = 'en_US.UTF-8'
  const ask = process.platform === 'win32' ? null : await askEnv({ terminal: true }).catch(() => null)
  if (ask) Object.assign(env, ask.env)
  const id = ++seq
  const dir = await startDir(cwd)
  const viaTmux = process.platform === 'win32' ? null : await tmuxLaunch(id, file, dir)
  Object.assign(env, tmuxEnv())
  // Started from a shell inside tmux, tmux would refuse to nest; this is a session of its own.
  delete env['TMUX']
  delete env['TMUX_PANE']
  const pty = viaTmux
    ? spawn(viaTmux.file, viaTmux.args, { name: 'xterm-256color', cols: dims(cols, 80), rows: dims(rows, 24), cwd: dir, env })
    : spawn(file, args, { name: 'xterm-256color', cols: dims(cols, 80), rows: dims(rows, 24), cwd: dir, env })
  if (!viaTmux && process.platform !== 'win32') {
    onData(id, '\x1b[2mtmux is not installed, so this is a plain shell. Run the Tendril installer again to get it.\x1b[0m\r\n')
  }
  terms.set(id, pty)
  if (viaTmux) tmuxed.add(id)
  const sudo = new SudoFill(viaTmux ? tmuxShell(id, pty) : plainShell(pty), id)
  fills.set(id, sudo)
  pty.onData((data) => {
    onData(id, data)
    sudo.feed(data)
  })
  pty.onExit(({ exitCode }) => {
    terms.delete(id)
    fills.delete(id)
    tmuxed.delete(id)
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

/**
 * Run `argv` in terminal `id` without typing it: in tmux, a new window named
 * `title` (closed when it exits); in a plain shell, typed after `clear`, which
 * wipes the echoed command, and with a leading space to keep it out of history.
 */
export async function runInTerminal(id: number, argv: string[], title: string): Promise<void> {
  if (tmuxed.has(id) && (await openWindow(id, title, argv))) return
  writeTerminal(id, `\x15 clear; ${argv.map(shq).join(' ')}\r`)
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
  if (tmuxed.delete(id as number)) killTmuxSession(id as number)
  try {
    pty?.kill()
  } catch {
    /* already gone */
  }
}

export function killAllTerminals(): void {
  killTmuxSessions()
  for (const id of [...terms.keys()]) killTerminal(id)
}

// ---- What sudo pasting sees (ssh/sudo.ts) ---------------------------------------------

const normal = (cmd: string): string => (cmd === 'sudo-rs' ? 'sudo' : cmd)

/** A plain shell: one foreground program, typed into directly. */
function plainShell(pty: IPty): SudoShell {
  const fg = (): string => {
    try {
      return normal(pty.process)
    } catch {
      return ''
    }
  }
  return {
    screen: false,
    active: async () => fg(),
    promptPane: async (commands) => (commands.includes(fg()) ? 'pty' : null),
    paste: async (_pane, text) => pty.write(text + '\r'),
    pasteActive: async (text) => pty.write(text + '\r')
  }
}

/**
 * A tmux session: the prompt may wait in any pane, not only the one in front,
 * so the password goes to the pane whose screen ends with that prompt.
 */
function tmuxShell(id: number, pty: IPty): SudoShell {
  return {
    screen: true,
    active: async () => normal((await panes(id)).find((p) => p.active)?.command ?? ''),
    promptPane: async (commands, prompt) => {
      for (const p of await panes(id)) {
        if (commands.includes(normal(p.command)) && prompt.test(await paneLastLine(p.id))) return p.id
      }
      return null
    },
    paste: (pane, text) => pasteIntoPane(pane, text),
    pasteActive: async (text) => pty.write(text + '\r')
  }
}
