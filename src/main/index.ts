import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, protocol, shell, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type WebFrameMain } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
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

type Command = string

// Native Wayland has no global window coordinates: a frameless window can be
// resized from its right/bottom edges (size is client-controlled) but never
// moved, so top/left edge resizing is unavailable there. Forcing X11 under
// XWayland is not an option: the window never appears (GNOME 49 + Electron 44).
const wayland = process.platform === 'linux' && !!process.env['WAYLAND_DISPLAY'] && !process.argv.includes('--ozone-platform=x11')

let win: BrowserWindow | null = null
let dirty = false
let forceClose = false

const MD_FILTERS = [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt', 'html', 'htm'] }]
const TEXT_FILE = /\.(md|markdown|txt|html?)$/i

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
        isMac ? { role: 'close' } : { role: 'quit' }
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
        { label: 'Live Preview in Edit View', accelerator: acc('toggleLivePreview'), click: () => send('toggleLivePreview') },
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
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [{ role: 'close' as const }])] }
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

  // Unsaved changes: the renderer shows a themed Save / Don't Save / Cancel
  // box and answers with 'saveAndClose' or window:close.
  win.on('close', (e) => {
    if (forceClose || !dirty) return
    e.preventDefault()
    send('confirmClose')
  })

  win.on('closed', () => {
    win = null
    unwatchAll()
    unwatchGraph()
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
  const argPath = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => /\.(md|markdown|txt)$/i.test(a))
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
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: MD_FILTERS })
  if (r.canceled || r.filePaths.length === 0) return null
  const path = r.filePaths[0]
  if (!TEXT_FILE.test(path)) {
    await dialog.showMessageBox(win!, { type: 'warning', message: 'Cannot open file', detail: 'Tendril opens Markdown, text and HTML files.' })
    return null
  }
  allowAssetsIn(dirname(path))
  return { path, content: await fs.readFile(path, 'utf8') }
})

handle('file:read', async (_e, path: string) => {
  if (!TEXT_FILE.test(path)) return null // never load binaries into the editor
  try {
    const content = await fs.readFile(path, 'utf8')
    allowAssetsIn(dirname(path))
    return { path, content }
  } catch {
    return null
  }
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

handle('dir:list', (_e, dir: string) => listDir(dir))
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
    ...(isRoot ? [] : [{ type: 'separator' as const }, { label: 'Move to Trash', click: () => e.sender.send('explorer:trash', path) }])
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

/** Copy an image into the assets folder under a safe, unique name; answer with the note-relative path. */
handle('image:import', async (_e, o: { docDir: string; assetsDir: string; name: string; srcPath?: string; data?: ArrayBuffer }) => {
  await fs.mkdir(o.assetsDir, { recursive: true })
  allowAssetsIn(o.assetsDir)
  const ext = extname(o.name).toLowerCase() || '.png'
  const stem = basename(o.name, extname(o.name)).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'image'
  let target = join(o.assetsDir, stem + ext)
  for (let n = 1; await fs.access(target).then(() => true, () => false); n++) target = join(o.assetsDir, `${stem}-${n}${ext}`)
  if (o.srcPath) await fs.copyFile(o.srcPath, target)
  else if (o.data) await fs.writeFile(target, Buffer.from(o.data))
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

// ---- Settings & fonts ------------------------------------------------------

handle('settings:get', async () => redact(await loadSettings()))
handle('settings:set', async (_e, patch: Partial<Settings>) => {
  const next = await saveSettings(patch)
  if ('keybindings' in patch) {
    keybindings = next.keybindings
    buildMenu()
  }
  return redact(next)
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
  dirty = d
  win?.setDocumentEdited(d)
})

on('state:title', (_e, title: string) => {
  win?.setTitle(title ? `${basename(title)} — Tendril` : 'Tendril')
})

on('window:close', () => {
  forceClose = true
  win?.close()
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
on('menu:popup', (_e, x: number, y: number) => {
  Menu.getApplicationMenu()?.popup({ window: win!, x: Math.round(x), y: Math.round(y) })
})

// ---- AppImage desktop integration ------------------------------------------

/** Append a tEXt chunk to a PNG buffer (used for freedesktop thumbnail metadata). */
function pngWithText(png: Buffer, fields: Record<string, string>): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunks = Object.entries(fields).map(([k, v]) => {
    const data = Buffer.concat([Buffer.from('tEXt'), Buffer.from(k, 'latin1'), Buffer.of(0), Buffer.from(v, 'latin1')])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length - 4)
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(data))
    return Buffer.concat([len, data, c])
  })
  // Insert right after the IHDR chunk (8-byte signature + 4 len + 4 type + 13 data + 4 crc).
  const at = 8 + 4 + 4 + 13 + 4
  return Buffer.concat([png.subarray(0, at), ...chunks, png.subarray(at)])
}

/**
 * A bare AppImage has no launcher entry, so GNOME/KDE show a generic icon for
 * the window and the file. Register one under ~/.local/share pointing at the
 * current AppImage path (rewritten whenever the path changes), and write
 * freedesktop thumbnails so file managers show the icon on the file itself.
 */
async function integrateAppImage(): Promise<void> {
  const image = process.env['APPIMAGE']
  if (process.platform !== 'linux' || !image) return
  try {
    const share = process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share')
    const themeDir = join(share, 'icons', 'hicolor')
    const iconDir = join(themeDir, '512x512', 'apps')
    const appDir = join(share, 'applications')
    await fs.mkdir(iconDir, { recursive: true })
    await fs.mkdir(appDir, { recursive: true })

    const icon = nativeImage.createFromPath(join(app.getAppPath(), 'icons/icon.png'))
    await fs.writeFile(join(iconDir, 'tendril.png'), icon.resize({ width: 512, height: 512 }).toPNG(), { mode: 0o644 })
    // A stale icon-theme.cache hides new icons; rebuild it or force a rescan.
    await new Promise<void>((resolve) => {
      execFile('gtk-update-icon-cache', ['-f', '-t', themeDir], () => resolve())
    })
    const now = new Date()
    await fs.utimes(themeDir, now, now).catch(() => {})

    // Desktop Entry spec: inside a quoted argument these are escaped, and a
    // path with a newline in it cannot be written down at all.
    if (/[\r\n]/.test(image)) return
    const exec = image.replace(/(["`$\\])/g, '\\$1')
    const entry = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Tendril',
      'Comment=Markdown editor with a Word-like table of contents',
      `Exec="${exec}" %F`,
      'Icon=tendril',
      'Terminal=false',
      'Categories=Office;TextEditor;',
      'MimeType=text/markdown;',
      'StartupWMClass=tendril',
      ''
    ].join('\n')
    const file = join(appDir, 'tendril.desktop')
    const current = await fs.readFile(file, 'utf8').catch(() => '')
    if (current !== entry) await fs.writeFile(file, entry, 'utf8')

    // Thumbnails for the AppImage file itself (freedesktop thumbnail spec).
    const uri = pathToFileURL(image).href
    const mtime = String(Math.floor((await fs.stat(image)).mtimeMs / 1000))
    const hash = createHash('md5').update(uri).digest('hex')
    const cache = process.env['XDG_CACHE_HOME'] || join(homedir(), '.cache')
    for (const [dir, size] of [['normal', 128], ['large', 256], ['x-large', 512], ['xx-large', 1024]] as const) {
      const out = join(cache, 'thumbnails', dir)
      await fs.mkdir(out, { recursive: true })
      const png = pngWithText(icon.resize({ width: size, height: size }).toPNG(), { 'Thumb::URI': uri, 'Thumb::MTime': mtime })
      await fs.writeFile(join(out, `${hash}.png`), png, { mode: 0o600 })
    }
    // Drop any earlier "failed thumbnail" marker so the file manager retries.
    await fs.rm(join(cache, 'thumbnails', 'fail', 'gnome-thumbnail-factory', `${hash}.png`), { force: true })
  } catch {
    /* integration is best-effort */
  }
}

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
  if (!TEXT_FILE.test(path)) return
  try {
    const content = await fs.readFile(path, 'utf8')
    allowAssetsIn(dirname(path))
    win?.webContents.send('file:opened', { path, content })
  } catch {
    /* ignore unreadable file */
  }
}

app.whenReady().then(async () => {
  protocol.handle('asset', serveAsset)
  void integrateAppImage()
  keybindings = (await loadSettings()).keybindings
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
