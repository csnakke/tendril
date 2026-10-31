import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type WebFrameMain } from 'electron'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { loadSettings, redact, saveSettings, type Settings } from './settings'
import { fontFaceCss, installNerdFont, installedFamilies, listNerdFonts, uninstallNerdFont } from './fonts'
import { listDir, unwatchAll, unwatchDir, watchDir } from './explorer'
import { fetchObsidianTheme, installedThemes, listObsidianThemes, saveTheme, uninstallTheme, type ThemeDef } from './themes'
import { defaultTemplatesDir, ensureTemplatesDir, listUserTemplates } from './templates'
import { resolveBindings, type Keybindings } from '../shared/keybindings'
import { complete as llmComplete, test as llmTest } from './llm'
import { writeFileAtomic } from './fsx'
import { buildGraph, disableGraph, enableGraph, forgetGraph, isGraphFolder, unwatchGraph } from './graph'
import { loadSession, saveSession } from './session'
import { readTextFile } from './textFile'
import { lint } from './lint'
import { killAllTerminals, killTerminal, pasteSudo, resizeTerminal, startTerminal, writeTerminal } from './terminal'
import { closeRemote, registerRemote, remoteMenuItems } from './ssh/remote'
import { exportBackup, importBackup, removeGraphMarkers } from './backup'
import { clearOpenRouterKey, moveOpenRouterKeyToPass, saveOpenRouterKey } from './aiKey'
import { DEFAULT_TMUX_CONF, readTmuxConf, saveTmuxConf, setTmuxColors, tmuxBinary, type TmuxColors } from './tmux'
import type { LintKind } from '../shared/lint'

type Command = string

// Native Wayland has no global window coordinates: a frameless window can be
// resized from its right/bottom edges (size is client-controlled) but never
// moved, so top/left edge resizing is unavailable there. Forcing X11 under
// XWayland is not an option: the window never appears (GNOME 49 + Electron 44).
const wayland = process.platform === 'linux' && !!process.env['WAYLAND_DISPLAY'] && !process.argv.includes('--ozone-platform=x11')

let win: BrowserWindow | null = null
let forceClose = false
// Set once the renderer has asked for the session, i.e. it is up and able to
// answer 'hotExit'. Before that (or after a crash) the window just closes.
let sessionReady = false
// app.quit() (Cmd+Q, Quit menu) is cancelled by the hot-exit close below, which
// holds the window open while the renderer saves. Remember the request so the
// quit can be resumed once the window really closes.
let quitting = false
let quitAfterClose = false

const MD_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown', 'txt', 'html', 'htm'] },
  // Highlighted and linted in the editor (renderer/codeLanguage.ts).
  { name: 'Python', extensions: ['py', 'pyw'] },
  { name: 'JavaScript', extensions: ['js', 'mjs', 'cjs', 'jsx'] }
]
// Open also offers every file: anything that turns out to be text opens (see textFile.ts).
const OPEN_FILTERS = [...MD_FILTERS, { name: 'All Files', extensions: ['*'] }]

/** The one message for a file that cannot be opened, saying which file and why. */
function cannotOpen(path: string, reason: string): Promise<unknown> {
  return win ? dialog.showMessageBox(win, { type: 'warning', message: 'Cannot open file', detail: `${basename(path)}\n\n${reason}` }) : Promise.resolve()
}

function send(cmd: Command): void {
  win?.webContents.send('command', cmd)
}

const isZoomed = (): boolean => !!win && (win.isMaximized() || win.isFullScreen())

// The user's shortcut overrides, kept here so the menu can be rebuilt without
// re-reading settings.json (a read racing the save would restore stale keys).
let keybindings: Keybindings = {}
// While Settings records a shortcut no accelerator may fire on the keys being
// pressed. On Linux/Windows the menu stays in place with its accelerators
// unregistered: removing it (setApplicationMenu(null)) drops the window's
// input focus on Linux, after which neither the recorder nor any accelerator
// sees another key. macOS ignores registerAccelerator, so there the menu is
// removed for the duration instead.
let recording = false

/** Menu accelerators follow Settings > Keybindings; an invalid override falls back to the defaults. */
function buildMenu(): void {
  if (recording && process.platform === 'darwin') return Menu.setApplicationMenu(null)
  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(resolveBindings(keybindings))))
  } catch {
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(resolveBindings({}))))
  }
}

function menuTemplate(keys: Record<string, string>): MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin'
  const acc = (id: string): string | undefined => keys[id] || undefined
  // Every item is spelled out (no role submenus) so the flag reaches all of them.
  const withRegistration = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
    items.map((i) => ({ ...i, registerAccelerator: !recording, ...(Array.isArray(i.submenu) ? { submenu: withRegistration(i.submenu) } : {}) }))
  return withRegistration([
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New', accelerator: acc('new'), click: () => send('new') },
        { label: 'New from Template…', accelerator: acc('newFromTemplate'), click: () => send('newFromTemplate') },
        { label: 'Open…', accelerator: acc('open'), click: () => send('open') },
        { type: 'separator' },
        { label: 'Save', accelerator: acc('save'), click: () => send('save') },
        { label: 'Save As…', accelerator: acc('saveAs'), click: () => send('saveAs') },
        { type: 'separator' },
        { label: 'Export HTML…', accelerator: acc('exportHtml'), click: () => send('exportHtml') },
        { label: 'Export PDF…', accelerator: acc('exportPdf'), click: () => send('exportPdf') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: acc('settings'), click: () => send('settings') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: acc('closeTab'), click: () => send('closeTab') },
        ...(isMac ? [] : [{ role: 'quit' as const }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Insert Table…', accelerator: acc('insertTable'), click: () => send('insertTable') },
        { label: 'Insert Image…', accelerator: acc('insertImage'), click: () => send('insertImage') },
        { label: 'Insert Chart…', accelerator: acc('insertChart'), click: () => send('insertChart') },
        { label: 'Insert / Remove Table of Contents', accelerator: acc('toc'), click: () => send('toc') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Edit / Reading', accelerator: acc('cycleView'), click: () => send('cycleView') },
        { type: 'separator' },
        { label: 'Edit', accelerator: acc('viewEdit'), click: () => send('viewEdit') },
        { label: 'Split', accelerator: acc('viewSplit'), click: () => send('viewSplit') },
        { label: 'Reading', accelerator: acc('viewReading'), click: () => send('viewReading') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: acc('toggleSidebar'), click: () => send('toggleSidebar') },
        { label: 'Toggle Graph Pane', accelerator: acc('toggleGraphPane'), click: () => send('toggleGraphPane') },
        { label: 'Toggle Terminal', accelerator: acc('toggleTerminal'), click: () => send('toggleTerminal') },
        { label: 'Paste sudo Password in the Terminal', accelerator: acc('pasteSudo'), click: () => send('pasteSudo') },
        { label: 'Wrap Text', accelerator: acc('toggleWrap'), click: () => send('toggleWrap') },
        { type: 'separator' },
        { label: 'Next Tab', accelerator: acc('nextTab'), click: () => send('nextTab') },
        { label: 'Previous Tab', accelerator: acc('prevTab'), click: () => send('prevTab') },
        { type: 'separator' },
        // Reload throws the unsaved document away; it is a development aid only.
        ...(app.isPackaged ? [] : [{ role: 'reload' as const }]),
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    // Not role 'close': its built-in CmdOrCtrl+W belongs to Close Tab.
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { label: 'Close Window', click: () => win?.close() }, ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [])] }
  ])
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: 'Tendril',
    icon: join(app.getAppPath(), 'icons/icon.png'),
    show: false,
    // Frameless + transparent so the renderer can draw a rounded, coloured
    // window boundary; the toolbar provides drag region and window controls.
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only needs ipcRenderer/contextBridge/webUtils, all of which
      // a sandboxed preload has, so the renderer keeps the OS-level sandbox.
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win?.show())

  // Never navigate inside the app window; hand http(s) to the OS browser.
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault()
    if (/^https?:/.test(url)) void shell.openExternal(url)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Hot exit: nothing is asked. The renderer writes the open tabs, unsaved
  // text included, to the session and answers with window:close.
  win.on('close', (e) => {
    if (forceClose || !sessionReady || win!.webContents.isCrashed()) return
    e.preventDefault()
    quitAfterClose = quitting
    quitting = false
    send('hotExit')
  })
  win.webContents.on('render-process-gone', () => {
    sessionReady = false
    killAllTerminals()
  })
  // A reload starts a fresh window that knows nothing of the old shells.
  win.webContents.on('did-start-loading', killAllTerminals)

  win.on('closed', () => {
    win = null
    forceClose = false
    sessionReady = false
    unwatchAll()
    unwatchGraph()
    killAllTerminals()
    closeRemote()
  })
  const notifyState = (): void => win?.webContents.send('window:state', isZoomed())
  win.on('maximize', notifyState)
  win.on('unmaximize', notifyState)
  win.on('enter-full-screen', notifyState)
  win.on('leave-full-screen', notifyState)

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Dev aids: TENDRIL_AUTOCMD="toc,viewReading" runs commands after load,
  // TENDRIL_AUTOJS runs a snippet in the page (its result is written to
  // TENDRIL_AUTOJS_OUT when set), TENDRIL_SCREENSHOT=/path.png then captures
  // the window, TENDRIL_AUTOQUIT=1 exits afterwards.
  //
  // Never in a packaged build: TENDRIL_AUTOJS runs arbitrary code in the page,
  // which reaches every privileged channel the preload exposes, so a shipped
  // app must not take it from the environment it happens to be launched in.
  const shot = app.isPackaged ? undefined : process.env['TENDRIL_SCREENSHOT']
  const autocmd = app.isPackaged ? undefined : process.env['TENDRIL_AUTOCMD']
  if (shot || autocmd || (!app.isPackaged && process.env['TENDRIL_AUTOJS'])) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        for (const c of autocmd?.split(',').filter(Boolean) ?? []) send(c)
        await new Promise((r) => setTimeout(r, 500))
        const js = process.env['TENDRIL_AUTOJS']
        if (js) {
          const result = await win!.webContents.executeJavaScript(js)
          const out = process.env['TENDRIL_AUTOJS_OUT']
          if (out) await fs.writeFile(out, typeof result === 'string' ? result : JSON.stringify(result, null, 2))
        }
        if (process.env['TENDRIL_AUTOQUIT'] && !shot) return app.quit()
        if (!shot) return
        await new Promise((r) => setTimeout(r, 800))
        const img = await win!.webContents.capturePage()
        await fs.writeFile(shot, img.toPNG())
        if (process.env['TENDRIL_AUTOQUIT']) app.quit()
      }, 1500)
    })
  }

  // File passed on the command line (double-click / `tendril file.md`).
  // Any non-flag argument; openInWindow drops it unless it is a text file.
  const argPath = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-'))
  win.webContents.once('did-finish-load', () => {
    const p = pendingOpen ?? (argPath && resolve(argPath))
    pendingOpen = null
    if (p) void openInWindow(p)
  })
}

// ---- IPC -------------------------------------------------------------------

/**
 * Channels are registered through `handle`/`on` rather than on ipcMain
 * directly, so every one of them first checks that the call really comes from
 * the app's own top-level frame. Nothing else is ever loaded in the window
 * (see will-navigate / setWindowOpenHandler above), so this costs nothing and
 * keeps a channel from being driven by anything that ever does.
 */
function fromApp(e: { senderFrame: WebFrameMain | null }): boolean {
  return !!win && !win.isDestroyed() && e.senderFrame === win.webContents.mainFrame
}

function handle(channel: string, fn: (e: IpcMainInvokeEvent, ...args: never[]) => unknown): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromApp(e)) throw new Error(`Refused ${channel}: not the application window`)
    return fn(e, ...(args as never[]))
  })
}

function on(channel: string, fn: (e: IpcMainEvent, ...args: never[]) => void): void {
  ipcMain.on(channel, (e, ...args) => {
    if (fromApp(e)) fn(e, ...(args as never[]))
  })
}

handle('file:open', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: OPEN_FILTERS })
  if (r.canceled || r.filePaths.length === 0) return null
  const path = r.filePaths[0]
  const read = await readTextFile(path)
  if ('error' in read) {
    await cannotOpen(path, read.error)
    return null
  }
  allowAssetsIn(dirname(path))
  return { path, content: read.text }
})

/** The file's text, or why it cannot be opened (never a binary loaded into the editor). */
handle('file:read', async (_e, path: string) => {
  const read = await readTextFile(path)
  if ('error' in read) return { path, error: read.error }
  allowAssetsIn(dirname(path))
  return { path, content: read.text }
})

handle('file:save', async (_e, path: string | null, content: string, suggested?: string) => {
  let target = path
  if (!target) {
    // `suggested` pre-fills folder and name (new from template); the user still decides.
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: suggested || 'untitled.md',
      filters: MD_FILTERS,
      properties: ['showOverwriteConfirmation', 'createDirectory']
    })
    if (r.canceled || !r.filePath) return null
    target = r.filePath
  }
  await writeFileAtomic(target, content)
  allowAssetsIn(dirname(target))
  return target
})

handle('export:html', async (_e, html: string, suggestedName: string) => {
  const r = await dialog.showSaveDialog(win!, {
    defaultPath: suggestedName.replace(/\.(md|markdown|txt|html?)$/i, '') + '.html',
    filters: [{ name: 'HTML', extensions: ['html'] }]
  })
  if (r.canceled || !r.filePath) return null
  await writeFileAtomic(r.filePath, html)
  return r.filePath
})

handle('export:pdf', async (_e, html: string, suggestedName: string, opts?: { paged: boolean; title: string; paper: 'A4' | 'Letter'; header: boolean }) => {
  const r = await dialog.showSaveDialog(win!, {
    defaultPath: suggestedName.replace(/\.(md|markdown|txt|html?)$/i, '') + '.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (r.canceled || !r.filePath) return null

  // Print from a real file URL in a hidden window so relative images resolve
  // and Chromium keeps internal anchors as clickable PDF links. The document
  // is somebody's writing: it goes in a private directory of its own rather
  // than under a predictable name in the shared temp folder.
  const dir = await fs.mkdtemp(join(tmpdir(), 'tendril-'))
  const tmp = join(dir, 'print.html')
  await fs.writeFile(tmp, html, { encoding: 'utf8', mode: 0o600 })
  const printer = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  try {
    await printer.loadURL(pathToFileURL(tmp).href)
    const hf = '<div style="width:100%;font:8.5px \'Segoe UI\',-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#666;padding:0 0.75in;display:flex;justify-content:space-between;align-items:center;">'
    const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
    const header = opts?.header ?? true
    const pdf = await printer.webContents.printToPDF({
      printBackground: true,
      generateDocumentOutline: true,
      generateTaggedPDF: true,
      pageSize: opts?.paper ?? 'A4',
      // Room for the running header/footer when shown; a plain page otherwise.
      margins: header ? { top: 0.9, bottom: 0.9, left: 0.75, right: 0.75 } : { top: 0.75, bottom: 0.75, left: 0.75, right: 0.75 },
      displayHeaderFooter: header,
      headerTemplate: `${hf}<span>${esc(opts?.title ?? '')}</span><span class="date"></span></div>`,
      footerTemplate: `${hf}<span></span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`
    })
    await fs.writeFile(r.filePath, pdf)
  } finally {
    printer.destroy()
    void fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  return r.filePath
})

// ---- File explorer -----------------------------------------------------------

handle('dir:list', async (_e, dir: string) => {
  const listing = await listDir(dir)
  // Graph markers made before folders were recorded are picked up as the explorer comes across them.
  const found = [...(listing.graph ? [dir] : []), ...listing.entries.filter((d) => d.graph).map((d) => d.path)]
  if (found.length) void rememberGraphFolders(found, true)
  return listing
})

/** Folders holding a graph marker (`.tendril/`), so uninstalling can remove exactly those. */
async function rememberGraphFolders(dirs: string[], on: boolean): Promise<void> {
  const known = new Set((await loadSettings()).graphFolders)
  const before = known.size
  for (const d of dirs) on ? known.add(d) : known.delete(d)
  if (known.size !== before || !on) await saveSettings({ graphFolders: [...known] })
}
handle('dir:home', () => homedir())
handle('dir:pick', async (_e, current: string | null) => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], defaultPath: current ?? undefined })
  if (r.canceled || r.filePaths.length === 0) return null
  allowAssetsIn(r.filePaths[0])
  return r.filePaths[0]
})
on('dir:watch', (e, dir: string) => watchDir(dir, (d) => e.sender.send('dir:changed', d)))
on('dir:unwatch', (_e, dir: string) => unwatchDir(dir))
handle('shell:showInFolder', (_e, path: string) => shell.showItemInFolder(path))
handle('shell:trash', (_e, path: string) => shell.trashItem(path))
/** The OS trash, not an app-level one. */
handle('shell:openTrash', () => {
  if (process.platform === 'win32') return new Promise<void>((r) => execFile('explorer.exe', ['shell:RecycleBinFolder'], () => r()))
  if (process.platform === 'darwin') return shell.openPath(join(homedir(), '.Trash')).then(() => undefined)
  return shell.openExternal('trash:///')
})
on('explorer:contextMenu', async (e, path: string, isDir: boolean, folder: string, isRoot: boolean) => {
  // Marking a folder happens here, in the main process, on the user's click:
  // the renderer has no channel that could turn an arbitrary folder into a graph.
  const graph = isDir && (await isGraphFolder(path))
  const setGraph = (on: boolean): void => {
    void (on ? enableGraph(path) : disableGraph(path)).then(
      () => {
        forgetGraph(path)
        void rememberGraphFolders([path], on)
        e.sender.send('graph:marker', path, on)
      },
      (err: Error) => dialog.showMessageBox(win!, { type: 'error', message: on ? 'Could not enable the graph' : 'Could not disable the graph', detail: err.message })
    )
  }
  const menu = Menu.buildFromTemplate([
    { label: 'New from Template Here…', click: () => e.sender.send('template:new', folder) },
    ...(isDir ? [{ label: graph ? 'Disable Graph' : 'Enable Graph Here', click: () => setGraph(!graph) }] : []),
    { type: 'separator' },
    { label: isDir ? 'Reveal Folder in File Manager' : 'Reveal in File Manager', click: () => shell.showItemInFolder(path) },
    ...(isRoot ? [] : [{ type: 'separator' as const }, { label: 'Move to Trash', click: () => e.sender.send('explorer:trash', path) }]),
    ...remoteMenuItems(path)
  ])
  menu.popup({ window: win! })
})

// ---- Tag graph -----------------------------------------------------------------

/** Only a folder carrying the marker is scanned; anything else is refused in graph.ts. */
handle('graph:build', async (e, dir: string) => {
  const { assetsFolder } = await loadSettings()
  return buildGraph(dir, { assetsFolder, onChange: (d) => !e.sender.isDestroyed() && e.sender.send('graph:changed', d) })
})
handle('graph:isEnabled', (_e, dir: string) => isGraphFolder(dir))

// ---- Templates ---------------------------------------------------------------

handle('templates:list', () => listUserTemplates())
handle('templates:openFolder', async () => shell.openPath(await ensureTemplatesDir()))
handle('templates:defaultDir', () => defaultTemplatesDir())
handle('file:exists', (_e, path: string) => fs.access(path).then(() => true, () => false))
handle('dir:ensure', (_e, dir: string) => fs.mkdir(dir, { recursive: true }).then(() => undefined))

// ---- Images ------------------------------------------------------------------

const IMAGE_FILTERS = [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'] }]
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif' }

handle('image:pick', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'], filters: IMAGE_FILTERS })
  if (r.canceled) return []
  for (const f of r.filePaths) allowAssetsIn(dirname(f))
  return r.filePaths
})

/**
 * Copy an image into the assets folder under a safe, unique name; answer with
 * the note-relative path. `overwrite` (a chart's SVG, re-exported) keeps the
 * same name instead, and is honoured for image files only.
 */
handle('image:import', async (_e, o: { docDir: string; assetsDir: string; name: string; srcPath?: string; data?: ArrayBuffer; overwrite?: boolean }) => {
  await fs.mkdir(o.assetsDir, { recursive: true })
  allowAssetsIn(o.assetsDir)
  const ext = extname(o.name).toLowerCase() || '.png'
  const stem = basename(o.name, extname(o.name)).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'image'
  let target = join(o.assetsDir, stem + ext)
  const replace = !!o.overwrite && ext in MIME
  if (!replace) for (let n = 1; await fs.access(target).then(() => true, () => false); n++) target = join(o.assetsDir, `${stem}-${n}${ext}`)
  if (o.srcPath) await fs.copyFile(o.srcPath, target)
  else if (o.data) await (replace ? writeFileAtomic(target, Buffer.from(o.data)) : fs.writeFile(target, Buffer.from(o.data)))
  else throw new Error('Nothing to import')
  let rel = relative(o.docDir, target).split('\\').join('/')
  if (!rel.startsWith('.')) rel = './' + rel
  return { path: target, rel }
})

handle('file:dataUrl', async (_e, path: string) => {
  try {
    const mime = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
    return `data:${mime};base64,${(await fs.readFile(path)).toString('base64')}`
  } catch {
    return null
  }
})

/**
 * Folders asset:// may serve from: wherever a document has been opened or
 * saved this session, wherever the user pointed a dialog, and the app's own
 * data. A note's images sit next to the note, so this covers normal use; what
 * it rules out is a request for a path no document ever pointed at.
 */
const assetRoots = new Set<string>()
function allowAssetsIn(dir: string | null | undefined): void {
  if (dir) assetRoots.add(resolve(dir))
}

const under = (p: string, dir: string): boolean => {
  const rel = relative(dir, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * asset:// exists to show the images a note references, so it serves image
 * files and nothing else, and only from a folder in play. Without both checks
 * the scheme is a read of any file on the machine for anything running in the
 * renderer, which is exactly what the CSP and the preload boundary are there
 * to prevent.
 */
function assetAllowed(p: string): boolean {
  if (!(extname(p).toLowerCase() in MIME)) return false
  if (under(p, app.getPath('userData')) || under(p, app.getAppPath())) return true
  for (const root of assetRoots) if (under(p, root)) return true
  // A note may also point straight at the user's own files; a dot-directory
  // (~/.ssh, ~/.gnupg, ~/.config) is not what anyone means by that.
  const home = homedir()
  return under(p, home) && !relative(home, p).split(/[\\/]/).some((seg) => seg.startsWith('.'))
}

// The preview may run from http (dev) or file (packaged); either way local
// images are served through asset:///abs/path so relative links in notes work.
protocol.registerSchemesAsPrivileged([{ scheme: 'asset', privileges: { secure: true, supportFetchAPI: true, stream: true } }])
function serveAsset(req: Request): Promise<Response> {
  let p: string
  try {
    p = decodeURIComponent(new URL(req.url).pathname)
  } catch {
    return Promise.resolve(new Response(null, { status: 404 }))
  }
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1) // Windows drive letter
  p = resolve(p)
  if (!assetAllowed(p)) return Promise.resolve(new Response(null, { status: 403 }))
  // A missing image is a 404, not an unhandled rejection in the log.
  return net.fetch(pathToFileURL(p).href).catch(() => new Response(null, { status: 404 }))
}

handle('shell:openExternal', (_e, url: string) => {
  if (/^https?:/.test(url)) return shell.openExternal(url)
  return undefined
})

// ---- AI ----------------------------------------------------------------------

// One in-flight request per id; deltas go back as 'llm:delta' events until the handle resolves.
const llmRequests = new Map<number, AbortController>()
handle('llm:complete', async (e, id: number, prompt: string, selection: string) => {
  const ctl = new AbortController()
  llmRequests.set(id, ctl)
  try {
    return await llmComplete(await loadSettings(), prompt, selection, (text) => e.sender.send('llm:delta', id, text), ctl.signal)
  } catch (err) {
    if ((err as Error).name === 'AbortError') return null
    throw err
  } finally {
    llmRequests.delete(id)
  }
})
on('llm:cancel', () => llmRequests.forEach((ctl) => ctl.abort()))
handle('llm:test', async () => llmTest(await loadSettings()))

// ---- Linting -----------------------------------------------------------------

const LINT_KINDS: readonly LintKind[] = ['python', 'javascript', 'jsx', 'commonjs']
handle('lint:run', (_e, kind: LintKind, text: string) => {
  if (!LINT_KINDS.includes(kind) || typeof text !== 'string') throw new Error('Nothing to lint')
  return lint(kind, text)
})

// ---- Terminal ----------------------------------------------------------------

handle('term:start', (e, cols: number, rows: number, cwd: string | null) =>
  startTerminal(cols, rows, cwd, (id, data) => !e.sender.isDestroyed() && e.sender.send('term:data', id, data),
    (id, code) => !e.sender.isDestroyed() && e.sender.send('term:exit', id, code)))
on('term:write', (_e, id: number, data: string) => writeTerminal(id, data))
on('term:resize', (_e, id: number, cols: number, rows: number) => resizeTerminal(id, cols, rows))
on('term:kill', (_e, id: number) => killTerminal(id))
handle('term:pasteSudo', (_e, id: number) => pasteSudo(id))
on('tmux:colors', (_e, colors: TmuxColors) => void setTmuxColors(colors))
handle('tmux:getConfig', async () => ({ text: await readTmuxConf(), defaultText: DEFAULT_TMUX_CONF, installed: !!(await tmuxBinary()) }))
handle('tmux:saveConfig', (_e, text: string) => saveTmuxConf(text))

// ---- Backup ------------------------------------------------------------------

handle('backup:export', async () => {
  const r = await dialog.showSaveDialog(win!, {
    title: 'Export Tendril settings',
    defaultPath: join(homedir(), `tendril-backup-${new Date().toISOString().slice(0, 10)}.tendril`),
    filters: [{ name: 'Tendril backup', extensions: ['tendril'] }]
  })
  return r.canceled || !r.filePath ? null : exportBackup(r.filePath)
})
handle('backup:import', async () => {
  const r = await dialog.showOpenDialog(win!, { title: 'Import Tendril settings', properties: ['openFile'], filters: [{ name: 'Tendril backup', extensions: ['tendril', 'json'] }] })
  return r.canceled || !r.filePaths[0] ? null : importBackup(r.filePaths[0])
})
// Restart (after an import): the usual hot exit keeps the open tabs, then the app starts again.
let relaunch = false
on('app:relaunch', () => {
  relaunch = true
  send('hotExit')
})

// ---- Remote (SSH) ------------------------------------------------------------

registerRemote(handle, on, () => win, writeTerminal)

// ---- Settings & fonts ------------------------------------------------------

handle('settings:get', async () => redact(await loadSettings()))
handle('settings:set', async (_e, raw: Partial<Settings>) => {
  // The OpenRouter key is written only through ai:saveKey (into pass).
  const patch = { ...raw }
  delete patch.openRouterKey
  delete patch.openRouterKeyInPass
  const next = await saveSettings(patch)
  if ('keybindings' in patch) {
    keybindings = next.keybindings
    buildMenu()
  }
  return redact(next)
})

handle('ai:saveKey', async (_e, key: string) => {
  await saveOpenRouterKey(key)
  return redact(await loadSettings())
})
handle('ai:clearKey', async () => {
  await clearOpenRouterKey()
  return redact(await loadSettings())
})

handle('fonts:list', () => listNerdFonts())
handle('fonts:families', () => installedFamilies())
handle('fonts:css', (_e, family: string, embed: boolean) => fontFaceCss(family, embed))
handle('fonts:uninstall', (_e, name: string) => uninstallNerdFont(name))
handle('fonts:install', (e, name: string) =>
  installNerdFont(name, (pct) => e.sender.send('fonts:progress', { name, pct }))
)

handle('themes:list', () => listObsidianThemes())
handle('themes:fetch', (_e, repo: string) => fetchObsidianTheme(repo))
handle('themes:installed', () => installedThemes())
handle('themes:save', (_e, def: ThemeDef) => saveTheme(def))
handle('themes:uninstall', (_e, id: string) => uninstallTheme(id))

on('state:dirty', (_e, d: boolean) => {
  win?.setDocumentEdited(d)
})

handle('session:load', () => {
  sessionReady = true
  return loadSession()
})
handle('session:save', (_e, session: unknown) => saveSession(session))

on('state:title', (_e, title: string) => {
  win?.setTitle(title ? `${basename(title)} — Tendril` : 'Tendril')
})

on('window:close', () => {
  forceClose = true
  win?.close()
  // macOS keeps the process alive after its last window closes: finish a pending quit.
  if (quitAfterClose) app.quit()
  quitAfterClose = false
})
on('window:requestClose', () => win?.close())
on('window:minimize', () => win?.minimize())
on('window:toggleMaximize', () => {
  if (!win) return
  if (win.isFullScreen()) win.setFullScreen(false)
  else if (win.isMaximized()) win.unmaximize()
  else win.maximize()
})
handle('window:isZoomed', () => isZoomed())
handle('window:canMove', () => !wayland)

// ---- Manual edge resize (frameless windows get no native handles on Linux) --

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
let resize: { edge: Edge; start: Electron.Rectangle; cursor: Electron.Point } | null = null

on('window:resizeStart', (_e, edge: Edge, x: number, y: number) => {
  if (!win || isZoomed()) return
  resize = { edge, start: win.getBounds(), cursor: { x, y } }
})
on('window:resizeMove', (_e, x: number, y: number) => {
  if (!win || !resize) return
  const { edge, start, cursor } = resize
  const [minW, minH] = win.getMinimumSize()
  const dx = x - cursor.x
  const dy = y - cursor.y
  const b = { ...start }
  if (edge.includes('e')) b.width = Math.max(minW, start.width + dx)
  if (edge.includes('s')) b.height = Math.max(minH, start.height + dy)
  if (edge.includes('w')) {
    b.width = Math.max(minW, start.width - dx)
    b.x = start.x + (start.width - b.width)
  }
  if (edge.includes('n')) {
    b.height = Math.max(minH, start.height - dy)
    b.y = start.y + (start.height - b.height)
  }
  win.setBounds(b)
})
on('window:resizeEnd', () => {
  resize = null
})
on('menu:suspend', (_e, on: boolean) => {
  if (recording === on) return
  recording = on
  buildMenu()
})
// The in-app menu (☰) asks for Electron's built-in actions by name; only these.
const MENU_ROLES = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'toggleDevTools', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen', 'reload', 'quit'])
on('menu:role', (e, role: string) => {
  if (!MENU_ROLES.has(role) || !win) return
  const wc = e.sender
  if (role === 'undo') wc.undo()
  else if (role === 'redo') wc.redo()
  else if (role === 'cut') wc.cut()
  else if (role === 'copy') wc.copy()
  else if (role === 'paste') wc.paste()
  else if (role === 'selectAll') wc.selectAll()
  else if (role === 'toggleDevTools') wc.toggleDevTools()
  else if (role === 'resetZoom') wc.setZoomLevel(0)
  else if (role === 'zoomIn') wc.setZoomLevel(wc.getZoomLevel() + 0.5)
  else if (role === 'zoomOut') wc.setZoomLevel(wc.getZoomLevel() - 0.5)
  else if (role === 'togglefullscreen') win.setFullScreen(!win.isFullScreen())
  else if (role === 'reload' && !app.isPackaged) wc.reload()
  else if (role === 'quit') app.quit()
})

// ---- Lifecycle -------------------------------------------------------------

// Wayland app id / X11 WM_CLASS must match the desktop file for the icon to show.
app.setName('Tendril')
if (process.platform === 'linux') app.setDesktopName('tendril.desktop')

// macOS delivers Finder / "Open with" files here instead of argv.
let pendingOpen: string | null = null
app.on('open-file', (e, path) => {
  e.preventDefault()
  if (win && !win.webContents.isLoading()) void openInWindow(path)
  else pendingOpen = path
})

async function openInWindow(path: string): Promise<void> {
  const read = await readTextFile(path)
  if ('error' in read) {
    await cannotOpen(path, read.error)
    return
  }
  allowAssetsIn(dirname(path))
  win?.webContents.send('file:opened', { path, content: read.text })
}

// ---- Command line: backup and uninstall helpers (no window) -------------------
//   tendril --export <file>          write a backup of the configuration
//   tendril --import <file>          restore one
//   tendril --remove-graph-markers   remove the graph markers put in your folders (uninstall)

const cli = ((): { cmd: 'export' | 'import' | 'remove-graph-markers'; file?: string } | null => {
  const args = process.argv.slice(app.isPackaged ? 1 : 2)
  for (const cmd of ['export', 'import', 'remove-graph-markers'] as const) {
    const i = args.indexOf(`--${cmd}`)
    if (i >= 0) return { cmd, file: args[i + 1] }
  }
  return null
})()
// Runs headless, so it also works over SSH or with no desktop at all.
if (cli && process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'headless')

async function runCli(c: NonNullable<typeof cli>): Promise<never> {
  app.dock?.hide()
  try {
    if (c.cmd === 'remove-graph-markers') {
      const removed = await removeGraphMarkers()
      process.stdout.write(removed.map((d) => `removed graph marker in ${d}`).join('\n') + (removed.length ? '\n' : ''))
    } else {
      if (!c.file || c.file.startsWith('-')) throw new Error(`Usage: tendril --${c.cmd} <file>`)
      const file = resolve(c.file)
      process.stdout.write((c.cmd === 'export' ? await exportBackup(file) : await importBackup(file)) + '\n')
    }
    app.exit(0)
  } catch (err) {
    process.stderr.write(`tendril: ${(err as Error).message}\n`)
    app.exit(1)
  }
  return new Promise<never>(() => {})
}

app.whenReady().then(async () => {
  if (cli) return runCli(cli)
  protocol.handle('asset', serveAsset)
  keybindings = (await loadSettings()).keybindings
  buildMenu()
  createWindow()
  void moveOpenRouterKeyToPass().catch(() => {})
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  quitting = true
})
app.on('will-quit', () => {
  killAllTerminals()
  closeRemote()
})
// Stopped from outside (logout, `kill`): close connections properly first.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    killAllTerminals()
    closeRemote()
    app.exit(0)
  })
}

app.on('window-all-closed', () => {
  if (relaunch) {
    app.relaunch()
    return app.quit()
  }
  if (process.platform !== 'darwin') app.quit()
})
