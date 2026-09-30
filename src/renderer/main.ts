import { EditorView, basicSetup } from 'codemirror'
import { Compartment, EditorState, type Extension, type StateEffect } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { CHART_CSS, PAGES_CSS, PROPERTIES_CSS, TABLE_CSS, renderBody, renderStandaloneHtml } from './markdown'
import { isPaged } from './pages'
import { parseFrontMatter } from './frontmatter'
import { hasToc, toggleToc, updateToc } from './toc'
import { extractHeadings } from './headings'
import type { Command, Session, SessionTab } from '../preload/index'
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
import { closePopup, installTableMenu, openInsertTablePicker, showMenu } from './tables/menu'
import { alertBox, confirmBox, errorMessage, isMessageBoxOpen, messageBox } from './messageBox'
import { embeddedImageEnv, imageDropPaste, imageEnv, initImages, openImageDialog, previewImageSrc } from './images'
import { openImageViewer } from './imageViewer'
import { linkPaste } from './linkPaste'
import { openPromptBar, promptStream, stopPrompt } from './promptBar'
import { IMAGE_FILE, rendersMarkdown } from './paths'
import { escapeHtml } from './escape'
import { initGraphPane, toggleGraphPane } from './graph/pane'
import { openChartDialog } from './charts/dialog'
import { chartAtLine } from './charts/editor'
import { softTabKeymap, tabSizeConfig } from './softTab'
import { initTabBar, renderTabs } from './tabBar'

mountIcons()

type Mode = 'edit' | 'split' | 'reading'

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T
const editorEl = $('#editor')
const previewEl = $('#preview')
const panesEl = $('#panes')
const filenameEl = $('#filename')
const statusPathEl = $('#status-path')

let mode: Mode = 'split'
// Settings are loaded (initAppearance); until then editor config uses defaults.
let appearanceReady = false
const currentTabSize = (): number => (appearanceReady ? settings().tabSize : 4)
const currentWrap = (): boolean => (appearanceReady ? settings().wrapText : true)

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
const tabSizeCompartment = new Compartment()
const wrapCompartment = new Compartment()

let renderTimer: number | undefined

/** Extensions for a fresh document state; the compartments are re-synced when its tab is shown. */
function editorExtensions(): Extension[] {
  return [
    basicSetup,
    // GFM base: tables, strikethrough and task lists parse (and live-preview) correctly.
    // URL-over-selection pasting is handled by linkPaste below (see there).
    markdown({ base: markdownLanguage, pasteURLAsLink: false }),
    themeCompartment.of(currentEditorTheme()),
    livePreviewCompartment.of([]),
    tabSizeCompartment.of(tabSizeConfig(currentTabSize())),
    // Tab between table cells; right-click a table for Word-like formatting.
    tableKeymap,
    // Elsewhere Tab inserts spaces (Settings › Editor › Tab size).
    softTabKeymap,
    multiCursor,
    keymapCompartment.of([]),
    imageDropPaste,
    linkPaste, // a URL pasted over a selection becomes [selection](url)
    promptStream, // tracks where a streaming "Prompt Me" reply goes; Escape stops it
    wrapCompartment.of(currentWrap() ? EditorView.lineWrapping : []),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        window.clearTimeout(renderTimer)
        renderTimer = window.setTimeout(renderPreview, 150)
        updateDirty()
      }
      if (u.docChanged || u.selectionSet) scheduleSession()
    })
  ]
}

// ---- Tabs -----------------------------------------------------------------

/**
 * One open document. There is a single EditorView; each tab keeps its own
 * EditorState (text, undo history, selection) and the view is switched
 * between them, so every editor feature keeps working on "the" view.
 */
interface Tab {
  id: number
  path: string | null
  /** The document while the tab is in the background; the shown tab's lives in `view`. */
  state: EditorState
  /** The text as last loaded or saved; the tab is dirty while the document differs. */
  saved: string
  /** The file's line ending. CodeMirror keeps lines, not separators, so the
   * editor text is always LF; the original ending is put back on save. */
  eol: '\n' | '\r\n'
  dirty: boolean
  /** Where the tab was scrolled when it was left; null = bring the caret into view. */
  scroll: { editor: StateEffect<unknown>; preview: number } | null
}

let tabSeq = 0
const tabs: Tab[] = []

/** CodeMirror's view of a text: every line break becomes LF. */
const lf = (text: string): string => text.replace(/\r\n?/g, '\n')

function makeTab(o: { content: string; path: string | null; saved?: string; eol?: '\n' | '\r\n'; anchor?: number; head?: number }): Tab {
  let state = EditorState.create({ doc: o.content, extensions: editorExtensions() })
  if (o.anchor || o.head) {
    const clamp = (n = 0): number => Math.min(n, state.doc.length)
    state = state.update({ selection: { anchor: clamp(o.anchor), head: clamp(o.head) } }).state
  }
  const doc = state.doc.toString()
  const saved = o.saved ?? doc
  return {
    id: ++tabSeq,
    path: o.path,
    state,
    saved,
    eol: o.eol ?? (o.content.includes('\r\n') ? '\r\n' : '\n'),
    dirty: doc !== saved,
    scroll: null
  }
}

// The welcome text is not the user's work: it is never kept or asked about.
let active = makeTab({ content: WELCOME, path: null })
tabs.push(active)

const view = new EditorView({ parent: editorEl, state: active.state })

installTableMenu(view, () => openPromptBar(view))
initImages({ view, docPath: () => active.path, save: () => save(false) })

function source(): string {
  return view.state.doc.toString()
}

/** The tab's current text, wherever its state lives. */
function textOf(tab: Tab): string {
  return tab === active ? source() : tab.state.doc.toString()
}

/** An untitled tab nobody has typed into: opening a file reuses it. */
const isBlank = (tab: Tab): boolean => !tab.path && !tab.dirty

const nameOf = (tab: Tab): string => (tab.path ? tab.path.split(/[\\/]/).pop()! : 'untitled.md')

function drawTabs(): void {
  renderTabs(tabs.map((t) => ({ id: t.id, title: nameOf(t), path: t.path, dirty: t.dirty })), active.id)
}

/** Put `tab` in the editor, keeping the one it replaces (text, undo, selection, scroll). */
async function activate(tab: Tab): Promise<void> {
  if (tab === active) return
  // A streaming reply writes into whatever the view shows: finish it first.
  await stopPrompt()
  closePopup()
  active.state = view.state
  active.scroll = { editor: view.scrollSnapshot(), preview: previewEl.scrollTop }
  active = tab
  view.setState(tab.state)
  syncEditorConfig()
  renderPreview()
  if (tab.scroll) {
    view.dispatch({ effects: tab.scroll.editor })
    previewEl.scrollTop = tab.scroll.preview
  } else {
    view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }) })
  }
  showActive()
  scheduleSession()
  if (mode !== 'reading') view.focus()
}

/** Title bar, file name, status bar, explorer and tab strip follow the shown tab. */
function showActive(): void {
  const path = active.path
  window.api.setTitle(path ?? '')
  filenameEl.textContent = nameOf(active)
  statusPathEl.textContent = path ?? ''
  sidebarFileOpened(path)
  updateDirty()
  drawTabs()
}

function insertTab(tab: Tab): void {
  tabs.splice(tabs.indexOf(active) + 1, 0, tab)
}

/**
 * Show a document: in its own tab if that file is already open, else in the
 * current tab when it is blank (the welcome text, an untouched New), else in a
 * new tab next to the current one.
 */
async function openDocument(content: string, path: string | null): Promise<void> {
  const open = path ? tabs.find((t) => t.path === path) : undefined
  if (open) return activate(open)
  const tab = makeTab({ content, path })
  if (isBlank(active)) tabs.splice(tabs.indexOf(active), 1, tab)
  else insertTab(tab)
  await activate(tab)
}

async function newTab(): Promise<void> {
  const tab = makeTab({ content: '', path: null })
  insertTab(tab)
  await activate(tab)
}

/** Close a tab, asking first when it has unsaved changes. The last tab is replaced by a blank one. */
async function closeTab(tab: Tab): Promise<void> {
  if (tab.dirty) {
    if (isMessageBoxOpen()) return
    await activate(tab)
    const choice = await messageBox({
      title: `Save changes to ${nameOf(tab)}?`,
      detail: "Your changes will be lost if you don't save them.",
      buttons: [{ label: 'Save', kind: 'primary' }, { label: "Don't Save", kind: 'danger' }, { label: 'Cancel' }],
      cancel: 2
    })
    if (choice === 2) return
    if (choice === 0 && !(await save(false))) return
  }
  const i = tabs.indexOf(tab)
  if (i < 0) return
  tabs.splice(i, 1)
  if (tabs.length === 0) tabs.push(makeTab({ content: '', path: null }))
  if (tab === active) await activate(tabs[Math.min(i, tabs.length - 1)])
  else drawTabs()
  window.api.setDirty(tabs.some((t) => t.dirty))
  scheduleSession()
}

async function cycleTab(step: 1 | -1): Promise<void> {
  const i = tabs.indexOf(active)
  await activate(tabs[(i + step + tabs.length) % tabs.length])
}

initTabBar({
  select: (id) => void run(() => activate(tabs.find((t) => t.id === id) ?? active)),
  close: (id) => {
    const tab = tabs.find((t) => t.id === id)
    if (tab) void run(() => closeTab(tab))
  },
  create: () => void run(newTab),
  move: (id, index) => {
    const from = tabs.findIndex((t) => t.id === id)
    if (from < 0) return
    const [tab] = tabs.splice(from, 1)
    tabs.splice(index, 0, tab)
    drawTabs()
    scheduleSession()
  }
})

// ---- Session (hot exit) ---------------------------------------------------

// Nothing is written until the last session has been read back, or the
// start-up tab would overwrite it.
let restored = false
let sessionTimer: number | undefined

/** The open tabs as the session keeps them: text only for unsaved work. */
function sessionSnapshot(): Session {
  const out: SessionTab[] = []
  let activeIndex = 0
  for (const t of tabs) {
    if (isBlank(t)) continue
    const state = t === active ? view.state : t.state
    if (t === active) activeIndex = out.length
    const { anchor, head } = state.selection.main
    out.push({ path: t.path, ...(t.dirty ? { content: state.doc.toString(), eol: t.eol } : {}), anchor, head })
  }
  return { tabs: out, active: activeIndex }
}

function scheduleSession(): void {
  if (!restored) return
  window.clearTimeout(sessionTimer)
  sessionTimer = window.setTimeout(() => void window.api.saveSession(sessionSnapshot()).catch(() => {}), 1000)
}

/** Reopen last time's tabs: clean files are re-read from disk, unsaved text comes from the session. */
async function restoreSession(): Promise<void> {
  try {
    const s = await window.api.loadSession()
    const back: Tab[] = []
    let shown: Tab | null = null
    for (const [i, st] of (s?.tabs ?? []).entries()) {
      const disk = st.path ? await window.api.readFile(st.path) : null
      let tab: Tab
      if (st.content === undefined) {
        if (!disk) continue // a saved file that has since gone: nothing of the user's is lost
        tab = makeTab({ content: disk.content, path: st.path, anchor: st.anchor, head: st.head })
      } else {
        // Unsaved text: dirty against the file as it is now (or against nothing, if it has gone).
        tab = makeTab({ content: st.content, path: st.path, saved: disk ? lf(disk.content) : '', eol: st.eol, anchor: st.anchor, head: st.head })
      }
      back.push(tab)
      if (i === s!.active) shown = tab
    }
    if (back.length === 0) return
    // The start-up tab goes, unless something was typed into it meanwhile.
    const kept = tabs.filter((t) => !isBlank(t))
    tabs.splice(0, tabs.length, ...back, ...kept)
    await activate(shown ?? back[0])
  } finally {
    restored = true
  }
}

function cursorLine(): number {
  return view.state.doc.lineAt(view.state.selection.main.head).number - 1
}

/** The shown tab's dirty flag, the window's (any tab), and the tab strip when it changes. */
function updateDirty(): void {
  const was = active.dirty
  active.dirty = source() !== active.saved
  filenameEl.classList.toggle('dirty', active.dirty)
  window.api.setDirty(tabs.some((t) => t.dirty))
  if (was !== active.dirty) drawTabs()
}

/** File > New from Template, or "New from Template Here…" in the explorer. */
async function newFromTemplate(folder: string | null): Promise<void> {
  const doc = await pickTemplate(folder)
  if (!doc) return
  await openDocument(doc.content, doc.path) // already saved where the user chose
  view.dispatch({ selection: { anchor: Math.min(doc.cursor, view.state.doc.length) }, scrollIntoView: true })
  if (mode === 'reading') setMode('split')
  view.focus()
}

/** Open a file from the sidebar (or anywhere else that has a path). */
async function openPath(path: string): Promise<void> {
  const open = tabs.find((t) => t.path === path)
  if (open) return activate(open)
  if (IMAGE_FILE.test(path)) return openImageViewer(path)
  const f = await window.api.readFile(path)
  if (f) await openDocument(f.content, f.path)
  else await alertBox('Cannot open file', `${path}\n\nTendril opens text files up to 10 MB; this one looks binary, is too large or could not be read. Images open in the viewer.`)
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

// ---- Preview --------------------------------------------------------------

function renderPreview(): void {
  const top = previewEl.scrollTop
  const src = source()
  const md = rendersMarkdown(active.path)
  previewEl.innerHTML = md ? renderBody(src, imageEnv(active.path, 'preview')) : `<pre class="plain-text"><code>${escapeHtml(src)}</code></pre>`
  previewEl.classList.toggle('paged', md && isPaged(src))
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

// Double-click a chart in the preview to edit it.
previewEl.addEventListener('dblclick', (e) => {
  const fig = (e.target as Element).closest<HTMLElement>('figure.chart[data-line], .chart-error[data-line]')
  if (!fig) return
  const block = chartAtLine(view.state, Number(fig.dataset.line))
  if (!block) return
  e.preventDefault()
  if (mode === 'reading') setMode('split')
  view.dispatch({ selection: { anchor: block.from }, scrollIntoView: true })
  openChartDialog(view, block.from)
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
function syncLivePreview(): void {
  if (!appearanceReady) return
  const on = settings().livePreview
  const inPlace = on && mode === 'edit' && rendersMarkdown(active.path)
  view.dispatch({ effects: livePreviewCompartment.reconfigure(inPlace ? livePreview((src) => previewImageSrc(active.path, src)) : []) })
  editorEl.classList.toggle('live-preview', inPlace)
  $('#toolbar button[data-cmd="toggleLivePreview"]').classList.toggle('active', on)
}

// ---- Commands -------------------------------------------------------------

/** Word-like refresh on save: update the TOC if the document has one. */
function refreshStructure(src: string): string {
  return hasToc(src) ? updateToc(src) : src
}

async function save(as = false): Promise<boolean> {
  const tab = active
  replaceSource(refreshStructure(source()))
  const content = source()
  const path = await window.api.saveFile(as ? null : tab.path, tab.eol === '\n' ? content : content.replace(/\n/g, tab.eol))
  if (!path) return false
  const pathChanged = path !== tab.path
  tab.path = path
  tab.saved = content
  if (tab !== active) {
    // Switched away while the save dialog was open.
    tab.dirty = textOf(tab) !== content
    drawTabs()
  } else {
    showActive()
    if (pathChanged) {
      // Relative images now resolve against the new folder, and a new extension may change how it previews.
      syncLivePreview()
      renderPreview()
    }
  }
  scheduleSession()
  return true
}

/**
 * The window is closing (main process asks). Like Sublime Text's hot exit
 * nothing is asked: the tabs, unsaved text included, go to the session and
 * come back on the next start.
 */
async function hotExit(): Promise<void> {
  window.clearTimeout(sessionTimer)
  // Still restoring: the stored session is intact, and overwriting it now would lose it.
  if (restored) {
    try {
      await window.api.saveSession(sessionSnapshot())
    } catch (err) {
      const close = await confirmBox('Could not keep your unsaved changes', `${errorMessage(err)}\n\nClose anyway? Unsaved changes will be lost.`, { ok: 'Close', danger: true })
      if (!close) return
    }
  }
  window.api.closeWindow()
}

const commands: Record<Command, () => void | Promise<void>> = {
  new: () => newTab(),
  open: async () => {
    const f = await window.api.openFile()
    if (f) await openDocument(f.content, f.path)
  },
  save: async () => {
    await save(false)
  },
  saveAs: async () => {
    await save(true)
  },
  hotExit,
  closeTab: () => closeTab(active),
  nextTab: () => cycleTab(1),
  prevTab: () => cycleTab(-1),
  exportHtml: async () => {
    const font = await exportFontCss(true)
    const env = await embeddedImageEnv(source(), active.path)
    await window.api.exportHtml(renderStandaloneHtml(source(), docTitle(), font, env), fileName())
  },
  exportPdf: async () => {
    const font = await exportFontCss(false)
    const s = settings()
    const html = renderStandaloneHtml(source(), docTitle(), font, imageEnv(active.path, 'pdf'), { mode: 'pdf', pdfFont: s.pdfFont })
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
  // Edits the chart under the cursor, or inserts a new one there.
  insertChart: () => {
    if (mode === 'reading') setMode('split')
    openChartDialog(view)
  },
  toggleWrap: async () => {
    await updateSettings({ wrapText: !settings().wrapText })
    syncEditorConfig()
  },
  toggleLivePreview: async () => {
    await updateSettings({ livePreview: !settings().livePreview })
    syncLivePreview()
  }
}

function fileName(): string {
  return nameOf(active)
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

/**
 * Everything a tab's state holds that follows the app rather than the
 * document: a background tab missed any change made while it was hidden.
 */
function syncEditorConfig(): void {
  view.dispatch({
    effects: [
      themeCompartment.reconfigure(currentEditorTheme()),
      tabSizeCompartment.reconfigure(tabSizeConfig(currentTabSize())),
      wrapCompartment.reconfigure(currentWrap() ? EditorView.lineWrapping : [])
    ]
  })
  previewEl.classList.toggle('nowrap', !currentWrap())
  syncLivePreview()
  syncKeybindings()
}

/** What to call it when a command fails (an IPC handler throwing: EACCES, disk full, …). */
const FAILURE: Partial<Record<Command, string>> = {
  open: 'Could not open the file',
  save: 'Could not save the file',
  saveAs: 'Could not save the file',
  closeTab: 'Could not save the file',
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

// Files opened before the last session is back (the command line's arrives
// on load) wait for it, so they land among its tabs rather than under them.
let sessionDone: () => void = () => {}
const sessionRestored = new Promise<void>((resolve) => (sessionDone = resolve))

window.api.onCommand((cmd) => void run(cmd))
// A file handed over by the OS (double-click, "Open with", the command line).
window.api.onOpenPath((f) => void run(async () => {
  await sessionRestored
  await openDocument(f.content, f.path)
}))
window.api.onTemplateNew((folder) => void run(() => newFromTemplate(folder)))
document.addEventListener('new-note', (e) => void run(() => newFromTemplate((e as CustomEvent<string | null>).detail)))
// A note went to the Trash: its tab keeps the text, but it is untitled now.
document.addEventListener('file-trashed', (e) => {
  const trashed = (e as CustomEvent<string>).detail
  const hit = tabs.filter((t) => t.path === trashed)
  if (hit.length === 0) return
  for (const t of hit) {
    t.path = null
    t.saved = ''
    t.dirty = textOf(t) !== ''
  }
  if (hit.includes(active)) showActive()
  else {
    drawTabs()
    window.api.setDirty(tabs.some((t) => t.dirty))
  }
  scheduleSession()
})
document.addEventListener('settings-changed', syncEditorConfig)

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
sharedCss.textContent = PROPERTIES_CSS + PAGES_CSS + TABLE_CSS + CHART_CSS
document.head.appendChild(sharedCss)

setMode('split')
renderPreview()
updateDirty()
drawTabs()
void initAppearance(view).then(() => {
  appearanceReady = true
  syncEditorConfig()
  // Last time's tabs come back before anything else is opened.
  void run(restoreSession, 'Could not restore the last session').finally(sessionDone)
  // Notes clicked in the graph open behind it, like any other open.
  initGraphPane((p) => void run(() => openPath(p), 'Could not open the file'))
  return initSidebar((p) => run(() => openPath(p), 'Could not open the file'))
})
view.focus()
