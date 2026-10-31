import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { writeFileAtomic } from './fsx'

/**
 * The terminal runs in tmux: a tmux server of Tendril's own (`-L tendril-…`,
 * one per Tendril profile, so it never meets a tmux you start yourself), one
 * session per terminal. Sessions are named after the Tendril process that
 * owns them, so two Tendril windows open at once never end each other's.
 *
 * Two config files, in Tendril's data folder:
 * - tmux-base.conf, written by Tendril: the theme's colours for the status
 *   bar and borders, copying to the system clipboard (OSC 52, which the
 *   terminal view hands to the clipboard), the shell, and then
 * - tmux.conf, the user's (Settings › TMUX), sourced last so it wins.
 * ~/.tmux.conf is never read.
 */

/** The server's socket name: one per data folder (profile). */
let socketName: string | null = null
const SOCKET = (): string =>
  (socketName ??= `tendril-${createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 8)}`)

/** The config a fresh install starts with (Settings › TMUX › Reset to default). */
export const DEFAULT_TMUX_CONF = `# ============================================================================
# Prefix = <Cntrl+c>
#
# Command Mode : Prefix + :
# ------ Rename Current Window : :rename-window __name__
# OR
# ------ Rename : Prefix + ,
#
# Copy Mode : Prefix + [
# ------ Quit : q and rest all commands are like vim
# ------ Start Selection : Spacebar
# ------ Clear Selection : Esc
# ------ Copy Selection : Enter (also to the system clipboard)
# ------ Paste Selection : Prefix + ]
# ------ Search Forward and Backward : / and ?
# ------ Next Occurance Forward/Backward : n/N
#
# Panes :
# ------ Split Screen : Horizontal : (Prefix h) and Vertical : (Prefix v)
# ------ Move between Split Panes : Prefix Up, Down, Left, Right
# ------ Swap Split Panes : Prefix Shift+{, Shift+}
# ------ Zoom : Prefix + z
# ------ Resize Split Panes : Prefix + Cntrl(Hold) + Arrow_Keys
#
# Windows :
# ------ Create New Window : Prefix n
# ------ Move between windows : Shift+Left,Right
# ------ Swap Windows : Control+Left,Right
#
# ============================================================================
# TMUX - Configurations
# ============================================================================

# ============================================================================
# Change prefix
# ============================================================================

unbind C-b
set-option -g prefix C-c
bind-key C-c send-prefix

# ============================================================================
# Don't allow tmux to rename windows
# ============================================================================

set-option -g allow-rename on

# ============================================================================
# Use 256 colors
# ============================================================================

set-option -g default-terminal "screen-256color"
set-option -ga terminal-overrides ",xterm-256color:Tc"
#set-option -g default-command bash # Only for debian

# ============================================================================
# Use vi keys for copy mode
# ============================================================================

set-option -g mode-keys vi

# ============================================================================
# Enable status bar
# ============================================================================

set-option -g status on

# ============================================================================
# Window configuration
# ============================================================================

# Create New Window

bind-key n new-window

# Switch between Windows

bind -n S-Left previous-window
bind -n S-Right next-window
bind -n C-Left { swap-window -t -1; previous-window }
bind -n C-Right { swap-window -t +1; next-window }

# ============================================================================
# Panes configuration
# ============================================================================

# Splitting to Panes
bind-key v split-window -h
bind-key h split-window -v

# Activating Panes
bind-key Left select-pane -L
bind-key Right select-pane -R
bind-key Up select-pane -U
bind-key Down select-pane -D

# ============================================================================
# Mouse Mode (Optional)
# ============================================================================

setw -g mouse on

# ============================================================================
# Keybinding for reloading tmux config file
# ============================================================================

# $TENDRIL_TMUX_CONF is Tendril's own: its theme and clipboard settings, then this file.
bind r source-file "$TENDRIL_TMUX_CONF" \\; display " Config File Reloaded!"
`

const userConf = (): string => join(app.getPath('userData'), 'tmux.conf')
const baseConf = (): string => join(app.getPath('userData'), 'tmux-base.conf')

let binary: Promise<string | null> | null = null
/** The same, once found (for quitting, when there is no time to wait). */
let binaryPath: string | null = null

/** The tmux to run, or null when it is not installed. */
export function tmuxBinary(): Promise<string | null> {
  return (binary ??= (async () => {
    const dirs = [...(process.env['PATH'] ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
    for (const d of dirs) {
      const p = join(d, 'tmux')
      if (d && (await fs.access(p, fs.constants.X_OK).then(() => true, () => false))) return (binaryPath = p)
    }
    return null
  })())
}

interface Run {
  code: number
  stdout: string
  stderr: string
}

/** A tmux command against Tendril's server (or `socket`), with `input` on stdin. */
async function tmux(args: string[], input?: string, socket = SOCKET()): Promise<Run> {
  const bin = await tmuxBinary()
  if (!bin) return { code: -1, stdout: '', stderr: 'tmux is not installed' }
  return new Promise((resolve) => {
    // Most tmux commands exit at once (often before reading anything): stdin is
    // only a pipe when there is input, and a pipe closed early (EPIPE) is no error.
    const child = spawn(bin, ['-L', socket, ...args], { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    child.stdin?.on('error', () => {})
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: e.message }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.stdin?.end(input)
  })
}

// ---- Config ------------------------------------------------------------------------

export interface TmuxColors {
  bg: string
  barBg: string
  fg: string
  muted: string
  border: string
  accent: string
  selection: string
}

let colors: TmuxColors | null = null
let shellPath = '/bin/sh'

const hex = (c: unknown): string | null => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : null)
const quote = (s: string): string => `"${s.replace(/[\\"$]/g, (m) => '\\' + m)}"`

function baseText(): string {
  const lines = [
    '# Written by Tendril on every start and theme change; edit Settings › TMUX instead.',
    `set -g default-shell ${quote(shellPath)}`,
    // What each session's shell needs (askpass, …) comes from the client's
    // environment, never from a command line other users could read in ps.
    `set -ga update-environment ${quote(SESSION_ENV.join(' '))}`,
    // Copy mode's copy (and a mouse selection) also goes to the system clipboard.
    'set -s set-clipboard on',
    // Sessions are named t<pid>-<n> (see session()); the status bar shows just n.
    "set -g status-left '[#{s/^t[0-9]+-//:session_name}] '",
    "set -as terminal-overrides ',xterm-256color:Ms=\\E]52;%p1%s;%p2%s\\007'"
  ]
  const c = colors
  if (c && Object.values(c).every(hex)) {
    lines.push(
      `set -g status-style 'bg=${c.barBg},fg=${c.fg}'`,
      `set -g status-left-style 'fg=${c.accent},bold'`,
      `set -g status-right-style 'fg=${c.muted}'`,
      `set -g window-status-style 'fg=${c.muted}'`,
      `set -g window-status-current-style 'bg=${c.accent},fg=${c.bg},bold'`,
      `set -g pane-border-style 'fg=${c.border}'`,
      `set -g pane-active-border-style 'fg=${c.accent}'`,
      `set -g message-style 'bg=${c.barBg},fg=${c.fg}'`,
      `set -g message-command-style 'bg=${c.barBg},fg=${c.fg}'`,
      `set -g mode-style 'bg=${c.selection},fg=${c.fg}'`,
      `set -g display-panes-active-colour '${c.accent}'`,
      `set -g display-panes-colour '${c.muted}'`
    )
  }
  // The user's config last, so whatever it sets wins.
  lines.push(`source-file -q ${quote(userConf())}`)
  return lines.join('\n') + '\n'
}

/** The user's config; a fresh install gets the default. */
export async function readTmuxConf(): Promise<string> {
  try {
    return await fs.readFile(userConf(), 'utf8')
  } catch {
    await writeFileAtomic(userConf(), DEFAULT_TMUX_CONF).catch(() => {})
    return DEFAULT_TMUX_CONF
  }
}

/** Load the config files into the running server, if there is one. */
async function reload(): Promise<void> {
  await writeFileAtomic(baseConf(), baseText())
  await tmux(['source-file', baseConf()])
}

/** The theme changed: open terminals take its colours now. */
export async function setTmuxColors(next: TmuxColors): Promise<void> {
  colors = next
  if (await tmuxBinary()) await reload().catch(() => {})
}

/**
 * Check `text` on a throwaway tmux server; save it and load it into the open
 * terminals when tmux accepts it. Resolves with tmux's complaint otherwise.
 */
export async function saveTmuxConf(text: string): Promise<string | null> {
  if (typeof text !== 'string') return 'Nothing to save.'
  if (!(await tmuxBinary())) {
    await writeFileAtomic(userConf(), text)
    return null
  }
  const dir = await fs.mkdtemp(join(tmpdir(), 'tendril-tmux-'))
  const file = join(dir, 'tmux.conf')
  const socket = `tendril-check-${process.pid}`
  try {
    await fs.writeFile(file, text)
    const started = await tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'check', 'sleep 30'], undefined, socket)
    if (started.code !== 0) return `tmux could not start to check it: ${started.stderr.trim()}`
    const r = await tmux(['source-file', file], undefined, socket)
    const problem = (r.stderr + r.stdout).trim().replaceAll(file, 'line')
    if (r.code !== 0 || problem) return problem || 'tmux did not accept the config.'
  } finally {
    await tmux(['kill-server'], undefined, socket)
    await fs.rm(dir, { recursive: true, force: true })
  }
  await writeFileAtomic(userConf(), text)
  await reload().catch(() => {})
  return null
}

// ---- Sessions ----------------------------------------------------------------------

/** Copied from the terminal's environment into its session (update-environment). */
const SESSION_ENV = [
  'TERM_PROGRAM', 'COLORTERM',
  'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'TENDRIL_ASKPASS_NODE', 'TENDRIL_ASKPASS_SOCK', 'TENDRIL_ASKPASS_TOKEN', 'TENDRIL_ASKPASS_CTX'
]

let cleaned = false
/** This process's sessions, ended when Tendril quits. */
const mine = new Set<string>()

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Sessions left by a Tendril that did not quit cleanly; another running Tendril's stay. */
async function removeOrphans(): Promise<void> {
  const r = await tmux(['list-sessions', '-F', '#{session_name}'])
  for (const name of r.stdout.split('\n')) {
    const owner = /^t(\d+)-\d+$/.exec(name)?.[1]
    if (owner && Number(owner) !== process.pid && !alive(Number(owner))) await tmux(['kill-session', '-t', `=${name}`])
  }
}

/**
 * How to start terminal `id` in tmux: the command for its pseudo-terminal, or
 * null when tmux is not installed. The pseudo-terminal's environment carries
 * what the shell needs (SESSION_ENV); tmux copies it into the session.
 */
export async function tmuxLaunch(id: number, shell: string, cwd: string): Promise<{ file: string; args: string[] } | null> {
  const bin = await tmuxBinary()
  if (!bin) return null
  shellPath = shell
  if (!cleaned) {
    cleaned = true
    await removeOrphans()
  }
  await readTmuxConf()
  await writeFileAtomic(baseConf(), baseText())
  mine.add(session(id))
  // -u: the terminal view is UTF-8, whatever the locale says (a macOS app has no LANG):
  // without it tmux draws characters such as Kali's ㉿ as underscores.
  return { file: bin, args: ['-u', '-L', SOCKET(), '-f', baseConf(), 'new-session', '-s', session(id), '-c', cwd] }
}

/** Its name; tmux targets use `=name`, an exact match (t1-1 must not find t1-10). */
export const session = (id: number): string => `t${process.pid}-${id}`
/** What the pseudo-terminal's environment needs for tmux: where `Prefix r` reloads from. */
export const tmuxEnv = (): Record<string, string> => ({ TENDRIL_TMUX_CONF: baseConf() })

export function killTmuxSession(id: number): void {
  mine.delete(session(id))
  void tmux(['kill-session', '-t', `=${session(id)}`])
}

/**
 * Tendril quits: its sessions end (synchronously, before the process is gone).
 * Another Tendril window's stay; the server ends with its last session.
 */
export function killTmuxSessions(): void {
  if (!binaryPath) return
  for (const name of mine) {
    try {
      execFileSync(binaryPath, ['-L', SOCKET(), 'kill-session', '-t', `=${name}`], { stdio: 'ignore', timeout: 2000 })
    } catch {
      /* already gone */
    }
  }
  mine.clear()
}

export interface Pane {
  id: string
  command: string
  active: boolean
}

/** The panes of terminal `id`'s session, and what runs in the foreground of each. */
export async function panes(id: number): Promise<Pane[]> {
  const r = await tmux(['list-panes', '-s', '-t', `=${session(id)}`, '-F', '#{pane_id} #{pane_active}#{window_active} #{pane_current_command}'])
  if (r.code !== 0) return []
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [pane, flags, ...cmd] = l.split(' ')
      return { id: pane, active: flags === '11', command: cmd.join(' ') }
    })
}

/** The last line with text on pane `pane`'s screen (where a prompt waits). */
export async function paneLastLine(pane: string): Promise<string> {
  const r = await tmux(['capture-pane', '-p', '-J', '-t', pane])
  const lines = r.stdout.split('\n').filter((l) => l.trim())
  return lines[lines.length - 1] ?? ''
}

/**
 * Run `argv` (no shell in between) in a new window of terminal `id`'s session,
 * named `name`; the window closes when it exits. False if tmux would not.
 */
export async function openWindow(id: number, name: string, argv: string[]): Promise<boolean> {
  // A terminal opened by the same click may not have its session yet.
  for (let i = 0; i < 30 && (await tmux(['has-session', '-t', `=${session(id)}`])).code !== 0; i++) {
    await new Promise((r) => setTimeout(r, 100))
  }
  return (await tmux(['new-window', '-t', `=${session(id)}:`, '-n', name, '--', ...argv])).code === 0
}

/** Type `text` and Enter into one pane, through a tmux buffer (never on a command line). */
export async function pasteIntoPane(pane: string, text: string): Promise<void> {
  const buffer = `tendril-${process.pid}`
  await tmux(['load-buffer', '-b', buffer, '-'], text)
  await tmux(['paste-buffer', '-d', '-b', buffer, '-t', pane])
  await tmux(['send-keys', '-t', pane, 'Enter'])
}
