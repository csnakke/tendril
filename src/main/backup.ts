import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { app } from 'electron'
import { disableGraph } from './graph'
import { loadSettings, saveSettings, type Settings } from './settings'
import { defaultTemplatesDir } from './templates'

/**
 * A backup of Tendril's configuration in one JSON file, to bring it to a fresh
 * install: settings (SSH hosts and their forwards included), the hosts you
 * trusted, imported themes and the built-in templates folder.
 *
 * Never in it: saved keys, passwords and passphrases (they stay in `pass`;
 * after an import the hosts are marked as not having them), the OpenRouter
 * key, downloaded fonts, and what only made sense on the old machine (open
 * folder, window state, the graph folders found there).
 */

const FORMAT = 'tendril-backup'
const VERSION = 1

interface FileItem {
  name: string
  content: string
}

interface Backup {
  format: typeof FORMAT
  version: number
  created: string
  app: string
  settings: Partial<Settings>
  knownHosts: string
  themes: FileItem[]
  templates: FileItem[]
}

const userData = (): string => app.getPath('userData')
const knownHostsFile = (): string => join(userData(), 'ssh', 'known_hosts')
const themesDir = (): string => join(userData(), 'themes')

/** Settings that belong to this machine or are secret: not carried over. */
const LOCAL_ONLY: (keyof Settings)[] = ['openRouterKey', 'openRouterKeyInPass', 'sidebarRoot', 'graphFolders', 'sudoSaved']

async function readDir(dir: string, match: RegExp): Promise<FileItem[]> {
  try {
    const names = (await fs.readdir(dir)).filter((n) => match.test(n))
    return Promise.all(names.map(async (name) => ({ name, content: await fs.readFile(join(dir, name), 'utf8') })))
  } catch {
    return []
  }
}

export async function exportBackup(file: string): Promise<string> {
  const s = await loadSettings()
  const settings: Partial<Settings> = { ...s }
  for (const k of LOCAL_ONLY) delete settings[k]
  // Hosts travel without their secrets: those are in `pass`, not in the backup.
  settings.sshHosts = s.sshHosts.map((h) => ({ ...h, hasKey: false, hasPassword: false, hasPassphrase: false, hasSudo: false }))
  const backup: Backup = {
    format: FORMAT,
    version: VERSION,
    created: new Date().toISOString(),
    app: app.getVersion(),
    settings,
    knownHosts: await fs.readFile(knownHostsFile(), 'utf8').catch(() => ''),
    themes: await readDir(themesDir(), /\.json$/),
    templates: await readDir(defaultTemplatesDir(), /\.(md|markdown|txt)$/i)
  }
  await fs.writeFile(file, JSON.stringify(backup, null, 2) + '\n', { mode: 0o600 })
  return `Exported ${s.sshHosts.length} SSH host${s.sshHosts.length === 1 ? '' : 's'}, ${backup.themes.length} theme${backup.themes.length === 1 ? '' : 's'} and ${backup.templates.length} template${backup.templates.length === 1 ? '' : 's'} to ${file}.`
}

/** A plain file name from a backup: nothing that could point outside its folder. */
const safeName = (n: unknown): string | null => {
  const name = basename(String(n ?? ''))
  return name && name === n && !name.startsWith('.') ? name : null
}

export async function importBackup(file: string): Promise<string> {
  let b: Backup
  try {
    b = JSON.parse(await fs.readFile(file, 'utf8')) as Backup
  } catch {
    throw new Error('That file is not a Tendril backup.')
  }
  if (b?.format !== FORMAT || typeof b.settings !== 'object' || !b.settings) throw new Error('That file is not a Tendril backup.')
  if (b.version > VERSION) throw new Error('This backup comes from a newer Tendril; update Tendril first.')

  const current = await loadSettings()
  const incoming: Partial<Settings> = {}
  // Only settings this version knows, with the type it expects.
  for (const [k, v] of Object.entries(b.settings) as [keyof Settings, unknown][]) {
    if (!(k in current) || LOCAL_ONLY.includes(k)) continue
    const want = current[k]
    if (Array.isArray(want) ? Array.isArray(v) : want === null || v === null || typeof v === typeof want) (incoming as Record<string, unknown>)[k] = v
  }
  // Keys and passwords are not in backups; a host that had them has to be given them again.
  if (Array.isArray(incoming.sshHosts)) incoming.sshHosts = incoming.sshHosts.map((h) => ({ ...h, hasKey: false, hasPassword: false, hasPassphrase: false, hasSudo: false }))
  await saveSettings(incoming)

  // Trusted hosts: added to what this machine already trusts.
  if (typeof b.knownHosts === 'string' && b.knownHosts.trim()) {
    await fs.mkdir(join(userData(), 'ssh'), { recursive: true, mode: 0o700 })
    const have = new Set((await fs.readFile(knownHostsFile(), 'utf8').catch(() => '')).split('\n').filter(Boolean))
    const add = b.knownHosts.split('\n').filter((l) => l.trim() && !have.has(l))
    if (add.length) await fs.appendFile(knownHostsFile(), add.join('\n') + '\n', { mode: 0o600 })
  }
  let themes = 0
  let templates = 0
  for (const [dir, items, match, count] of [
    [themesDir(), b.themes, /\.json$/, (): number => themes++],
    [defaultTemplatesDir(), b.templates, /\.(md|markdown|txt)$/i, (): number => templates++]
  ] as const) {
    if (!Array.isArray(items)) continue
    await fs.mkdir(dir, { recursive: true })
    for (const it of items) {
      const name = safeName(it?.name)
      if (!name || !match.test(name) || typeof it.content !== 'string') continue
      await fs.writeFile(join(dir, name), it.content, 'utf8')
      count()
    }
  }
  const hosts = incoming.sshHosts?.length ?? 0
  return `Imported settings, ${hosts} SSH host${hosts === 1 ? '' : 's'}, ${themes} theme${themes === 1 ? '' : 's'} and ${templates} template${templates === 1 ? '' : 's'}.${hosts ? ' Add their keys or passwords again in Settings › SSH.' : ''}`
}

/** Uninstalling: remove the graph markers Tendril put in your folders (the rest is removed by the installer). */
export async function removeGraphMarkers(): Promise<string[]> {
  const removed: string[] = []
  for (const dir of (await loadSettings()).graphFolders) {
    await disableGraph(dir).then(() => removed.push(dir), () => {})
  }
  await saveSettings({ graphFolders: [] })
  return removed
}
