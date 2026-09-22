import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ObsidianTheme, ThemeDef } from '../main/themes'

export type { ObsidianTheme, ThemeDef, ThemePalette } from '../main/themes'
export type { Template, TemplateKind } from '../main/templates'
export type { Keybindings } from '../shared/keybindings'
import type { Template } from '../main/templates'

export type Command =
  | 'new'
  | 'open'
  | 'save'
  | 'saveAs'
  | 'saveAndClose'
  | 'exportHtml'
  | 'exportPdf'
  | 'toc'
  | 'viewEdit'
  | 'viewSplit'
  | 'viewReading'
  | 'cycleView'
  | 'settings'
  | 'toggleSidebar'
  | 'toggleLivePreview'
  | 'newFromTemplate'
  | 'confirmClose'
  | 'insertTable'
  | 'insertImage'

export interface OpenedFile {
  path: string
  content: string
}

export interface PdfOptions {
  /** Paged (report) documents get wider top/bottom margins for their cover and breaks. */
  paged: boolean
  title: string
  paper: 'A4' | 'Letter'
  /** Running title / date header and "Page n of m" footer. */
  header: boolean
}

export type Theme = 'light' | 'dark' | 'system'
export interface Settings {
  theme: Theme
  uiFont: string | null
  editorFont: string | null
  uiFontSize: number
  editorFontSize: number
  borderColor: string | null
  sidebarOpen: boolean
  sidebarWidth: number
  sidebarRoot: string | null
  themeId: string
  iconSet: 'lucide' | 'tabler' | 'phosphor'
  livePreview: boolean
  author: string
  templatesDir: string | null
  assetsFolder: string
  keybindings: Record<string, string>
  pdfPaper: 'A4' | 'Letter'
  pdfFont: 'editor' | 'sans' | 'serif'
  pdfHeader: boolean
  llmProvider: LlmProvider
  llmLocalUrl: string
  llmLocalModel: string
  /** Always '' when read: the key lives in the main process (see main/settings.ts). */
  openRouterKey: string
  /** Whether a key is stored, so the dialog can say so without holding it. */
  openRouterKeySet: boolean
  openRouterModel: string
}
export type LlmProvider = 'none' | 'local' | 'openrouter'
export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}
export interface DirListing {
  path: string
  parent: string | null
  entries: DirEntry[]
}
export interface NerdFont {
  name: string
  url: string
  sizeMb: number
  installed: boolean
}
export interface ImportedImage {
  /** Absolute path of the copied file. */
  path: string
  /** Path relative to the note's folder, posix separators, './' prefixed. */
  rel: string
}
export interface FontFamily {
  family: string
  pkg: string
  faces: { file: string; weight: number; style: 'normal' | 'italic' }[]
}

let llmSeq = 0
const llmListeners = new Map<number, (text: string) => void>()
ipcRenderer.on('llm:delta', (_e, id: number, text: string) => llmListeners.get(id)?.(text))

const api = {
  platform: process.platform,
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:set', patch),
  listNerdFonts: (): Promise<NerdFont[]> => ipcRenderer.invoke('fonts:list'),
  installedFamilies: (): Promise<FontFamily[]> => ipcRenderer.invoke('fonts:families'),
  fontCss: (family: string, embed: boolean): Promise<string> => ipcRenderer.invoke('fonts:css', family, embed),
  installNerdFont: (name: string): Promise<FontFamily[]> => ipcRenderer.invoke('fonts:install', name),
  uninstallNerdFont: (name: string): Promise<void> => ipcRenderer.invoke('fonts:uninstall', name),
  onFontProgress: (cb: (p: { name: string; pct: number }) => void): void => {
    ipcRenderer.on('fonts:progress', (_e, p) => cb(p))
  },
  listObsidianThemes: (): Promise<ObsidianTheme[]> => ipcRenderer.invoke('themes:list'),
  fetchObsidianTheme: (repo: string): Promise<{ css: string; name: string; author: string; modes: ('light' | 'dark')[] }> =>
    ipcRenderer.invoke('themes:fetch', repo),
  installedThemes: (): Promise<ThemeDef[]> => ipcRenderer.invoke('themes:installed'),
  saveTheme: (def: ThemeDef): Promise<void> => ipcRenderer.invoke('themes:save', def),
  uninstallTheme: (id: string): Promise<void> => ipcRenderer.invoke('themes:uninstall', id),
  openFile: (): Promise<OpenedFile | null> => ipcRenderer.invoke('file:open'),
  readFile: (path: string): Promise<OpenedFile | null> => ipcRenderer.invoke('file:read', path),
  saveFile: (path: string | null, content: string): Promise<string | null> =>
    ipcRenderer.invoke('file:save', path, content),
  exportHtml: (html: string, suggestedName: string): Promise<string | null> =>
    ipcRenderer.invoke('export:html', html, suggestedName),
  exportPdf: (html: string, suggestedName: string, opts: PdfOptions): Promise<string | null> =>
    ipcRenderer.invoke('export:pdf', html, suggestedName, opts),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  /**
   * "Prompt Me": the active provider's reply to `prompt`, with the selected text
   * as context. `onDelta` gets the text as it streams in; the promise resolves
   * with the whole reply, or null when the request was cancelled.
   */
  llmComplete: (prompt: string, selection: string, onDelta: (text: string) => void): Promise<string | null> => {
    const id = ++llmSeq
    llmListeners.set(id, onDelta)
    return ipcRenderer.invoke('llm:complete', id, prompt, selection).finally(() => llmListeners.delete(id))
  },
  /** Abort every in-flight completion (the editor runs one at a time). */
  llmCancel: (): void => ipcRenderer.send('llm:cancel'),
  /** Reach the active provider and check the model; resolves with a short status line. */
  llmTest: (): Promise<string> => ipcRenderer.invoke('llm:test'),
  showInFolder: (path: string): Promise<void> => ipcRenderer.invoke('shell:showInFolder', path),
  explorerContextMenu: (path: string, isDir: boolean, folder: string, isRoot: boolean): void =>
    ipcRenderer.send('explorer:contextMenu', path, isDir, folder, isRoot),
  onTrashRequest: (cb: (path: string) => void): void => {
    ipcRenderer.on('explorer:trash', (_e, path: string) => cb(path))
  },
  trashItem: (path: string): Promise<void> => ipcRenderer.invoke('shell:trash', path),
  openTrash: (): Promise<void> => ipcRenderer.invoke('shell:openTrash'),
  onTemplateNew: (cb: (folder: string) => void): void => {
    ipcRenderer.on('template:new', (_e, folder: string) => cb(folder))
  },
  listUserTemplates: (): Promise<Template[]> => ipcRenderer.invoke('templates:list'),
  openTemplatesFolder: (): Promise<string> => ipcRenderer.invoke('templates:openFolder'),
  defaultTemplatesDir: (): Promise<string> => ipcRenderer.invoke('templates:defaultDir'),
  fileExists: (path: string): Promise<boolean> => ipcRenderer.invoke('file:exists', path),
  ensureDir: (dir: string): Promise<void> => ipcRenderer.invoke('dir:ensure', dir),
  pickImages: (): Promise<string[]> => ipcRenderer.invoke('image:pick'),
  /** Copy a file (or raw bytes) into the assets folder; the name is de-duplicated. */
  importImage: (opts: { docDir: string; assetsDir: string; name: string; srcPath?: string; data?: ArrayBuffer }): Promise<ImportedImage> =>
    ipcRenderer.invoke('image:import', opts),
  fileDataUrl: (path: string): Promise<string | null> => ipcRenderer.invoke('file:dataUrl', path),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  listDir: (dir: string): Promise<DirListing> => ipcRenderer.invoke('dir:list', dir),
  homeDir: (): Promise<string> => ipcRenderer.invoke('dir:home'),
  pickDir: (current: string | null): Promise<string | null> => ipcRenderer.invoke('dir:pick', current),
  watchDir: (dir: string): void => ipcRenderer.send('dir:watch', dir),
  unwatchDir: (dir: string): void => ipcRenderer.send('dir:unwatch', dir),
  onDirChanged: (cb: (dir: string) => void): void => {
    ipcRenderer.on('dir:changed', (_e, dir: string) => cb(dir))
  },
  setDirty: (dirty: boolean): void => ipcRenderer.send('state:dirty', dirty),
  setTitle: (title: string): void => ipcRenderer.send('state:title', title),
  closeWindow: (): void => ipcRenderer.send('window:close'),
  requestClose: (): void => ipcRenderer.send('window:requestClose'),
  minimize: (): void => ipcRenderer.send('window:minimize'),
  toggleMaximize: (): void => ipcRenderer.send('window:toggleMaximize'),
  isZoomed: (): Promise<boolean> => ipcRenderer.invoke('window:isZoomed'),
  canMoveWindow: (): Promise<boolean> => ipcRenderer.invoke('window:canMove'),
  onWindowState: (cb: (zoomed: boolean) => void): void => {
    ipcRenderer.on('window:state', (_e, z: boolean) => cb(z))
  },
  popupMenu: (x: number, y: number): void => ipcRenderer.send('menu:popup', x, y),
  /** Keep menu accelerators from firing while a shortcut is being recorded. */
  suspendMenu: (on: boolean): void => ipcRenderer.send('menu:suspend', on),
  resizeStart: (edge: string, x: number, y: number): void => ipcRenderer.send('window:resizeStart', edge, x, y),
  resizeMove: (x: number, y: number): void => ipcRenderer.send('window:resizeMove', x, y),
  resizeEnd: (): void => ipcRenderer.send('window:resizeEnd'),
  onCommand: (cb: (cmd: Command) => void): void => {
    ipcRenderer.on('command', (_e, cmd: Command) => cb(cmd))
  },
  onOpenPath: (cb: (file: OpenedFile) => void): void => {
    ipcRenderer.on('file:opened', (_e, file: OpenedFile) => cb(file))
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
