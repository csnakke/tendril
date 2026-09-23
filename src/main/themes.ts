import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const CATALOGUE_URL = 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-css-themes.json'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** One mode's colours, fully resolved CSS colour strings. */
export interface ThemePalette {
  bg: string
  barBg: string
  border: string
  fg: string
  muted: string
  hover: string
  active: string
  inset: string
  selection: string
  accent: string
  codeBg?: string
  hrColor?: string
  headingColor?: string
  linkColor?: string
  blockquoteBorder?: string
  highlightBg?: string
  fontText?: string
  fontMono?: string
  /** Tag graph: note nodes, tag nodes, links, focus colour, canvas, and the explorer's graph-folder marker. */
  graphNote?: string
  graphTag?: string
  graphLink?: string
  graphHighlight?: string
  graphBg?: string
  graphFolder?: string
  /** Tag graph cluster colours: notes and tags are coloured by their top-level tag, in this order. */
  graphColors?: string[]
  /** Editor syntax colours; derived from the palette when absent. */
  syntax?: Partial<Record<'heading' | 'emphasis' | 'link' | 'code' | 'quote' | 'meta' | 'keyword' | 'string' | 'comment', string>>
}

export interface ThemeDef {
  /** 'builtin:<slug>' or 'obsidian:<owner>/<repo>'. */
  id: string
  name: string
  author?: string
  repo?: string
  light?: ThemePalette
  dark?: ThemePalette
}

export interface ObsidianTheme {
  name: string
  author: string
  repo: string
  modes: ('light' | 'dark')[]
  installed: boolean
}

const themesDir = (): string => join(app.getPath('userData'), 'themes')
const cacheFile = (): string => join(app.getPath('userData'), 'obsidian-themes.json')
const fileFor = (id: string): string => join(themesDir(), id.replace(/^obsidian:/, '').replace(/[\\/]/g, '__') + '.json')

// ---- Catalogue --------------------------------------------------------------

async function fetchCatalogue(): Promise<Omit<ObsidianTheme, 'installed'>[]> {
  try {
    const c = JSON.parse(await fs.readFile(cacheFile(), 'utf8')) as { at: number; themes: Omit<ObsidianTheme, 'installed'>[] }
    if (Date.now() - c.at < CACHE_TTL_MS) return c.themes
  } catch {
    /* no cache */
  }
  const res = await fetch(CATALOGUE_URL, { headers: { 'User-Agent': 'Tendril' } })
  if (!res.ok) throw new Error(`GitHub ${res.status}`)
  const raw = (await res.json()) as { name: string; author: string; repo: string; modes?: string[] }[]
  const themes = raw
    .map((t) => ({ name: t.name, author: t.author, repo: t.repo, modes: (t.modes ?? ['dark']) as ('light' | 'dark')[] }))
    .sort((a, b) => a.name.localeCompare(b.name))
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(cacheFile(), JSON.stringify({ at: Date.now(), themes }), 'utf8')
  return themes
}

export async function listObsidianThemes(): Promise<ObsidianTheme[]> {
  const [themes, installed] = await Promise.all([fetchCatalogue(), installedThemes()])
  const ids = new Set(installed.map((t) => t.id))
  return themes.map((t) => ({ ...t, installed: ids.has(`obsidian:${t.repo}`) }))
}

/** Raw theme.css + manifest for a catalogue entry; the renderer extracts the palette. */
export async function fetchObsidianTheme(
  repo: string
): Promise<{ css: string; name: string; author: string; modes: ('light' | 'dark')[] }> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Bad repo: ${repo}`)
  const base = `https://raw.githubusercontent.com/${repo}/HEAD/`
  const [css, manifest] = await Promise.all([
    fetch(base + 'theme.css').then((r) => (r.ok ? r.text() : Promise.reject(new Error(`theme.css ${r.status}`)))),
    fetch(base + 'manifest.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
  ])
  const entry = (await fetchCatalogue()).find((t) => t.repo === repo)
  const m = manifest as { name?: string; author?: string }
  return {
    css,
    name: m.name ?? entry?.name ?? repo,
    author: m.author ?? entry?.author ?? repo.split('/')[0],
    modes: entry?.modes ?? ['dark']
  }
}

// ---- Installed --------------------------------------------------------------

export async function installedThemes(): Promise<ThemeDef[]> {
  try {
    const files = (await fs.readdir(themesDir())).filter((f) => f.endsWith('.json'))
    const defs = await Promise.all(files.map(async (f) => JSON.parse(await fs.readFile(join(themesDir(), f), 'utf8')) as ThemeDef))
    return defs.filter((d) => d.id && (d.light || d.dark)).sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

export async function saveTheme(def: ThemeDef): Promise<void> {
  if (!def.id.startsWith('obsidian:')) throw new Error('Only imported themes are stored')
  await fs.mkdir(themesDir(), { recursive: true })
  await fs.writeFile(fileFor(def.id), JSON.stringify(def, null, 2), 'utf8')
}

export async function uninstallTheme(id: string): Promise<void> {
  await fs.rm(fileFor(id), { force: true })
}
