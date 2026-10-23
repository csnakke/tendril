import { promises as fs } from 'node:fs'
import { extname } from 'node:path'

/**
 * What the editor can open: decided by content, not by name, so `.env`,
 * `Makefile`, `notes.log` or a file with no extension open like any note.
 *
 * Markdown and HTML open as before (a stray Latin-1 byte becomes U+FFFD
 * rather than refusing the file). Anything else is sniffed: no NUL byte in
 * the first 8 KB (binaries almost always have one) and the whole file valid
 * UTF-8. Known binary formats are refused without reading them.
 *
 * A refusal says why, in a sentence the "Cannot open file" message shows as is.
 */

const KNOWN_TEXT = /^\.(md|markdown|html?)$/i
const KNOWN_BINARY =
  /^\.(png|jpe?g|gif|webp|bmp|avif|ico|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|zst|tar|jar|exe|dll|so|dylib|bin|o|a|class|pyc|wasm|mp[34]|m4a|wav|flac|ogg|mov|avi|mkv|webm|ttf|otf|woff2?|docx?|xlsx?|pptx?|odt|sqlite|db|iso|dmg|deb|rpm|appimage)$/i

/** Larger files would make the editor crawl; they are refused rather than loaded. */
export const MAX_TEXT_BYTES = 10 * 1024 * 1024
const SNIFF_BYTES = 8192

export type ReadResult = { text: string } | { error: string }

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`

/** The file's text, or why it cannot be opened (binary, too large, a folder, missing, …). */
export async function readTextFile(path: string): Promise<ReadResult> {
  const ext = extname(path)
  if (KNOWN_BINARY.test(ext)) return { error: `It is a ${ext.slice(1).toUpperCase()} file, which is binary, not text.` }
  try {
    const st = await fs.stat(path)
    if (st.isDirectory()) return { error: 'It is a folder, not a file.' }
    if (!st.isFile()) return { error: 'It is not a regular file.' }
    if (st.size > MAX_TEXT_BYTES) return { error: `It is ${mb(st.size)}; Tendril opens text files up to ${mb(MAX_TEXT_BYTES)}.` }
    const buf = await fs.readFile(path)
    if (KNOWN_TEXT.test(ext)) return { text: buf.toString('utf8') }
    if (buf.subarray(0, SNIFF_BYTES).includes(0)) return { error: 'It contains binary data, so it is not a text file.' }
    try {
      // ignoreBOM keeps a leading BOM in the text, as readFile(…, 'utf8') did, so a save writes it back.
      return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf) }
    } catch {
      return { error: 'It is not UTF-8 text: it is binary, or saved in another encoding (such as Latin-1 or UTF-16).' }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { error: 'The file does not exist; it may have been moved or deleted.' }
    if (code === 'EACCES' || code === 'EPERM') return { error: 'You do not have permission to read it.' }
    return { error: `It could not be read: ${(err as Error).message}` }
  }
}
