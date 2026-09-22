import type { ObsidianTheme, ThemeDef } from '../../preload/index'
import { allThemes, refreshInstalledThemes, settings, updateSettings } from '../appearance'
import { ICON_SETS, icon, type IconSetId } from '../icons/index'
import { importObsidianTheme } from './obsidianImport'
import { alertBox } from '../messageBox'

/** Theme picker, Obsidian theme browser and icon-set switch inside the Settings dialog. */

const dialog = document.getElementById('settings') as HTMLDialogElement
const $ = <T extends HTMLElement>(sel: string): T => dialog.querySelector(sel) as T
const grid = $<HTMLDivElement>('#theme-grid')
const input = $<HTMLInputElement>('#theme-search')
const list = $<HTMLUListElement>('#theme-results')
const iconSets = $<HTMLDivElement>('#icon-sets')

let catalogue: ObsidianTheme[] | null = null
const busy = new Set<string>()

// ---- Theme cards --------------------------------------------------------------

export function renderThemeGrid(): void {
  const cur = settings().themeId
  grid.replaceChildren(
    ...allThemes().map((t) => {
      const card = document.createElement('button')
      card.type = 'button'
      card.className = 'theme-card' + (t.id === cur ? ' active' : '')
      card.dataset.id = t.id
      card.title = t.author ? `${t.name} — ${t.author}` : t.name
      const p = t.dark ?? t.light!
      const q = t.light ?? t.dark!
      card.innerHTML =
        `<span class="theme-swatch" style="background:${p.bg};border-color:${p.border}">` +
        `<i style="background:${p.barBg}"></i><i style="background:${p.accent}"></i><i style="background:${q.bg};border-color:${q.border}"></i>` +
        `</span><span class="name"></span><span class="modes">${[t.light && 'light', t.dark && 'dark'].filter(Boolean).join(' · ')}</span>` +
        (t.id.startsWith('obsidian:') ? `<span class="remove" title="Remove">${icon('x')}</span>` : '')
      card.querySelector('.name')!.textContent = t.name
      return card
    })
  )
}

grid.addEventListener('click', async (e) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>('.theme-card')
  if (!card?.dataset.id) return
  const id = card.dataset.id
  if ((e.target as HTMLElement).closest('.remove')) {
    await window.api.uninstallTheme(id)
    await refreshInstalledThemes()
    if (settings().themeId === id) await updateSettings({ themeId: allThemes()[0].id })
    catalogue = catalogue?.map((t) => (`obsidian:${t.repo}` === id ? { ...t, installed: false } : t)) ?? null
    renderThemeGrid()
    return
  }
  await updateSettings({ themeId: id })
  renderThemeGrid()
})

// ---- Obsidian browser ---------------------------------------------------------

async function loadCatalogue(): Promise<ObsidianTheme[]> {
  if (!catalogue) catalogue = await window.api.listObsidianThemes()
  return catalogue
}

function renderResults(): void {
  list.innerHTML = ''
  if (!catalogue || document.activeElement !== input) return
  const q = input.value.trim().toLowerCase()
  const hits = q ? catalogue.filter((t) => t.name.toLowerCase().includes(q) || t.author.toLowerCase().includes(q)) : catalogue
  for (const t of hits.slice(0, 40)) {
    const li = document.createElement('li')
    li.dataset.repo = t.repo
    li.innerHTML =
      `<span class="name"></span><span class="meta"></span><span class="meta">${t.modes.join(' · ')}</span>` +
      (busy.has(t.repo) ? '<span class="badge">importing…</span>' :
        t.installed ? '<span class="badge ok">installed</span>' : '<button type="button">Install</button>')
    li.querySelector('.name')!.textContent = t.name
    li.querySelectorAll('.meta')[0].textContent = t.author
    list.appendChild(li)
  }
  if (hits.length === 0) list.innerHTML = '<li class="empty">No match</li>'
}

/** Fetch theme.css and extract its palette (no side effects). */
export async function fetchObsidianPalette(repo: string): Promise<ThemeDef> {
  const { css, name, author, modes } = await window.api.fetchObsidianTheme(repo)
  return importObsidianTheme(repo, css, name, author, modes)
}

/** Import, store and switch to an Obsidian theme. */
export async function installObsidianTheme(repo: string): Promise<ThemeDef> {
  const def = await fetchObsidianPalette(repo)
  await window.api.saveTheme(def)
  await refreshInstalledThemes()
  return def
}

async function install(repo: string): Promise<void> {
  busy.add(repo)
  renderResults()
  try {
    const def = await installObsidianTheme(repo)
    catalogue = catalogue?.map((t) => (t.repo === repo ? { ...t, installed: true } : t)) ?? null
    await updateSettings({ themeId: def.id })
    renderThemeGrid()
  } catch (err) {
    await alertBox(`Could not import ${repo}`, (err as Error).message)
  } finally {
    busy.delete(repo)
    renderResults()
  }
}

input.addEventListener('focus', async () => {
  list.innerHTML = '<li class="empty">Loading Obsidian themes…</li>'
  try {
    await loadCatalogue()
    renderResults()
  } catch (err) {
    if (document.activeElement === input) list.innerHTML = `<li class="empty">Could not load list: ${(err as Error).message}</li>`
  }
})
input.addEventListener('blur', () => {
  input.value = ''
  list.innerHTML = ''
})
list.addEventListener('mousedown', (e) => e.preventDefault())
input.addEventListener('input', renderResults)
input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !catalogue) return
  e.preventDefault()
  const q = input.value.trim().toLowerCase()
  const hit = catalogue.find((t) => t.name.toLowerCase() === q) ?? catalogue.find((t) => t.name.toLowerCase().includes(q))
  if (!hit) return
  if (hit.installed) void updateSettings({ themeId: `obsidian:${hit.repo}` }).then(renderThemeGrid)
  else void install(hit.repo)
})
list.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-repo]')
  if (!li) return
  if ((e.target as HTMLElement).matches('button')) void install(li.dataset.repo!)
})

// ---- Icon sets ----------------------------------------------------------------

export function renderIconSets(): void {
  const cur = settings().iconSet
  iconSets.replaceChildren(
    ...(Object.keys(ICON_SETS) as IconSetId[]).map((id) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.dataset.set = id
      b.className = id === cur ? 'active' : ''
      b.innerHTML =
        `<span class="sample">${(['folder', 'file-text', 'save', 'settings', 'list-ordered'] as const).map((n) => icon(n, id)).join('')}</span>` +
        `<span class="name">${ICON_SETS[id].name}</span>`
      return b
    })
  )
}

iconSets.addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-set]')
  if (!b) return
  await updateSettings({ iconSet: b.dataset.set as IconSetId })
  renderIconSets()
})
