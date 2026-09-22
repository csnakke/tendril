import { app } from 'electron'
import { createWriteStream, promises as fs } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { pipeline } from 'node:stream/promises'
import yauzl, { type Entry, type ZipFile } from 'yauzl'

const RELEASE_API = 'https://api.github.com/repos/ryanoasis/nerd-fonts/releases/latest'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export interface NerdFont {
  /** Zip basename without extension, e.g. "FiraCode". */
  name: string
  url: string
  sizeMb: number
  installed: boolean
}

export interface FontFace {
  file: string
  weight: number
  style: 'normal' | 'italic'
}

export interface FontFamily {
  /** CSS family name, e.g. "FiraCode Nerd Font Propo". */
  family: string
  /** Nerd Font package it came from. */
  pkg: string
  faces: FontFace[]
}

const fontsDir = (): string => join(app.getPath('userData'), 'fonts')
const cacheFile = (): string => join(app.getPath('userData'), 'nerdfonts.json')

// ---- Catalogue --------------------------------------------------------------

async function fetchCatalogue(): Promise<Omit<NerdFont, 'installed'>[]> {
  try {
    const raw = await fs.readFile(cacheFile(), 'utf8')
    const c = JSON.parse(raw) as { at: number; fonts: Omit<NerdFont, 'installed'>[] }
    if (Date.now() - c.at < CACHE_TTL_MS) return c.fonts
  } catch {
    /* no cache */
  }
  const res = await fetch(RELEASE_API, { headers: { 'User-Agent': 'Tendril' } })
  if (!res.ok) throw new Error(`GitHub API ${res.status}`)
  const rel = (await res.json()) as { assets: { name: string; browser_download_url: string; size: number }[] }
  const fonts = rel.assets
    .filter((a) => a.name.endsWith('.zip'))
    .map((a) => ({ name: a.name.slice(0, -4), url: a.browser_download_url, sizeMb: Math.round(a.size / 1048576) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(cacheFile(), JSON.stringify({ at: Date.now(), fonts }), 'utf8')
  return fonts
}

export async function listNerdFonts(): Promise<NerdFont[]> {
  const [fonts, installed] = await Promise.all([fetchCatalogue(), installedPackages()])
  return fonts.map((f) => ({ ...f, installed: installed.has(f.name) }))
}

// ---- Install ----------------------------------------------------------------

async function installedPackages(): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(fontsDir(), { withFileTypes: true })
    return new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name))
  } catch {
    return new Set()
  }
}

export async function installNerdFont(name: string, onProgress?: (pct: number) => void): Promise<FontFamily[]> {
  const font = (await fetchCatalogue()).find((f) => f.name === name)
  if (!font) throw new Error(`Unknown Nerd Font: ${name}`)

  const res = await fetch(font.url)
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  const chunks: Uint8Array[] = []
  let got = 0
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk)
    got += chunk.length
    if (total) onProgress?.(Math.round((got / total) * 100))
  }

  const zip = join(tmpdir(), `tendril-${name}-${Date.now()}.zip`)
  const dest = join(fontsDir(), name)
  await fs.writeFile(zip, Buffer.concat(chunks), { mode: 0o600 })
  await fs.rm(dest, { recursive: true, force: true })
  await fs.mkdir(dest, { recursive: true })
  try {
    await extractFonts(zip, dest)
  } finally {
    await fs.unlink(zip).catch(() => {})
  }
  return familiesIn(name)
}

const FONT_ENTRY = /\.(ttf|otf)$/i

/**
 * Unpack the .ttf/.otf files of a zip into `dir`, and nothing else.
 *
 * Every entry is written as `dir/<basename>`: the name inside the archive is
 * never used as a path, so no entry can traverse out of `dir` (`../`, an
 * absolute name, a drive letter) the way a general-purpose unzip has to allow.
 * Directories and symlink entries are skipped outright — a symlink is what
 * turns a later entry into a write anywhere on the disk.
 */
function extractFonts(zipPath: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip: ZipFile) => {
      if (err || !zip) return reject(err ?? new Error('Unreadable zip'))
      const fail = (e: Error): void => {
        zip.close()
        reject(e)
      }
      zip.on('error', fail)
      zip.on('end', () => resolve())
      zip.on('entry', (entry: Entry) => {
        const name = basename(entry.fileName)
        // The upper 4 bits of the external attributes hold the POSIX file type;
        // 0xA is a symlink, which is never a font and never gets written.
        const mode = entry.externalFileAttributes >>> 16
        const symlink = (mode & 0o170000) === 0o120000
        if (entry.fileName.endsWith('/') || symlink || !FONT_ENTRY.test(name)) return zip.readEntry()
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return fail(e ?? new Error(`Unreadable entry: ${entry.fileName}`))
          pipeline(stream, createWriteStream(join(dir, name), { mode: 0o644 }))
            .then(() => zip.readEntry())
            .catch(fail)
        })
      })
      zip.readEntry()
    })
  })
}

export async function uninstallNerdFont(name: string): Promise<void> {
  await fs.rm(join(fontsDir(), name), { recursive: true, force: true })
}

// ---- Families ---------------------------------------------------------------

const WEIGHTS: Record<string, number> = {
  thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, book: 400,
  normal: 400, retina: 450, medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800,
  ultrabold: 800, black: 900, heavy: 900
}

/** "FiraCodeNerdFontPropo-BoldItalic.ttf" → family "FiraCode Nerd Font Propo", 700, italic */
function parseFontFile(file: string): { family: string; weight: number; style: 'normal' | 'italic' } | null {
  const stem = basename(file, extname(file))
  const [fam, variant = 'Regular'] = stem.split('-')
  const m = /^(.*?)NerdFont(Mono|Propo)?$/.exec(fam)
  if (!m) return null
  const family = `${m[1]} Nerd Font${m[2] ? ' ' + m[2] : ''}`
  const v = variant.toLowerCase()
  const style = /italic|oblique/.test(v) ? 'italic' : 'normal'
  const w = v.replace(/italic|oblique/g, '')
  return { family, weight: WEIGHTS[w] ?? 400, style }
}

async function familiesIn(pkg: string): Promise<FontFamily[]> {
  const dir = join(fontsDir(), pkg)
  const byFamily = new Map<string, FontFamily>()
  for (const f of await fs.readdir(dir)) {
    const p = parseFontFile(f)
    if (!p) continue
    const fam = byFamily.get(p.family) ?? { family: p.family, pkg, faces: [] }
    fam.faces.push({ file: join(dir, f), weight: p.weight, style: p.style })
    byFamily.set(p.family, fam)
  }
  return [...byFamily.values()].sort((a, b) => a.family.localeCompare(b.family))
}

export async function installedFamilies(): Promise<FontFamily[]> {
  const out: FontFamily[] = []
  for (const pkg of await installedPackages()) out.push(...(await familiesIn(pkg)))
  return out.sort((a, b) => a.family.localeCompare(b.family))
}

// ---- CSS ----------------------------------------------------------------------

/**
 * @font-face rules for a family. `embed` inlines the files as data: URIs for a
 * self-contained HTML export; otherwise file:// URLs are used (app + PDF print).
 * Only the four faces a document needs are emitted to bound export size.
 */
export async function fontFaceCss(family: string, embed: boolean): Promise<string> {
  const fam = (await installedFamilies()).find((f) => f.family === family)
  if (!fam) return ''
  const wanted = [
    { weight: 400, style: 'normal' },
    { weight: 700, style: 'normal' },
    { weight: 400, style: 'italic' },
    { weight: 700, style: 'italic' }
  ] as const
  const rules: string[] = []
  for (const w of wanted) {
    const face = closestFace(fam.faces, w.weight, w.style)
    if (!face) continue
    const fmt = extname(face.file).toLowerCase() === '.otf' ? 'opentype' : 'truetype'
    const src = embed
      ? `url(data:font/${fmt === 'opentype' ? 'otf' : 'ttf'};base64,${(await fs.readFile(face.file)).toString('base64')})`
      : `url("${pathToFileURL(face.file).href}")`
    rules.push(
      `@font-face{font-family:"${family}";font-weight:${w.weight};font-style:${w.style};font-display:swap;src:${src} format("${fmt}");}`
    )
  }
  return rules.join('\n')
}

function closestFace(faces: FontFace[], weight: number, style: 'normal' | 'italic'): FontFace | undefined {
  const same = faces.filter((f) => f.style === style)
  if (same.length === 0) return undefined
  const best = same.reduce((b, f) => (Math.abs(f.weight - weight) < Math.abs(b.weight - weight) ? f : b))
  // Too far off: let the browser synthesize bold/italic instead of mislabelling.
  return Math.abs(best.weight - weight) <= 150 ? best : undefined
}
