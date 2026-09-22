import type { FontFamily, LlmProvider, NerdFont, Theme } from '../preload/index'
import { settings, updateSettings } from './appearance'
import { renderIconSets, renderThemeGrid } from './themes/settings'
import { alertBox, errorMessage } from './messageBox'
import { renderKeybindings } from './keybindingsPage'

type Target = 'uiFont' | 'editorFont'

const dialog = document.getElementById('settings') as HTMLDialogElement
let catalogue: NerdFont[] | null = null
let families: FontFamily[] = []
const progress = new Map<string, number>()

const $ = <T extends HTMLElement>(sel: string): T => dialog.querySelector(sel) as T

export function openSettings(): void {
  syncTheme()
  syncBorder()
  authorInput.value = settings().author
  assetsInput.value = settings().assetsFolder
  livePreviewInput.checked = settings().livePreview
  syncSizes()
  syncExport()
  syncAi()
  void syncTemplatesDir()
  renderThemeGrid()
  renderIconSets()
  renderKeybindings()
  void refreshFamilies()
  dialog.showModal()
  // Don't land focus (and its ring) on the close button.
  $('.st-pages').focus()
}

// ---- Theme -----------------------------------------------------------------

function syncTheme(): void {
  dialog.querySelectorAll<HTMLInputElement>('input[name=theme]').forEach((r) => {
    r.checked = r.value === settings().theme
  })
}
dialog.querySelectorAll<HTMLInputElement>('input[name=theme]').forEach((r) => {
  r.addEventListener('change', () => void updateSettings({ theme: r.value as Theme }))
})

// ---- Navigation -----------------------------------------------------------------

dialog.querySelectorAll<HTMLButtonElement>('.st-nav button').forEach((b) => {
  b.addEventListener('click', () => {
    dialog.querySelectorAll('.st-nav button').forEach((x) => x.classList.toggle('active', x === b))
    dialog.querySelectorAll<HTMLElement>('.st-pages section').forEach((s) => s.classList.toggle('active', s.dataset.page === b.dataset.page))
    $('.st-pages').scrollTop = 0
  })
})

// ---- Editor ---------------------------------------------------------------------

const livePreviewInput = $<HTMLInputElement>('#live-preview')
livePreviewInput.addEventListener('change', () => {
  void updateSettings({ livePreview: livePreviewInput.checked }).then(() => document.dispatchEvent(new CustomEvent('settings-changed')))
})

// ---- Export -------------------------------------------------------------------

const pdfHeaderInput = $<HTMLInputElement>('#pdf-header')
function syncExport(): void {
  const s = settings()
  dialog.querySelectorAll<HTMLInputElement>('input[name=pdfPaper]').forEach((r) => (r.checked = r.value === s.pdfPaper))
  dialog.querySelectorAll<HTMLInputElement>('input[name=pdfFont]').forEach((r) => (r.checked = r.value === s.pdfFont))
  pdfHeaderInput.checked = s.pdfHeader
}
dialog.querySelectorAll<HTMLInputElement>('input[name=pdfPaper]').forEach((r) => {
  r.addEventListener('change', () => void updateSettings({ pdfPaper: r.value as 'A4' | 'Letter' }))
})
dialog.querySelectorAll<HTMLInputElement>('input[name=pdfFont]').forEach((r) => {
  r.addEventListener('change', () => void updateSettings({ pdfFont: r.value as 'editor' | 'sans' | 'serif' }))
})
pdfHeaderInput.addEventListener('change', () => void updateSettings({ pdfHeader: pdfHeaderInput.checked }))

// ---- AI -----------------------------------------------------------------------

const llmTestResult = $('#llm-test-result')
const aiFields: [string, 'llmLocalUrl' | 'llmLocalModel' | 'openRouterModel'][] = [
  ['#llm-local-url', 'llmLocalUrl'], ['#llm-local-model', 'llmLocalModel'], ['#openrouter-model', 'openRouterModel']
]
// The stored key is never read back (main/settings.ts keeps it), so the field
// starts empty and says whether one is there; typing a new one replaces it.
const keyInput = $<HTMLInputElement>('#openrouter-key')
const keyClear = $<HTMLButtonElement>('#openrouter-key-clear')
function syncAi(): void {
  const s = settings()
  dialog.querySelectorAll<HTMLInputElement>('input[name=llmProvider]').forEach((r) => (r.checked = r.value === s.llmProvider))
  dialog.querySelectorAll<HTMLElement>('.ai-provider').forEach((el) => (el.hidden = el.dataset.provider !== s.llmProvider))
  $('.ai-test').hidden = s.llmProvider === 'none'
  for (const [sel, key] of aiFields) $<HTMLInputElement>(sel).value = s[key]
  keyInput.value = ''
  keyInput.placeholder = s.openRouterKeySet ? 'A key is saved — type a new one to replace it' : 'sk-or-…'
  keyClear.hidden = !s.openRouterKeySet
  llmTestResult.textContent = 'Not tested.'
}
dialog.querySelectorAll<HTMLInputElement>('input[name=llmProvider]').forEach((r) => {
  r.addEventListener('change', () => void updateSettings({ llmProvider: r.value as LlmProvider }).then(syncAi))
})
for (const [sel, key] of aiFields) {
  const input = $<HTMLInputElement>(sel)
  input.addEventListener('change', () => void updateSettings({ [key]: input.value.trim() }))
}
keyInput.addEventListener('change', () => {
  // An empty field means "left alone"; Remove is how a key is taken away.
  const key = keyInput.value.trim()
  if (key) void updateSettings({ openRouterKey: key }).then(syncAi)
})
keyClear.addEventListener('click', () => void updateSettings({ openRouterKey: '' }).then(syncAi))
$('#llm-test').addEventListener('click', async () => {
  llmTestResult.textContent = 'Connecting…'
  try {
    llmTestResult.textContent = await window.api.llmTest()
  } catch (err) {
    llmTestResult.textContent = errorMessage(err)
  }
})

// ---- Images -------------------------------------------------------------------

const assetsInput = $<HTMLInputElement>('#assets-folder')
assetsInput.addEventListener('change', () => {
  // A folder name only: no separators, no dots-only names.
  const name = assetsInput.value.trim().replace(/[\\/:*?"<>|]+/g, '').replace(/^\.+$/, '') || 'assets'
  assetsInput.value = name
  void updateSettings({ assetsFolder: name })
})

// ---- Templates ----------------------------------------------------------------

const authorInput = $<HTMLInputElement>('#author')
authorInput.addEventListener('change', () => void updateSettings({ author: authorInput.value.trim() }))
$('#settings-templates-folder').addEventListener('click', () => void window.api.openTemplatesFolder())

const templatesDirInput = $<HTMLInputElement>('#templates-dir')
async function syncTemplatesDir(): Promise<void> {
  const dir = settings().templatesDir
  templatesDirInput.value = dir ?? `${await window.api.defaultTemplatesDir()}  (default)`
  templatesDirInput.title = templatesDirInput.value
}
$('#templates-browse').addEventListener('click', async () => {
  const dir = await window.api.pickDir(settings().templatesDir)
  if (dir) await updateSettings({ templatesDir: dir })
  await syncTemplatesDir()
})
$('#templates-reset').addEventListener('click', async () => {
  await updateSettings({ templatesDir: null })
  await syncTemplatesDir()
})

// ---- Window border ----------------------------------------------------------

const borderInput = $<HTMLInputElement>('#border-color')

function syncBorder(): void {
  const cur = settings().borderColor
  borderInput.value = cur ?? cssColorToHex(getComputedStyle(document.documentElement).getPropertyValue('--border'))
}

/** <input type=color> only accepts #rrggbb; resolve theme colours through a canvas. */
function cssColorToHex(color: string): string {
  const ctx = document.createElement('canvas').getContext('2d')!
  ctx.fillStyle = color.trim() || '#000'
  return ctx.fillStyle as string
}

borderInput.addEventListener('input', () => void updateSettings({ borderColor: borderInput.value }))
$('#border-reset').addEventListener('click', () => {
  void updateSettings({ borderColor: null }).then(syncBorder)
})

// ---- Font sizes ----------------------------------------------------------------

type SizeKey = 'uiFontSize' | 'editorFontSize'
const sizeInputs = [...dialog.querySelectorAll<HTMLInputElement>('input[data-size]')]

function syncSizes(): void {
  for (const i of sizeInputs) i.value = String(settings()[i.dataset.size as SizeKey])
}
for (const i of sizeInputs) {
  const apply = (): void => {
    const min = Number(i.min), max = Number(i.max)
    const n = Number(i.value)
    if (!Number.isFinite(n) || i.value.trim() === '') return
    const size = Math.min(max, Math.max(min, n))
    i.value = String(size)
    void updateSettings({ [i.dataset.size as SizeKey]: size })
  }
  i.addEventListener('input', apply) // live: the spinner and typing both preview immediately
  i.addEventListener('change', apply)
}

// ---- Font selectors ----------------------------------------------------------

async function refreshFamilies(): Promise<void> {
  families = await window.api.installedFamilies()
  for (const target of ['uiFont', 'editorFont'] as Target[]) {
    const sel = $<HTMLSelectElement>(`select[data-target=${target}]`)
    const cur = settings()[target]
    sel.innerHTML = '<option value="">Default</option>'
    for (const f of families) {
      const o = document.createElement('option')
      o.value = f.family
      o.textContent = f.family
      o.selected = f.family === cur
      sel.appendChild(o)
    }
    if (cur && !families.some((f) => f.family === cur)) sel.value = ''
  }
}

dialog.querySelectorAll<HTMLSelectElement>('select[data-target]').forEach((sel) => {
  sel.addEventListener('change', () => {
    void updateSettings({ [sel.dataset.target as Target]: sel.value || null })
  })
})

/** Prefer the proportional face for the UI and the mono face for the editor. */
function pickFamily(pkgFamilies: FontFamily[], target: Target): string {
  const want = target === 'uiFont' ? / Propo$/ : / Mono$/
  return (pkgFamilies.find((f) => want.test(f.family)) ?? pkgFamilies[0]).family
}

// ---- Nerd Fonts search + install -------------------------------------------

async function loadCatalogue(): Promise<NerdFont[]> {
  if (!catalogue) catalogue = await window.api.listNerdFonts()
  return catalogue
}

function renderResults(target: Target, query: string): void {
  const list = $<HTMLUListElement>(`ul[data-target=${target}]`)
  list.innerHTML = ''
  // The list is a focus-scoped dropdown: only show it while its input is focused.
  if (!catalogue || document.activeElement !== $(`input[data-target=${target}]`)) return
  const q = query.trim().toLowerCase()
  const hits = q ? catalogue.filter((f) => f.name.toLowerCase().includes(q)) : catalogue
  for (const f of hits.slice(0, 30)) {
    const li = document.createElement('li')
    const pct = progress.get(f.name)
    // f.name comes from the GitHub release listing: set it as text, never markup.
    li.innerHTML = `<span class="name"></span><span class="meta">${f.sizeMb} MB</span>` +
      (pct !== undefined ? `<span class="badge">${pct}%</span>` :
        f.installed ? `<span class="badge ok">installed</span>` : `<button type="button">Install</button>`)
    li.querySelector('.name')!.textContent = f.name
    li.dataset.name = f.name
    list.appendChild(li)
  }
  if (hits.length === 0) list.innerHTML = '<li class="empty">No match</li>'
}

async function install(name: string, target: Target): Promise<void> {
  const input = $<HTMLInputElement>(`input[data-target=${target}]`)
  progress.set(name, 0)
  renderResults(target, input.value)
  try {
    const pkgFamilies = await window.api.installNerdFont(name)
    catalogue = catalogue?.map((f) => (f.name === name ? { ...f, installed: true } : f)) ?? null
    await updateSettings({ [target]: pickFamily(pkgFamilies, target) })
    await refreshFamilies()
  } catch (err) {
    await alertBox(`Could not install ${name}`, (err as Error).message)
  } finally {
    progress.delete(name)
    renderResults(target, input.value)
  }
}

window.api.onFontProgress(({ name, pct }) => {
  if (!progress.has(name)) return
  progress.set(name, pct)
  for (const target of ['uiFont', 'editorFont'] as Target[]) {
    renderResults(target, $<HTMLInputElement>(`input[data-target=${target}]`).value)
  }
})

for (const target of ['uiFont', 'editorFont'] as Target[]) {
  const input = $<HTMLInputElement>(`input[data-target=${target}]`)
  const list = $<HTMLUListElement>(`ul[data-target=${target}]`)

  input.addEventListener('focus', async () => {
    list.innerHTML = '<li class="empty">Loading Nerd Fonts…</li>'
    try {
      await loadCatalogue()
      renderResults(target, input.value)
    } catch (err) {
      if (document.activeElement === input) list.innerHTML = `<li class="empty">Could not load list: ${(err as Error).message}</li>`
    }
  })
  input.addEventListener('blur', () => {
    input.value = ''
    list.innerHTML = ''
  })
  // Keep the input focused while clicking inside the list so blur doesn't clear it mid-click.
  list.addEventListener('mousedown', (e) => e.preventDefault())
  input.addEventListener('input', () => renderResults(target, input.value))
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !catalogue) return
    e.preventDefault()
    const q = input.value.trim().toLowerCase()
    const hit = catalogue.find((f) => f.name.toLowerCase() === q) ?? catalogue.find((f) => f.name.toLowerCase().includes(q))
    if (!hit) return
    if (hit.installed) {
      const pkgFamilies = families.filter((f) => f.pkg === hit.name)
      if (pkgFamilies.length) void updateSettings({ [target]: pickFamily(pkgFamilies, target) }).then(refreshFamilies)
    } else {
      void install(hit.name, target)
    }
  })
  list.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-name]')
    if (!li || !(e.target as HTMLElement).matches('button')) return
    void install(li.dataset.name!, target)
  })
}

$('#settings-close').addEventListener('click', () => dialog.close())
