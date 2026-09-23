import { Compartment, type Extension } from '@codemirror/state'
import type { EditorView } from 'codemirror'
import lightCss from 'github-markdown-css/github-markdown-light.css?raw'
import darkCss from 'github-markdown-css/github-markdown-dark.css?raw'
import type { Settings, ThemeDef, ThemePalette } from '../preload/index'
import { BUILTIN_THEMES } from './themes/builtin'
import { FALLBACK, applyChrome, editorExtension, previewCss } from './themes/apply'
import { setIconSet } from './icons/index'

export const UI_FONT_DEFAULT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif'
export const EDITOR_FONT_DEFAULT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

export const themeCompartment = new Compartment()

let view: EditorView
let current: Settings
let installed: ThemeDef[] = []
let palette: ThemePalette = FALLBACK.light

const media = window.matchMedia('(prefers-color-scheme: dark)')

function styleEl(id: string): HTMLStyleElement {
  let el = document.getElementById(id) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = id
    document.head.appendChild(el)
  }
  return el
}

export function resolvedTheme(): 'light' | 'dark' {
  return current.theme === 'system' ? (media.matches ? 'dark' : 'light') : current.theme
}

/** The editor theme for the palette on screen (a fresh EditorState starts from this). */
export function currentEditorTheme(): Extension {
  return editorExtension(palette, current ? resolvedTheme() : 'light')
}

// ---- Themes -----------------------------------------------------------------

export function allThemes(): ThemeDef[] {
  return [...BUILTIN_THEMES, ...installed]
}

export function themeById(id: string): ThemeDef | undefined {
  return allThemes().find((t) => t.id === id)
}

export async function refreshInstalledThemes(): Promise<void> {
  installed = await window.api.installedThemes()
}

/** The palette currently on screen (theme × mode, with fallback). */
export function currentPalette(): ThemePalette {
  return palette
}

function applyBorder(): void {
  const root = document.documentElement.style
  if (current.borderColor) root.setProperty('--window-border', current.borderColor)
  else root.removeProperty('--window-border')
}

function applyTheme(): void {
  const mode = resolvedTheme()
  const def = themeById(current.themeId)
  palette = def?.[mode] ?? FALLBACK[mode]
  document.documentElement.dataset.theme = mode
  applyChrome(palette)
  styleEl('md-theme').textContent = mode === 'dark' ? darkCss : lightCss
  styleEl('md-theme-vars').textContent = previewCss(palette)
  view.dispatch({ effects: themeCompartment.reconfigure(editorExtension(palette, mode)) })
  // The graph paints on a WebGL canvas, not with CSS: it re-reads its colours on this.
  document.dispatchEvent(new CustomEvent('theme-applied'))
}

/** Quote a family name for CSS and fall back to the built-in stack. */
function stack(family: string | null, fallback: string): string {
  return family ? `"${family}", ${fallback}` : fallback
}

async function applyFonts(): Promise<void> {
  const families = [current.uiFont, current.editorFont].filter((f): f is string => !!f)
  const css = await Promise.all([...new Set(families)].map((f) => window.api.fontCss(f, false)))
  styleEl('font-faces').textContent = css.join('\n')
  const root = document.documentElement.style
  // A theme's own font choices apply only where the user hasn't picked a font.
  const uiBase = palette.fontText ?? UI_FONT_DEFAULT
  const monoBase = palette.fontMono ?? EDITOR_FONT_DEFAULT
  root.setProperty('--ui-font', stack(current.uiFont, uiBase))
  root.setProperty('--editor-font', stack(current.editorFont, monoBase))
  // Preview prose follows the editor font when one is chosen, else the sans UI stack.
  root.setProperty('--preview-font', stack(current.editorFont, uiBase))
  root.setProperty('--ui-size', `${current.uiFontSize}px`)
  root.setProperty('--editor-size', `${current.editorFontSize}px`)
}

export function settings(): Settings {
  return current
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  current = await window.api.setSettings(patch)
  if ('theme' in patch || 'themeId' in patch) {
    applyTheme()
    await applyFonts()
  }
  if ('borderColor' in patch) applyBorder()
  if ('uiFont' in patch || 'editorFont' in patch || 'uiFontSize' in patch || 'editorFontSize' in patch) await applyFonts()
  if ('iconSet' in patch) setIconSet(current.iconSet)
}

export async function initAppearance(editor: EditorView): Promise<void> {
  view = editor
  current = await window.api.getSettings()
  await refreshInstalledThemes()
  applyTheme()
  applyBorder()
  setIconSet(current.iconSet)
  await applyFonts()
  media.addEventListener('change', () => current.theme === 'system' && applyTheme())
}

/** Font CSS for exports: the editor/preview font, embedded so the file is self-contained. */
export async function exportFontCss(embed: boolean): Promise<{ family: string; css: string }> {
  const family = current.editorFont
  if (!family) return { family: '', css: '' }
  return { family, css: await window.api.fontCss(family, embed) }
}
