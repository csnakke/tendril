/**
 * Rebindable shortcuts. Bindings are stored as Electron accelerator strings
 * ("CmdOrCtrl+Shift+L"): app-scope ones become menu accelerators in the main
 * process, editor-scope ones are translated to CodeMirror key names in the
 * renderer. Settings hold only the user's overrides (id → accelerator, "" for
 * unbound); `resolveBindings` fills in the defaults.
 */

export type KeyScope = 'app' | 'editor'

export interface KeyBindingDef {
  id: string
  label: string
  group: string
  scope: KeyScope
  /** Default accelerator; "" for commands that ship without a shortcut. */
  default: string
}

/** User overrides only. */
export type Keybindings = Record<string, string>

export const KEYBINDINGS: KeyBindingDef[] = [
  { id: 'new', label: 'New', group: 'File', scope: 'app', default: 'CmdOrCtrl+N' },
  { id: 'newFromTemplate', label: 'New from Template…', group: 'File', scope: 'app', default: 'CmdOrCtrl+Alt+N' },
  { id: 'open', label: 'Open…', group: 'File', scope: 'app', default: 'CmdOrCtrl+O' },
  { id: 'save', label: 'Save', group: 'File', scope: 'app', default: 'CmdOrCtrl+S' },
  { id: 'saveAs', label: 'Save As…', group: 'File', scope: 'app', default: 'CmdOrCtrl+Shift+S' },
  { id: 'exportHtml', label: 'Export HTML…', group: 'File', scope: 'app', default: '' },
  { id: 'exportPdf', label: 'Export PDF…', group: 'File', scope: 'app', default: 'CmdOrCtrl+P' },
  { id: 'settings', label: 'Settings…', group: 'File', scope: 'app', default: 'CmdOrCtrl+,' },
  { id: 'insertTable', label: 'Insert Table…', group: 'Edit', scope: 'app', default: 'CmdOrCtrl+Alt+T' },
  { id: 'insertImage', label: 'Insert Image…', group: 'Edit', scope: 'app', default: 'CmdOrCtrl+Alt+I' },
  { id: 'toc', label: 'Insert / Remove Table of Contents', group: 'Edit', scope: 'app', default: 'CmdOrCtrl+Shift+T' },
  { id: 'cycleView', label: 'Toggle Edit / Reading', group: 'View', scope: 'app', default: 'CmdOrCtrl+E' },
  { id: 'viewEdit', label: 'Edit', group: 'View', scope: 'app', default: 'CmdOrCtrl+1' },
  { id: 'viewSplit', label: 'Split', group: 'View', scope: 'app', default: 'CmdOrCtrl+2' },
  { id: 'viewReading', label: 'Reading', group: 'View', scope: 'app', default: 'CmdOrCtrl+3' },
  { id: 'toggleSidebar', label: 'Toggle Sidebar', group: 'View', scope: 'app', default: 'CmdOrCtrl+B' },
  { id: 'toggleGraphPane', label: 'Toggle Graph Pane', group: 'View', scope: 'app', default: 'CmdOrCtrl+Shift+G' },
  { id: 'toggleLivePreview', label: 'Live Preview in Edit View', group: 'View', scope: 'app', default: 'CmdOrCtrl+Shift+E' },
  { id: 'selectNextOccurrence', label: 'Add the next occurrence of the selection', group: 'Multiple cursors', scope: 'editor', default: 'CmdOrCtrl+D' },
  { id: 'splitSelectionIntoLines', label: 'Split selection into lines (single line: select all matches)', group: 'Multiple cursors', scope: 'editor', default: 'CmdOrCtrl+Shift+L' },
  { id: 'addCursorAbove', label: 'Add a caret on the line above', group: 'Multiple cursors', scope: 'editor', default: 'CmdOrCtrl+Shift+Up' },
  { id: 'addCursorBelow', label: 'Add a caret on the line below', group: 'Multiple cursors', scope: 'editor', default: 'CmdOrCtrl+Shift+Down' }
]

export const defaultBinding = (id: string): string => KEYBINDINGS.find((k) => k.id === id)?.default ?? ''

/** Every command's effective accelerator ("" = unbound). */
export function resolveBindings(overrides: Keybindings | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of KEYBINDINGS) out[k.id] = overrides && k.id in overrides ? overrides[k.id] : k.default
  return out
}

const MODIFIERS = new Set(['cmdorctrl', 'commandorcontrol', 'cmd', 'command', 'ctrl', 'control', 'alt', 'option', 'shift', 'super', 'meta'])

/** Modifier(s) + one key, the shape both Electron and CodeMirror accept. */
export function isValidAccelerator(accel: string): boolean {
  if (accel === '') return true
  const parts = accel.split('+').filter(Boolean)
  if (parts.length === 0) return false
  const key = parts[parts.length - 1]
  if (MODIFIERS.has(key.toLowerCase())) return false
  return parts.slice(0, -1).every((p) => MODIFIERS.has(p.toLowerCase()))
}

const CM_KEYS: Record<string, string> = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', esc: 'Escape', escape: 'Escape',
  space: ' ', return: 'Enter', enter: 'Enter', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', plus: '+'
}
const CM_MODS: Record<string, string> = {
  cmdorctrl: 'Mod', commandorcontrol: 'Mod', cmd: 'Meta', command: 'Meta', ctrl: 'Ctrl', control: 'Ctrl',
  alt: 'Alt', option: 'Alt', shift: 'Shift', super: 'Meta', meta: 'Meta'
}

/** "CmdOrCtrl+Shift+Up" → "Mod-Shift-ArrowUp"; null when unbound or malformed. */
export function toCodeMirrorKey(accel: string): string | null {
  if (!accel || !isValidAccelerator(accel)) return null
  const parts = accel.split('+').filter(Boolean)
  const key = parts.pop()!
  const mods = parts.map((m) => CM_MODS[m.toLowerCase()])
  const k = CM_KEYS[key.toLowerCase()] ?? (key.length === 1 ? key.toLowerCase() : key)
  return [...mods, k].join('-')
}

/** Human-readable form, with macOS glyphs on macOS. */
export function formatAccelerator(accel: string, platform: string): string[] {
  if (!accel) return []
  const mac = platform === 'darwin'
  const names: Record<string, string> = mac
    ? { cmdorctrl: '⌘', commandorcontrol: '⌘', cmd: '⌘', command: '⌘', ctrl: '⌃', control: '⌃', alt: '⌥', option: '⌥', shift: '⇧', super: '⌘', meta: '⌘' }
    : { cmdorctrl: 'Ctrl', commandorcontrol: 'Ctrl', cmd: 'Win', command: 'Win', ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift', super: 'Win', meta: 'Win' }
  const keys: Record<string, string> = { up: '↑', down: '↓', left: '←', right: '→', esc: 'Esc', escape: 'Esc', space: 'Space', return: 'Enter', plus: '+' }
  return accel.split('+').filter(Boolean).map((p) => names[p.toLowerCase()] ?? keys[p.toLowerCase()] ?? p)
}

/** Build an accelerator from a keydown event; null for a lone modifier or an unusable key. */
export function acceleratorFromEvent(e: { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }, platform: string): string | null {
  const mac = platform === 'darwin'
  const mods: string[] = []
  if (mac ? e.metaKey : e.ctrlKey) mods.push('CmdOrCtrl')
  if (mac && e.ctrlKey) mods.push('Control')
  if (!mac && e.metaKey) mods.push('Super')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  let key: string | null = null
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5)
  else if (/^F\d{1,2}$/.test(e.key)) key = e.key
  else {
    const named: Record<string, string> = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space', '+': 'Plus', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' }
    if (e.key in named) key = named[e.key]
    else if (e.key.length === 1 && !/\s/.test(e.key)) key = e.key
  }
  if (!key) return null
  // A bare key would swallow ordinary typing; function keys are the exception.
  if (mods.length === 0 && !/^F\d{1,2}$/.test(key)) return null
  return [...mods, key].join('+')
}
