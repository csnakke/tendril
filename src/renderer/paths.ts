/** Small path helpers for the renderer (no Node `path` there). */

export const dirOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))) || path

export const stemOf = (path: string): string => (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]+$/, '')

export const isAbsolutePath = (p: string): boolean => /^[a-z]:[\\/]/i.test(p) || p.startsWith('/')

/** Resolve `rel` against `dir` into an absolute, forward-slash path. */
export function resolvePath(dir: string, rel: string): string {
  if (isAbsolutePath(rel)) return rel.replace(/\\/g, '/')
  const parts = dir.replace(/\\/g, '/').split('/')
  for (const seg of rel.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length > 1) parts.pop()
    } else parts.push(seg)
  }
  return parts.join('/')
}

/** decodeURI that tolerates a stray `%` (`50%off.png`) instead of throwing. */
export function safeDecodeURI(s: string): string {
  try {
    return decodeURI(s)
  } catch {
    return s
  }
}

/** `asset:///abs/path` or `file:///abs/path`, percent-encoded. */
export const localUrl = (scheme: 'asset' | 'file', abs: string): string =>
  `${scheme}://${abs.startsWith('/') ? '' : '/'}${encodeURI(abs).replace(/[?#]/g, encodeURIComponent)}`

export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i
/**
 * Files whose preview is rendered Markdown. Any other text file (.env, .log,
 * a file with no extension) opens too, but previews as plain text and gets no
 * live preview: `# comment` in a config file is not a heading. What counts as
 * text at all is decided by content in the main process (textFile.ts).
 */
const MARKUP_FILE = /\.(md|markdown|txt|html?)$/i
export const rendersMarkdown = (path: string | null): boolean => !path || MARKUP_FILE.test(path)

/** `abs` relative to `dir` as a forward-slash path (`./x/y.png`), or null when it isn't inside `dir`. */
export function relativePath(dir: string, abs: string): string | null {
  const d = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  const a = abs.replace(/\\/g, '/')
  if (!a.startsWith(d + '/')) return null
  return './' + a.slice(d.length + 1)
}

/** Local paths carried by a drag: `text/uri-list` file URLs and the explorer's own paths. */
export function droppedPaths(dt: DataTransfer): string[] {
  const out = new Set<string>()
  for (const line of (dt.getData('application/x-tendril-paths') || '').split('\n')) if (line) out.add(line)
  for (const line of (dt.getData('text/uri-list') || '').split(/\r?\n/)) {
    if (!line.startsWith('file://')) continue
    let p: string
    try {
      p = decodeURIComponent(new URL(line).pathname)
    } catch {
      continue
    }
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
    out.add(p)
  }
  return [...out]
}
