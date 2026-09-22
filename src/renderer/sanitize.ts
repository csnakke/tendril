import DOMPurify from 'dompurify'

/**
 * A note is a file, and a file can come from anyone. Everything rendered from
 * Markdown passes through here before it becomes live HTML in the preview or
 * is written into an export, because `html: true` (see markdown.ts) is what
 * lets a note carry its own markup in the first place.
 *
 * The window's CSP already refuses to run scripts; this is the other half, and
 * the half an exported file — opened in a browser that has no such policy —
 * has to rely on.
 */

// DOMPurify's own URI list with `asset:` added: that is how the preview
// reaches a note's images (see main/index.ts). `file:` is already on the list
// for the PDF printer window, and `data:` needs no entry — DOMPurify allows it
// on <img> and friends, which is where an embedded export puts it.
const SAFE_URI = /^(?:(?:https?|mailto|ftp|tel|callto|sms|cid|xmpp|file|asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i

/**
 * A note is allowed to style itself — pages.ts scopes a `<style>` block to the
 * document body and the report templates rely on it — but DOMPurify removes
 * that element under every configuration, so the blocks are set aside while
 * the rest is sanitized and put back afterwards. CSS cannot run code, and a
 * `</style>` in the middle of one ends the block here exactly as it does in
 * the parser, so nothing smuggles markup past the sanitizer this way.
 */
const STASH_TAG = 'tendril-style'
const STYLE_BLOCK = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi
const STASH_BACK = new RegExp(`<${STASH_TAG} data-i="(\\d+)"></${STASH_TAG}>`, 'gi')

const CONFIG = {
  ALLOWED_URI_REGEXP: SAFE_URI,
  ADD_TAGS: [STASH_TAG],
  FORBID_TAGS: ['script', 'iframe', 'frame', 'object', 'embed', 'base', 'form', 'meta', 'link'],
  FORBID_ATTR: ['srcdoc', 'formaction', 'ping'],
  // DOMPurify otherwise deletes an id whose value names a property of
  // `document` — a heading called "Title", "Images" or "Location" would
  // quietly lose its anchor, and with it its TOC link, which is the one thing
  // this editor exists for. The ids are content, not code: nothing in the app
  // resolves an element by looking up a global, and `window.api` is defined
  // by contextBridge as an own property, which named access cannot shadow.
  SANITIZE_DOM: false,
  SANITIZE_NAMED_PROPS: false
}

export function sanitizeHtml(html: string): string {
  // No DOM at all (the unit tests run in plain Node): there is nothing to
  // sanitize against, and nothing that renders either. The renderer, which is
  // the only place this turns into HTML, always has one.
  if (!DOMPurify.isSupported) return html
  const styles: string[] = []
  const stashed = html.replace(STYLE_BLOCK, (block) => `<${STASH_TAG} data-i="${styles.push(block) - 1}"></${STASH_TAG}>`)
  const clean = DOMPurify.sanitize(stashed, CONFIG)
  return clean.replace(STASH_BACK, (_m, i: string) => styles[Number(i)] ?? '')
}
