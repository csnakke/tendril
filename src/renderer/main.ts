import { EditorView, basicSetup } from 'codemirror'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { PAGES_CSS, PROPERTIES_CSS, TABLE_CSS, renderBody, renderStandaloneHtml } from './markdown'
import { isPaged } from './pages'
import { parseFrontMatter } from './frontmatter'
import { hasToc, toggleToc, updateToc } from './toc'
import { extractHeadings } from './headings'
import type { Command } from '../preload/index'
import { currentEditorTheme, exportFontCss, initAppearance, settings, themeCompartment, updateSettings } from './appearance'
import { livePreview } from './livePreview'
import { multiCursor, multiCursorKeymap } from './multiCursor'
import { formatAccelerator, resolveBindings } from '../shared/keybindings'
import { openSettings } from './settingsDialog'
import { initSidebar, sidebarFileOpened, toggleSidebar } from './sidebar'
import { mountIcons } from './icons/index'
import { fetchObsidianPalette } from './themes/settings'
import { pickTemplate } from './templatePicker'
import { currentRoot } from './sidebar'
import { tableKeymap } from './tables/editor'
import { installTableMenu, openInsertTablePicker, showMenu } from './tables/menu'
import { alertBox, confirmBox, errorMessage, isMessageBoxOpen, messageBox } from './messageBox'
import { embeddedImageEnv, imageDropPaste, imageEnv, initImages, openImageDialog, previewImageSrc } from './images'
import { openImageViewer } from './imageViewer'
import { linkPaste } from './linkPaste'
import { openPromptBar, promptStream } from './promptBar'
import { IMAGE_FILE, TEXT_FILE } from './paths'
import { initGraphPane, toggleGraphPane } from './graph/pane'

mountIcons()

type Mode = 'edit' | 'split' | 'reading'

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T
const editorEl = $('#editor')
const previewEl = $('#preview')
const panesEl = $('#panes')
const filenameEl = $('#filename')
const statusPathEl = $('#status-path')

let filePath: string | null = null
let savedContent = ''  // set to WELCOME once the editor exists
// The file's line ending. CodeMirror keeps lines, not separators, so the
// editor text is always LF; the original ending is put back on save.
let eol: '\n' | '\r\n' = '\n'
let mode: Mode = 'split'

const WELCOME = `# Untitled

<!-- toc -->
<!-- tocstop -->

## Getting started

Type Markdown on the left; the preview on the right updates live.

### Table of contents

Press **Ctrl+Shift+T** (or the TOC button) to insert a linked TOC between
\`<!-- toc -->\` markers, and again to remove it. It is refreshed on every save and
written into the file as plain Markdown, so links work here, on GitHub, GitBook, and
in exported HTML/PDF.

## Views

**Ctrl+E** toggles Edit / Reading. **Ctrl+1 / 2 / 3** pick Edit / Split / Reading.
`

// ---- Editor ---------------------------------------------------------------

const livePreviewCompartment = new Compartment()
const keymapCompartment = new Compartment()

let renderTimer: number | undefined

/** Extensions for a fresh document state; the compartments are re-synced after `loadDocument`. */
function editorExtensions(): Extension[] {
  return [
    basicSetup,
    // GFM base: tables, strikethrough and task lists parse (and live-preview) correctly.
    // URL-over-selection pasting is handled by linkPaste below (see there).
    markdown({ base: markdownLanguage, pasteURLAsLink: false }),
    themeCompartment.of(currentEditorTheme()),
    livePreviewCompartment.of([]),
    // Tab between table cells; right-click a table for Word-like formatting.
    tableKeymap,
    multiCursor,
    keymapCompartment.of([]),
    imageDropPaste,
    linkPaste, // a URL pasted over a selection becomes [selection](url)
    promptStream, // tracks where a streaming "Prompt Me" reply goes; Escape stops it
    EditorView.lineWrapping,
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return
      window.clearTimeout(renderTimer)
      renderTimer = window.setTimeout(renderPreview, 150)
      updateDirty()
    })
  ]
}

const view = new EditorView({ parent: editorEl, state: EditorState.create({ doc: WELCOME, extensions: editorExtensions() }) })

installTableMenu(view, () => openPromptBar(view))
initImages({ view, docPath: () => filePath, save: () => save(false) })

// The welcome text is not the user's work: don't prompt to discard it.
savedContent = WELCOME

function source(): string {
  return view.state.doc.toString()
}

/**
 * Replace the document as one undoable change. Only the part that differs is
 * touched (common prefix and suffix are kept), so the selection and scroll
 * position map through unchanged wherever the edit is elsewhere.
 */
function replaceSource(next: string): void {
  const cur = source()
  if (next === cur) return
  let from = 0
  const max = Math.min(cur.length, next.length)
  while (from < max && cur.charCodeAt(from) === next.charCodeAt(from)) from++
  let suffix = 0
  while (suffix < max - from && cur.charCodeAt(cur.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)) suffix++
  view.dispatch({ changes: { from, to: cur.length - suffix, insert: next.slice(from, next.length - suffix) }, scrollIntoView: true })
}

function loadDocument(content: string, path: string | null): void {
  filePath = path
  eol = content.includes('\r\n') ? '\r\n' : '\n'
  // A fresh state: the previous document must not be reachable through undo.
  view.setState(EditorState.create({ doc: content, extensions: editorExtensions() }))
  syncLivePreview()
  syncKeybindings()
  savedContent = source()
  // A new state fires no update listener, so refresh manually.
  renderPreview()
  updateDirty()
  window.api.setTitle(path ?? '')
  filenameEl.textContent = path ? path.split(/[\\/]/).pop()! : 'untitled.md'
  statusPathEl.textContent = path ?? ''
  sidebarFileOpened(path)
}

/** File > New from Template, or "New from Template Here…" in the explorer. */
async function newFromTemplate(folder: string | null): Promise<void> {
  if (!(await confirmDiscard())) return
  const doc = await pickTemplate(folder)
  if (!doc) return
  loadDocument(doc.content, doc.path) // already saved where the user chose
  view.dispatch({ selection: { anchor: doc.cursor }, scrollIntoView: true })
  if (mode === 'reading') setMode('split')
  view.focus()
}

/** Open a file from the sidebar (or anywhere else that has a path). */
async function openPath(path: string): Promise<void> {
  if (path === filePath) return
  if (IMAGE_FILE.test(path)) return openImageViewer(path)
  if (!TEXT_FILE.test(path)) return alertBox('Cannot open file', 'Tendril opens Markdown, text and HTML files; images open in the viewer.')
  if (!(await confirmDiscard())) return
  const f = await window.api.readFile(path)
  if (f) loadDocument(f.content, f.path)
  else await alertBox('Cannot read file', path)
}

function cursorLine(): number {
  return view.state.doc.lineAt(view.state.selection.main.head).number - 1
}

function updateDirty(): void {
  const dirty = source() !== savedContent
  filenameEl.classList.toggle('dirty', dirty)
  window.api.setDirty(dirty)
}

// ---- Preview --------------------------------------------------------------

function renderPreview(): void {
  const top = previewEl.scrollTop
  const src = source()
  previewEl.innerHTML = renderBody(src, imageEnv(filePath, 'preview'))
  previewEl.classList.toggle('paged', isPaged(src))
  previewEl.scrollTop = top
}

// In-preview anchor jumps (TOC links) scroll instead of navigating.
previewEl.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a')
  if (!a) return
  const href = a.getAttribute('href') ?? ''
  e.preventDefault()
  if (href.startsWith('#')) {
    const id = decodeURIComponent(href.slice(1))
    const el = previewEl.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } else if (/^https?:/.test(href)) {
    void window.api.openExternal(href)
  }
})

// Proportional scroll sync in split mode.
let syncing = false
function syncScroll(from: HTMLElement, to: HTMLElement): void {
  if (syncing || mode !== 'split') return
  const max = from.scrollHeight - from.clientHeight
  if (max <= 0) return
  syncing = true
  to.scrollTop = (from.scrollTop / max) * (to.scrollHeight - to.clientHeight)
  requestAnimationFrame(() => (syncing = false))
}
view.scrollDOM.addEventListener('scroll', () => syncScroll(view.scrollDOM, previewEl))
previewEl.addEventListener('scroll', () => syncScroll(previewEl, view.scrollDOM))

function setMode(next: Mode): void {
  mode = next
  panesEl.dataset.mode = next
  document.querySelectorAll<HTMLButtonElement>('#modes button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === next)
  })
  syncLivePreview()
  if (next !== 'reading') view.focus()
}

/** Live preview renders in place only in Edit view; Split already shows a preview. */
let appearanceReady = false
function syncLivePreview(): void {
  if (!appearanceReady) return
  const on = settings().livePreview
  const active = on && mode === 'edit'
  view.dispatch({ effects: livePreviewCompartment.reconfigure(active ? livePreview((src) => previewImageSrc(filePath, src)) : []) })
  editorEl.classList.toggle('live-preview', active)
  $('#toolbar button[data-cmd="toggleLivePreview"]').classList.toggle('active', on)
}

// ---- Commands -------------------------------------------------------------

/** Word-like refresh on save: update the TOC if the document has one. */
function refreshStructure(src: string): string {
  return hasToc(src) ? updateToc(src) : src
}

async function save(as = false): Promise<boolean> {
  replaceSource(refreshStructure(source()))
  const content = source()
  const path = await window.api.saveFile(as ? null : filePath, eol === '\n' ? content : content.replace(/\n/g, eol))
  if (!path) return false
  const pathChanged = path !== filePath
  filePath = path
  savedContent = content
  updateDirty()
  window.api.setTitle(path)
  filenameEl.textContent = path.split(/[\\/]/).pop()!
  statusPathEl.textContent = path
  sidebarFileOpened(path)
  if (pathChanged) syncLivePreview() // relative images now resolve against the new folder
  return true
}

async function confirmDiscard(): Promise<boolean> {
  if (source() === savedContent) return true
  return confirmBox('Discard unsaved changes?', `Your edits to ${fileName()} will be lost.`, { ok: 'Discard', danger: true })
}

/** The window is closing with unsaved edits (main process asks). */
async function confirmClose(): Promise<void> {
  if (isMessageBoxOpen()) return
  const choice = await messageBox({
    title: `Save changes to ${fileName()}?`,
    detail: "Your changes will be lost if you don't save them.",
    buttons: [{ label: 'Save', kind: 'primary' }, { label: "Don't Save", kind: 'danger' }, { label: 'Cancel' }],
    cancel: 2
  })
  if (choice === 0) await commands.saveAndClose()
  else if (choice === 1) window.api.closeWindow()
}

const commands: Record<Command, () => void | Promise<void>> = {
  new: async () => {
    if (await confirmDiscard()) loadDocument('', null)
  },
  open: async () => {
    if (!(await confirmDiscard())) return
    const f = await window.api.openFile()
    if (f) loadDocument(f.content, f.path)
  },
  save: async () => {
    await save(false)
  },
  saveAs: async () => {
    await save(true)
  },
  saveAndClose: async () => {
    if (await save(false)) window.api.closeWindow()
  },
  confirmClose,
  exportHtml: async () => {
    const font = await exportFontCss(true)
    const env = await embeddedImageEnv(source(), filePath)
    await window.api.exportHtml(renderStandaloneHtml(source(), docTitle(), font, env), fileName())
  },
  exportPdf: async () => {
    const font = await exportFontCss(false)
    const s = settings()
    const html = renderStandaloneHtml(source(), docTitle(), font, imageEnv(filePath, 'pdf'), { mode: 'pdf', pdfFont: s.pdfFont })
    await window.api.exportPdf(html, fileName(), { paged: isPaged(source()), title: docTitle(), paper: s.pdfPaper, header: s.pdfHeader })
  },
  toc: () => replaceSource(toggleToc(source(), cursorLine())),
  viewEdit: () => setMode('edit'),
  viewSplit: () => setMode('split'),
  viewReading: () => setMode('reading'),
  cycleView: () => setMode(mode === 'reading' ? 'edit' : 'reading'),
  settings: () => openSettings(),
  toggleSidebar: () => toggleSidebar(),
  toggleGraphPane: () => toggleGraphPane(),
  newFromTemplate: () => newFromTemplate(currentRoot()),
  insertImage: () => {
    if (mode === 'reading') setMode('split')
    openImageDialog()
  },
  insertTable: () => {
    if (mode === 'reading') setMode('split')
    openInsertTablePicker(view, $('#insert-table-btn'))
  },
  toggleLivePreview: async () => {
    await updateSettings({ livePreview: !settings().livePreview })
    syncLivePreview()
  }
}

function fileName(): string {
  return filePath ? filePath.split(/[\\/]/).pop()! : 'untitled.md'
}

function docTitle(): string {
  const fmTitle = parseFrontMatter(source())?.data['title']
  if (typeof fmTitle === 'string' && fmTitle.trim()) return fmTitle.trim()
  const h1 = extractHeadings(source()).find((h) => h.level === 1)
  return h1?.plain ?? fileName().replace(/\.(md|markdown|txt|html?)$/i, '')
}

/** Editor keymap and toolbar tooltips follow Settings > Keybindings. */
function syncKeybindings(): void {
  if (!appearanceReady) return
  const overrides = settings().keybindings
  view.dispatch({ effects: keymapCompartment.reconfigure(multiCursorKeymap(overrides)) })
  const keys = resolveBindings(overrides)
  document.querySelectorAll<HTMLElement>('[data-cmd][title]').forEach((b) => {
    b.dataset.title ??= b.title.replace(/\s*\([^()]*\)$/, '')
    const combo = formatAccelerator(keys[b.dataset.cmd!] ?? '', window.api.platform).join('+')
    b.title = combo ? `${b.dataset.title} (${combo})` : b.dataset.title
  })
}

/** What to call it when a command fails (an IPC handler throwing: EACCES, disk full, …). */
const FAILURE: Partial<Record<Command, string>> = {
  open: 'Could not open the file',
  save: 'Could not save the file',
  saveAs: 'Could not save the file',
  saveAndClose: 'Could not save the file',
  exportHtml: 'Could not export HTML',
  exportPdf: 'Could not export PDF'
}

/** Run a command; its failure is shown, not swallowed. */
async function run(cmd: Command | (() => void | Promise<void>), title = 'Something went wrong'): Promise<void> {
  try {
    if (typeof cmd === 'string') await commands[cmd]?.()
    else await cmd()
  } catch (err) {
    await alertBox(typeof cmd === 'string' ? FAILURE[cmd] ?? title : title, errorMessage(err))
  }
}

window.api.onCommand((cmd) => void run(cmd))
// A file handed over by the OS (double-click, "Open with", the command line).
window.api.onOpenPath((f) => void run(async () => {
  if (f.path === filePath || !(await confirmDiscard())) return
  loadDocument(f.content, f.path)
}))
window.api.onTemplateNew((folder) => void run(() => newFromTemplate(folder)))
document.addEventListener('new-note', (e) => void run(() => newFromTemplate((e as CustomEvent<string | null>).detail)))
// The open note went to the Trash: keep its text, but it is untitled now.
document.addEventListener('file-trashed', (e) => {
  if ((e as CustomEvent<string>).detail !== filePath) return
  filePath = null
  savedContent = ''
  updateDirty()
  window.api.setTitle('')
  filenameEl.textContent = 'untitled.md'
  statusPathEl.textContent = ''
  sidebarFileOpened(null)
})
document.addEventListener('settings-changed', syncLivePreview)
document.addEventListener('settings-changed', syncKeybindings)

document.querySelectorAll<HTMLButtonElement>('#toolbar button[data-cmd]').forEach((b) => {
  b.addEventListener('click', () => void run(b.dataset.cmd as Command))
})
const exportBtn = $('#export-btn')
exportBtn.addEventListener('click', () => {
  const r = exportBtn.getBoundingClientRect()
  showMenu(
    [
      { label: 'Export to HTML…', run: () => void run('exportHtml') },
      { label: 'Export to PDF…', run: () => void run('exportPdf') }
    ],
    r.left,
    r.bottom + 4
  )
})

// ---- Window chrome ------------------------------------------------------------

// macOS puts window controls on the left; CSS reorders the toolbar on it.
document.documentElement.dataset.platform = window.api.platform

const menuBtn = $('#menu-btn')
menuBtn.addEventListener('click', () => {
  const r = menuBtn.getBoundingClientRect()
  window.api.popupMenu(r.left, r.bottom)
})
document.querySelectorAll<HTMLButtonElement>('#win-controls button').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.dataset.win === 'minimize') window.api.minimize()
    else if (b.dataset.win === 'maximize') window.api.toggleMaximize()
    else window.api.requestClose()
  })
})
$('#toolbar').addEventListener('dblclick', (e) => {
  if ((e.target as HTMLElement).closest('button, select, input')) return
  window.api.toggleMaximize()
})
document.querySelectorAll<HTMLDivElement>('#resize-handles div').forEach((h) => {
  h.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    try {
      h.setPointerCapture(e.pointerId)
    } catch {
      /* capture is an optimisation; window-level listeners below still work */
    }
    window.api.resizeStart(h.dataset.edge!, e.screenX, e.screenY)
    const move = (ev: PointerEvent): void => window.api.resizeMove(ev.screenX, ev.screenY)
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.api.resizeEnd()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  })
})

function setZoomed(z: boolean): void {
  document.documentElement.dataset.zoomed = String(z)
}
window.api.onWindowState(setZoomed)
void window.api.isZoomed().then(setZoomed)
// Where the window cannot be repositioned (Wayland), only right/bottom handles make sense.
void window.api.canMoveWindow().then((can) => {
  document.documentElement.dataset.fixedOrigin = String(!can)
})

// Dev hooks for scripts and TENDRIL_AUTOJS automation. `npm run import-theme`
// drives the production build, so these stay put; what makes them reachable —
// TENDRIL_AUTOJS — is refused in a packaged app (see main/index.ts).
;(window as Window & { __editor?: EditorView }).__editor = view
;(window as Window & { __importObsidianTheme?: typeof fetchObsidianPalette }).__importObsidianTheme = fetchObsidianPalette

// ---- Init -----------------------------------------------------------------

// Preview shares the properties/pages CSS with exports so both look alike.
const sharedCss = document.createElement('style')
sharedCss.textContent = PROPERTIES_CSS + PAGES_CSS + TABLE_CSS
document.head.appendChild(sharedCss)

setMode('split')
renderPreview()
updateDirty()
void initAppearance(view).then(() => {
  appearanceReady = true
  syncLivePreview()
  syncKeybindings()
  // Notes clicked in the graph open behind it, like any other open.
  initGraphPane((p) => void run(() => openPath(p), 'Could not open the file'))
  return initSidebar((p) => run(() => openPath(p), 'Could not open the file'))
})
view.focus()
