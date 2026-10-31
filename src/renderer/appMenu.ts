import type { Command } from '../preload/index'
import { formatAccelerator, resolveBindings } from '../shared/keybindings'
import { settings } from './appearance'
import { showMenu, type MenuItem } from './tables/menu'

/**
 * The ☰ menu: the same File / Edit / View / Window menus as the application
 * menu (main/index.ts), drawn in the window so it takes the app's theme (the
 * native popup follows the desktop's instead). Shortcuts are the ones set in
 * Settings › Keybindings.
 */
export function openAppMenu(x: number, y: number, run: (cmd: Command) => void): void {
  const keys = resolveBindings(settings().keybindings)
  const hint = (id: string): string | undefined => formatAccelerator(keys[id] ?? '', window.api.platform).join('+') || undefined
  const cmd = (label: string, id: Command): MenuItem => ({ label, hint: hint(id), run: () => run(id) })
  const role = (label: string, name: string, shortcut?: string): MenuItem => ({ label, hint: shortcut, run: () => window.api.menuRole(name) })
  const mod = window.api.platform === 'darwin' ? '⌘' : 'Ctrl+'
  const sep: MenuItem = { sep: true }
  showMenu(
    [
      {
        label: 'File',
        sub: [
          cmd('New', 'new'),
          cmd('New from Template…', 'newFromTemplate'),
          cmd('Open…', 'open'),
          sep,
          cmd('Save', 'save'),
          cmd('Save As…', 'saveAs'),
          sep,
          cmd('Export HTML…', 'exportHtml'),
          cmd('Export PDF…', 'exportPdf'),
          sep,
          cmd('Settings…', 'settings'),
          sep,
          cmd('Close Tab', 'closeTab'),
          ...(window.api.platform === 'darwin' ? [] : [role('Quit', 'quit', `${mod}Q`)])
        ]
      },
      {
        label: 'Edit',
        sub: [
          role('Undo', 'undo', `${mod}Z`),
          role('Redo', 'redo', window.api.platform === 'darwin' ? '⇧⌘Z' : 'Ctrl+Shift+Z'),
          sep,
          role('Cut', 'cut', `${mod}X`),
          role('Copy', 'copy', `${mod}C`),
          role('Paste', 'paste', `${mod}V`),
          role('Select All', 'selectAll', `${mod}A`),
          sep,
          cmd('Insert Table…', 'insertTable'),
          cmd('Insert Image…', 'insertImage'),
          cmd('Insert Chart…', 'insertChart'),
          cmd('Insert / Remove Table of Contents', 'toc')
        ]
      },
      {
        label: 'View',
        sub: [
          cmd('Toggle Edit / Reading', 'cycleView'),
          sep,
          cmd('Edit', 'viewEdit'),
          cmd('Split', 'viewSplit'),
          cmd('Reading', 'viewReading'),
          sep,
          cmd('Toggle Sidebar', 'toggleSidebar'),
          cmd('Toggle Graph Pane', 'toggleGraphPane'),
          cmd('Toggle Terminal', 'toggleTerminal'),
          cmd('Paste sudo Password in the Terminal', 'pasteSudo'),
          cmd('Wrap Text', 'toggleWrap'),
          sep,
          cmd('Next Tab', 'nextTab'),
          cmd('Previous Tab', 'prevTab'),
          sep,
          role('Developer Tools', 'toggleDevTools'),
          sep,
          role('Actual Size', 'resetZoom', `${mod}0`),
          role('Zoom In', 'zoomIn', `${mod}+`),
          role('Zoom Out', 'zoomOut', `${mod}-`),
          sep,
          role('Full Screen', 'togglefullscreen', 'F11')
        ]
      },
      {
        label: 'Window',
        sub: [
          { label: 'Minimize', run: () => window.api.minimize() },
          { label: 'Maximize / Restore', run: () => window.api.toggleMaximize() },
          { label: 'Close Window', run: () => window.api.requestClose() }
        ]
      }
    ],
    x,
    y
  )
}
