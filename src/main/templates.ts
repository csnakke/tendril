import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { loadSettings } from './settings'

export type TemplateKind = 'notes' | 'reports'

export interface Template {
  /** 'builtin:<kind>/<slug>' or 'user:<kind>/<file>'. */
  id: string
  kind: TemplateKind
  name: string
  content: string
}

const README = `Tendril templates
=================

Put Markdown files here to make them available under File > New from Template.
A template counts as a report when it uses <!-- cover -->, <!-- pagebreak -->
or a <style> block; everything else is a note. Files may also be sorted into
notes/ and reports/ subfolders to force the kind.

Placeholders expanded when a document is created:

  {{title}}            title entered in the picker
  {{author}}           author from Settings
  {{date}}             today, YYYY-MM-DD
  {{date:D MMMM YYYY}} today in a custom format (YYYY YY MMMM MMM MM M DD D dddd ddd HH mm ss)
  {{time}}             now, HH:mm
  {{filename}}         file name without extension
  {{cursor}}           where the caret lands
`

export const defaultTemplatesDir = (): string => join(app.getPath('userData'), 'templates')

/** The user's chosen folder (Settings > Templates), else the app's own. */
export async function templatesDir(): Promise<string> {
  return (await loadSettings()).templatesDir || defaultTemplatesDir()
}

/** Make sure the folder exists; the default one also gets a README on first use. */
export async function ensureTemplatesDir(): Promise<string> {
  const dir = await templatesDir()
  await fs.mkdir(dir, { recursive: true })
  if (dir === defaultTemplatesDir()) await fs.writeFile(join(dir, 'README.txt'), README, { flag: 'wx' }).catch(() => {})
  return dir
}

const TEMPLATE_FILE = /\.(md|markdown|txt)$/i
const REPORT_MARKERS = /^(<!--\s*(pagebreak|cover)\s*-->|<style\b)/im

/**
 * Templates are the Markdown files in the folder (flat, like Obsidian) plus
 * any in notes/ or reports/ subfolders. Kind comes from the subfolder, else
 * from the content: report markers make it a report.
 */
export async function listUserTemplates(): Promise<Template[]> {
  const root = await templatesDir()
  const out: Template[] = []
  const read = async (dir: string, forced: TemplateKind | null): Promise<void> => {
    const files = await fs.readdir(dir).catch(() => [] as string[])
    // README files document the folder; they are not templates.
    for (const f of files.filter((f) => TEMPLATE_FILE.test(f) && !/^readme\./i.test(f)).sort()) {
      try {
        const content = await fs.readFile(join(dir, f), 'utf8')
        const kind = forced ?? (REPORT_MARKERS.test(content) ? 'reports' : 'notes')
        out.push({ id: `user:${forced ?? ''}/${f}`, kind, name: basename(f).replace(TEMPLATE_FILE, ''), content })
      } catch {
        /* unreadable file: skip */
      }
    }
  }
  await read(root, null)
  await read(join(root, 'notes'), 'notes')
  await read(join(root, 'reports'), 'reports')
  return out
}
