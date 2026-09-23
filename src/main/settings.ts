import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Keybindings } from '../shared/keybindings'
import { writeFileAtomic } from './fsx'

export type Theme = 'light' | 'dark' | 'system'

export interface Settings {
  theme: Theme
  /** Font family names; null = built-in default. */
  uiFont: string | null
  editorFont: string | null
  /** Pixel sizes for the interface and for the editor (the preview scales with it). */
  uiFontSize: number
  editorFontSize: number
  /** CSS colour for the window boundary; null = theme default. */
  borderColor: string | null
  sidebarOpen: boolean
  sidebarWidth: number
  /** Last folder shown in the sidebar; null = folder of the first opened file, else home. */
  sidebarRoot: string | null
  /** Tag graph pane under the explorer: shown, and its height in pixels. */
  graphPaneOpen: boolean
  graphPaneHeight: number
  /** ThemeDef id: 'builtin:<slug>' or 'obsidian:<owner>/<repo>'. */
  themeId: string
  iconSet: 'lucide' | 'tabler' | 'phosphor'
  /** Render Markdown in place in Edit view (raw source on the cursor line). */
  livePreview: boolean
  /** Expands {{author}} in templates. */
  author: string
  /** Folder holding the user's templates; null = userData/templates. */
  templatesDir: string | null
  /** Name of the folder next to a note where inserted images are copied. */
  assetsFolder: string
  /** Shortcut overrides (command id → accelerator, "" = unbound); see shared/keybindings. */
  keybindings: Keybindings
  /** PDF export: paper size, body text face, running header/footer. */
  pdfPaper: 'A4' | 'Letter'
  pdfFont: 'editor' | 'sans' | 'serif'
  pdfHeader: boolean
  /** "Prompt Me": which OpenAI-compatible endpoint answers, if any. */
  llmProvider: LlmProvider
  /** Local server base URL (Ollama, LM Studio, llama.cpp, …) and model. */
  llmLocalUrl: string
  llmLocalModel: string
  /** OpenRouter key (encrypted with the OS keychain in settings.json where available) and model id. */
  openRouterKey: string
  openRouterModel: string
}

export type LlmProvider = 'none' | 'local' | 'openrouter'

/** What the renderer is given: the key itself stays in the main process. */
export type SafeSettings = Omit<Settings, 'openRouterKey'> & { openRouterKey: ''; openRouterKeySet: boolean }

/**
 * The OpenRouter key is the one secret the app holds, and the renderer has no
 * use for it: requests are made here (see llm.ts). Handing it over would put
 * it within reach of anything that ever runs in the page, so the renderer
 * learns only whether a key is set, and writes a new one without reading it.
 */
export function redact(s: Settings): SafeSettings {
  const { openRouterKey, ...rest } = s
  return { ...rest, openRouterKey: '', openRouterKeySet: !!openRouterKey.trim() }
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  uiFont: null,
  editorFont: null,
  uiFontSize: 13,
  editorFontSize: 14,
  borderColor: null,
  sidebarOpen: true,
  sidebarWidth: 240,
  sidebarRoot: null,
  graphPaneOpen: true,
  graphPaneHeight: 260,
  themeId: 'builtin:catppuccin',
  iconSet: 'lucide',
  livePreview: true,
  author: '',
  templatesDir: null,
  assetsFolder: 'assets',
  keybindings: {},
  pdfPaper: 'A4',
  pdfFont: 'editor',
  pdfHeader: true,
  llmProvider: 'none',
  llmLocalUrl: 'http://localhost:11434/v1',
  llmLocalModel: '',
  openRouterKey: '',
  openRouterModel: 'openai/gpt-4o-mini'
}

const file = (): string => join(app.getPath('userData'), 'settings.json')

// The file is read once; afterwards the main process owns the current
// settings and patches are applied in order, so two patches in flight at the
// same time (a spinner's input + change, a theme change during a font
// install) cannot both start from the same stale file and lose one.
let current: Promise<Settings> | null = null
let writing: Promise<unknown> = Promise.resolve()

// The OpenRouter key is kept encrypted on disk when the OS keychain is
// available (safeStorage); in memory and over IPC it is plain text.
interface Stored extends Partial<Settings> {
  openRouterKeyEncrypted?: string
}

const canEncrypt = (): boolean => {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function fromDisk(raw: Stored): Settings {
  const { openRouterKeyEncrypted, ...rest } = raw
  const s: Settings = { ...DEFAULT_SETTINGS, ...rest }
  if (openRouterKeyEncrypted && canEncrypt()) {
    try {
      s.openRouterKey = safeStorage.decryptString(Buffer.from(openRouterKeyEncrypted, 'base64'))
    } catch {
      /* keychain changed: the key is gone, the user enters it again */
    }
  }
  return s
}

function toDisk(s: Settings): Stored {
  if (!s.openRouterKey || !canEncrypt()) return s
  const { openRouterKey, ...rest } = s
  return { ...rest, openRouterKeyEncrypted: safeStorage.encryptString(openRouterKey).toString('base64') }
}

async function readFile(): Promise<Settings> {
  let text: string
  try {
    text = await fs.readFile(file(), 'utf8')
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
  try {
    const raw = JSON.parse(text) as Stored
    // A key saved in plain text by an earlier version is re-saved encrypted.
    if (raw.openRouterKey && canEncrypt()) void saveSettings({})
    return fromDisk(raw)
  } catch {
    // Unreadable JSON: keep it beside the fresh file rather than overwrite it on the next save.
    await fs.copyFile(file(), file() + '.corrupt').catch(() => {})
    return { ...DEFAULT_SETTINGS }
  }
}

export function loadSettings(): Promise<Settings> {
  return (current ??= readFile()).then((s) => ({ ...s }))
}

export function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = (current ??= readFile()).then((s) => ({ ...s, ...patch }))
  current = next
  // Writes go out one at a time in patch order; the last one wins on disk.
  const write = writing.then(async () => {
    const s = await next
    await fs.mkdir(app.getPath('userData'), { recursive: true })
    await writeFileAtomic(file(), JSON.stringify(toDisk(s), null, 2))
    return s
  })
  writing = write.catch(() => {})
  return write.then((s) => ({ ...s }))
}
