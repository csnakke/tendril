import { promises as fs } from 'node:fs'
import { extname } from 'node:path'

/**
 * What the editor can open: decided by content, not by name, so `.env`,
 * `Makefile`, `notes.log` or a file with no extension open like any note.
 *
 * Known text extensions open as before (a stray Latin-1 byte becomes U+FFFD
 * rather than refusing the file). Anything else is sniffed: no NUL byte in
 * the first 8 KB (binaries almost always have one) and the whole file valid
 * UTF-8. Known binary formats are refused without reading them.
 */

const KNOWN_TEXT = /^\.(md|markdown|txt|html?)$/i
const KNOWN_BINARY =
  /^\.(png|jpe?g|gif|webp|bmp|avif|ico|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|zst|tar|jar|exe|dll|so|dylib|bin|o|a|class|pyc|wasm|mp[34]|m4a|wav|flac|ogg|mov|avi|mkv|webm|ttf|otf|woff2?|docx?|xlsx?|pptx?|odt|sqlite|db|iso|dmg|deb|rpm|appimage)$/i

/** Larger files would make the editor crawl; they are refused rather than loaded. */
export const MAX_TEXT_BYTES = 10 * 1024 * 1024
const SNIFF_BYTES = 8192

/** The file's text, or null when it is not a readable text file (binary, too large, a directory, missing). */
export async function readTextFile(path: string): Promise<string | null> {
  const ext = extname(path)
  if (KNOWN_BINARY.test(ext)) return null
  try {
    const st = await fs.stat(path)
    if (!st.isFile() || st.size > MAX_TEXT_BYTES) return null
    const buf = await fs.readFile(path)
    if (KNOWN_TEXT.test(ext)) return buf.toString('utf8')
    if (buf.subarray(0, SNIFF_BYTES).includes(0)) return null
    // ignoreBOM keeps a leading BOM in the text, as readFile(…, 'utf8') did, so a save writes it back.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf)
  } catch {
    return null // unreadable, vanished, or not valid UTF-8
  }
}
