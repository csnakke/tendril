import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { acceleratorFromEvent, resolveBindings } from '../shared/keybindings'
import { currentPalette, resolvedTheme, settings, terminalFontFamily, updateSettings } from './appearance'
import { solidHex, terminalTheme } from './themes/terminal'
import { initTerminalTab, setTerminalTab } from './tabBar'
import { holdSidebar } from './sidebar'
import { alertBox, errorMessage } from './messageBox'

/**
 * The terminal: one shell (see main/terminal.ts) in an xterm.js view that
 * takes the theme's colours and the Terminal font from Settings. xterm is
 * loaded the first time it opens.
 *
 * It sits in a panel under the editor, or maximized as a Terminal tab that
 * fills the document area, the explorer hidden until toggled back. Minimized, it goes to a
 * chip in the status bar (the tray) and the shell keeps running; the chip
 * brings it back the way it was. Only closing it (✕) ends the shell.
 */

/**
 * - closed: no terminal
 * - panel: under the editor
 * - max: the Terminal tab, in front
 * - max-behind: the Terminal tab is there, a document is in front
 * - min: in the tray
 */
type State = 'closed' | 'panel' | 'max' | 'max-behind' | 'min'

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T
const paneEl = $('#terminal-pane')
const splitEl = $('#term-split')
const bodyEl = $('#terminal-pane .tp-body')
const buttonEl = $<HTMLButtonElement>('#toolbar button[data-cmd="toggleTerminal"]')
const maxEl = $<HTMLButtonElement>('#terminal-pane .tp-max')
const trayEl = $<HTMLButtonElement>('#term-tray')
const mac = window.api.platform === 'darwin'

let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let loading: Promise<Terminal> | null = null
/** The running shell; null before the first start and after it exits. */
let id: number | null = null
let exited = false
let cwdFor: () => string | null = () => null
let focusEditor: () => void = () => {}
let state: State = 'closed'
/** Where a minimized terminal goes back to. */
let restoreTo: 'panel' | 'max' = 'panel'

/** On screen, so it can be measured and typed into. */
const isOpen = (): boolean => state === 'panel' || state === 'max'
const hasFocus = (): boolean => paneEl.contains(document.activeElement)

function setState(next: State): void {
  const focused = hasFocus()
  state = next
  // CSS lays out each state (styles.css, "Terminal panel"): which of the panel,
  // the editor panes and the explorer show.
  document.documentElement.dataset.terminal = next
  buttonEl.classList.toggle('active', next !== 'closed')
  trayEl.hidden = next !== 'min'
  maxEl.title = next === 'max' ? 'Restore to the panel' : 'Maximize to a tab'
  setTerminalTab(next === 'max' ? 'active' : next === 'max-behind' ? 'inactive' : 'none')
  holdSidebar(next === 'max')
  if (isOpen()) fit()
  else if (focused) focusEditor()
  // The toolbar's document tools step aside while the terminal is maximized (main.ts).
  document.dispatchEvent(new CustomEvent('terminal-layout'))
}

/** The terminal fills the document area: there is no document on screen. */
export function terminalMaximized(): boolean {
  return state === 'max'
}

// ---- Look -------------------------------------------------------------------------

function applyTheme(): void {
  if (!term) return
  term.options.theme = terminalTheme(currentPalette(), resolvedTheme())
  sendTmuxColors()
}

/**
 * tmux's status bar and pane borders take the theme's colours too (main/tmux.ts).
 * tmux reads only #rrggbb; Obsidian themes give rgb()/rgba(), so every colour
 * goes as opaque hex, the see-through ones laid over the background.
 */
function sendTmuxColors(): void {
  const p = currentPalette()
  const bg = solidHex(p.bg) ?? '#000000'
  const barBg = solidHex(p.barBg, bg) ?? bg
  const solid = (c: string, under = bg): string => solidHex(c, under) ?? ''
  window.api.tmuxColors({
    bg, barBg,
    fg: solid(p.fg), muted: solid(p.muted), border: solid(p.border, barBg), accent: solid(p.accent), selection: solid(p.selection)
  })
}

/**
 * OSC 52: a program (tmux's copy mode, mostly) puts text on the clipboard.
 * Writing only: a request to read the clipboard ("?") is ignored.
 */
function osc52(data: string): boolean {
  const b64 = data.slice(data.indexOf(';') + 1)
  if (!b64 || b64 === '?') return true
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    void navigator.clipboard.writeText(new TextDecoder().decode(bytes)).catch(() => {})
  } catch {
    /* not base64: nothing to copy */
  }
  return true
}

async function applyFont(): Promise<void> {
  if (!term) return
  const s = settings()
  const family = terminalFontFamily()
  // xterm measures the cell size once per font change: the face must be loaded by then.
  if (s.terminalFont) await document.fonts.load(`${s.terminalFontWeight} ${s.terminalFontSize}px "${s.terminalFont}"`).catch(() => {})
  term.options.fontFamily = family
  term.options.fontSize = s.terminalFontSize
  term.options.fontWeight = s.terminalFontWeight
  term.options.fontWeightBold = Math.min(900, s.terminalFontWeight + 300)
  fit()
}

document.addEventListener('theme-applied', applyTheme)
document.addEventListener('fonts-applied', () => void applyFont())

// ---- Size -------------------------------------------------------------------------

let fitQueued = false
function fit(): void {
  if (fitQueued || !term || !fitAddon || !isOpen()) return
  fitQueued = true
  requestAnimationFrame(() => {
    fitQueued = false
    if (!term || !fitAddon || !isOpen()) return
    fitAddon.fit()
    if (id !== null) window.api.termResize(id, term.cols, term.rows)
  })
}

new ResizeObserver(fit).observe(bodyEl)

splitEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  e.preventDefault()
  splitEl.setPointerCapture(e.pointerId)
  const startY = e.clientY
  const startH = paneEl.getBoundingClientRect().height
  const max = Math.max(160, (paneEl.parentElement?.getBoundingClientRect().height ?? 600) - 160)
  let height = startH
  const move = (ev: PointerEvent): void => {
    height = Math.min(max, Math.max(100, startH - (ev.clientY - startY)))
    document.documentElement.style.setProperty('--term-h', `${height}px`)
  }
  const up = (): void => {
    splitEl.removeEventListener('pointermove', move)
    splitEl.removeEventListener('pointerup', up)
    void updateSettings({ terminalHeight: Math.round(height) })
  }
  splitEl.addEventListener('pointermove', move)
  splitEl.addEventListener('pointerup', up)
})

// ---- Shell ------------------------------------------------------------------------

async function startShell(): Promise<void> {
  if (!term) return
  exited = false
  try {
    id = await window.api.termStart(term.cols, term.rows, cwdFor())
  } catch (err) {
    // Say why instead of leaving an empty pane; Enter tries again (onData).
    id = null
    exited = true
    term.write(`\x1b[31mCould not start the shell: ${errorMessage(err)}\x1b[0m\r\n\x1b[2mPress Enter to try again.\x1b[0m\r\n`)
  }
}

function endShell(): void {
  if (id !== null) window.api.termKill(id)
  id = null
  exited = false
}

window.api.onTermData((from, data) => {
  if (from === id) term?.write(data)
})

window.api.onTermExit((from, code) => {
  if (from !== id) return
  id = null
  exited = true
  term?.write(`\r\n\x1b[2m[Process exited with code ${code}. Press Enter to start a new shell.]\x1b[0m\r\n`)
})

// ---- Keys ---------------------------------------------------------------------------

/** One spelling per key combination: CmdOrCtrl is ⌘ on macOS and Ctrl elsewhere, modifiers in any order. */
function canonical(accel: string): string {
  const parts = accel.toLowerCase().split('+').filter(Boolean)
  const key = parts.pop() ?? ''
  const mods = parts.map((m) => {
    if (m === 'cmdorctrl' || m === 'commandorcontrol') return mac ? 'cmd' : 'ctrl'
    if (m === 'command' || m === 'meta' || m === 'super') return 'cmd'
    if (m === 'control') return 'ctrl'
    if (m === 'option') return 'alt'
    return m
  })
  return [...new Set(mods)].sort().concat(key).join('+')
}

const sameKeys = (a: string | null, b: string): boolean => !!a && !!b && canonical(a) === canonical(b)

/**
 * Keys the terminal keeps for the app. Elsewhere on Linux and Windows the
 * menu's shortcuts are switched off while the terminal has focus (see below),
 * so Ctrl+C, Ctrl+W, Ctrl+B… reach the shell; copy and paste move to
 * Ctrl+Shift+C / Ctrl+Shift+V as in other terminals there. On macOS the
 * shortcuts use ⌘ and the shell's Ctrl keys never collide with them.
 */
function appKeys(e: KeyboardEvent): boolean {
  if (e.type !== 'keydown') return true
  if (sameKeys(acceleratorFromEvent(e, window.api.platform), resolveBindings(settings().keybindings).toggleTerminal ?? '')) {
    e.preventDefault()
    toggleTerminal()
    return false
  }
  if (sameKeys(acceleratorFromEvent(e, window.api.platform), resolveBindings(settings().keybindings).pasteSudo ?? '')) {
    e.preventDefault()
    void pasteSudo()
    return false
  }
  if (!mac && e.ctrlKey && e.shiftKey && !e.altKey && (e.code === 'KeyC' || e.code === 'KeyV')) {
    e.preventDefault()
    if (e.code === 'KeyC') {
      if (term?.hasSelection()) void navigator.clipboard.writeText(term.getSelection())
    } else {
      void navigator.clipboard.readText().then((text) => term?.paste(text))
    }
    return false
  }
  return true
}

paneEl.addEventListener('focusin', () => !mac && window.api.suspendMenu(true))
paneEl.addEventListener('focusout', (e) => {
  if (!mac && !paneEl.contains(e.relatedTarget as Node | null)) window.api.suspendMenu(false)
})

// ---- Panel --------------------------------------------------------------------------

async function load(): Promise<Terminal> {
  const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')])
  const t = new Terminal({
    cursorBlink: true,
    scrollback: 5000,
    lineHeight: 1.15,
    macOptionIsMeta: true,
    theme: terminalTheme(currentPalette(), resolvedTheme())
  })
  fitAddon = new FitAddon()
  t.loadAddon(fitAddon)
  t.attachCustomKeyEventHandler(appKeys)
  t.parser.registerOscHandler(52, osc52)
  t.onData((data) => {
    if (id !== null) window.api.termWrite(id, data)
    else if (exited && data === '\r') {
      t.reset()
      void startShell()
    }
  })
  t.open(bodyEl)
  term = t
  sendTmuxColors()
  await applyFont()
  return t
}

/** Put the terminal on screen in `next` (starting xterm and the shell if needed) and focus it. */
async function show(next: 'panel' | 'max'): Promise<void> {
  setState(next)
  const t = term ?? (await (loading ??= load()))
  fitAddon?.fit()
  if (id === null && !exited) await startShell()
  // Again after the click that got here has finished moving focus.
  t.focus()
  requestAnimationFrame(() => t.focus())
}

function minimize(): void {
  if (!isOpen()) return
  restoreTo = state === 'max' ? 'max' : 'panel'
  setState('min')
}

function close(): void {
  endShell()
  term?.reset()
  setState('closed')
}

// The toolbar button shows and hides the terminal; it keeps focus where it was.
let viaButton = false
buttonEl.addEventListener('mousedown', (e) => {
  e.preventDefault()
  viaButton = true
})

/**
 * Ctrl+`: open and focus, or from inside the terminal minimize it to the tray.
 * The toolbar button: show / minimize. Either brings a minimized or
 * behind-a-document terminal back.
 */
export function toggleTerminal(): void {
  const button = viaButton
  viaButton = false
  if (state === 'closed') void show('panel')
  else if (state === 'min') void show(restoreTo)
  else if (state === 'max-behind') void show('max')
  else if (button || hasFocus()) minimize()
  else term?.focus()
}

/** Bring the terminal on screen with a running shell; its id, or null when it would not start. */
export async function openTerminal(): Promise<number | null> {
  if (state === 'closed' || state === 'panel') await show('panel')
  else await show(state === 'min' ? restoreTo : 'max')
  if (id === null) await startShell()
  return id
}

/** Type a command into the shell (opening the terminal first), e.g. a note's code block. */
export async function runInTerminal(command: string): Promise<void> {
  const shell = await openTerminal()
  // Ctrl+U first: whatever was half-typed on the prompt does not get prefixed.
  if (shell !== null) window.api.termWrite(shell, `\x15${command}\r`)
}

/**
 * Ctrl+Alt+P: paste the saved sudo password into the shell (the SSH host's,
 * in a shell Tendril opened on it; else this machine's). Always your keypress.
 */
export async function pasteSudo(): Promise<void> {
  if (id === null) return alertBox('No terminal is running', 'Open the terminal and run the command that asks for the sudo password first.')
  const why = await window.api.termPasteSudo(id)
  if (why) await alertBox('Nothing to paste', why)
  term?.focus()
}

/** A document was brought to the front: a maximized terminal steps behind it. */
export function documentShown(): void {
  if (state === 'max') setState('max-behind')
}

$('#terminal-pane .tp-min').addEventListener('click', minimize)
maxEl.addEventListener('click', () => void show(state === 'max' ? 'panel' : 'max'))
trayEl.addEventListener('click', () => void show(restoreTo))
initTerminalTab({ select: () => void show('max'), close })

$('#terminal-pane .tp-sudo').addEventListener('click', () => void pasteSudo())

$('#terminal-pane .tp-restart').addEventListener('click', () => {
  endShell()
  term?.reset()
  void startShell().then(() => term?.focus())
})

$('#terminal-pane .tp-close').addEventListener('click', close)

export function initTerminal(opts: { cwd: () => string | null; focusEditor: () => void }): void {
  cwdFor = opts.cwd
  focusEditor = opts.focusEditor
  document.documentElement.style.setProperty('--term-h', `${settings().terminalHeight}px`)
  setState('closed')
}
