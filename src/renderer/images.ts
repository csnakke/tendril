import { EditorView } from '@codemirror/view'
import { settings } from './appearance'
import { alertBox, confirmBox, errorMessage, messageBox } from './messageBox'
import { collectImages, isLocalImage, type RenderEnv } from './markdown'
import { tableContext } from './tables/editor'
import { formatDate } from './placeholders'
import { dirOf, droppedPaths, IMAGE_FILE, localUrl, relativePath, resolvePath, safeDecodeURI, stemOf } from './paths'

/**
 * Images in notes. Inserted images (Insert Image…, drag & drop, paste) are
 * copied into an assets folder next to the note and referenced relatively:
 * ![name](./assets/name.png). An image that already lives beside the note
 * (e.g. dragged from the explorer) is linked in place instead of copied.
 * Relative paths are resolved for the preview (asset://), PDF printing
 * (file://) and HTML export (data: URIs).
 */

// ---- Resolving --------------------------------------------------------------------

const sepOf = (p: string): string => (p.includes('\\') && !p.includes('/') ? '\\' : '/')

/** Render env for the live preview (asset://) or the PDF printer window (file://). */
export function imageEnv(docPath: string | null, target: 'preview' | 'pdf'): RenderEnv {
  if (!docPath) return {}
  const dir = dirOf(docPath)
  return { resolveImage: (src) => localUrl(target === 'pdf' ? 'file' : 'asset', resolvePath(dir, safeDecodeURI(src))) }
}

/** URL the editor (live preview) can load for an image path written in the note. */
export function previewImageSrc(docPath: string | null, src: string): string {
  if (!isLocalImage(src)) return src
  return docPath ? localUrl('asset', resolvePath(dirOf(docPath), src)) : src
}

/** Render env that embeds every local image as a data: URI (self-contained HTML export). */
export async function embeddedImageEnv(src: string, docPath: string | null): Promise<RenderEnv> {
  if (!docPath) return {}
  const dir = dirOf(docPath)
  const map = new Map<string, string>()
  await Promise.all(
    collectImages(src).map(async (s) => {
      const data = await window.api.fileDataUrl(resolvePath(dir, safeDecodeURI(s)))
      if (data) map.set(s, data)
    })
  )
  return { resolveImage: (s) => map.get(s) ?? s }
}

// ---- Assets folder -------------------------------------------------------------

/** Folders approved this session, keyed by the note's folder. */
const approved = new Map<string, string>()

async function assetsDirFor(docDir: string): Promise<string | null> {
  const known = approved.get(docDir)
  if (known) return known
  const name = settings().assetsFolder.trim() || 'assets'
  const dir = docDir + sepOf(docDir) + name
  if (!(await window.api.fileExists(dir))) {
    await window.api.ensureDir(dir)
    approved.set(docDir, dir)
    return dir
  }
  const choice = await messageBox({
    title: `Store images in the existing “${name}” folder?`,
    detail: dir,
    buttons: [{ label: 'Use this folder', kind: 'primary' }, { label: 'Choose another…' }, { label: 'Cancel' }],
    cancel: 2
  })
  if (choice === 0) {
    approved.set(docDir, dir)
    return dir
  }
  if (choice === 1) {
    const picked = await window.api.pickDir(docDir)
    if (!picked) return null
    approved.set(docDir, picked)
    return picked
  }
  return null
}

// ---- Inserting -------------------------------------------------------------------

interface Host {
  view: EditorView
  docPath: () => string | null
  /** Save the note (Save As for a new one); resolves true when it now has a path. */
  save: () => Promise<boolean>
}
let host: Host

type Source = { name: string; srcPath: string } | { name: string; data: ArrayBuffer }

async function insertImages(sources: Source[], at?: number): Promise<void> {
  if (sources.length === 0) return
  try {
    await insertImagesUnguarded(sources, at)
  } catch (err) {
    await alertBox('Could not insert the image', errorMessage(err))
  }
}

async function insertImagesUnguarded(sources: Source[], at?: number): Promise<void> {
  const { view } = host
  if (!host.docPath()) {
    const ok = await confirmBox('Save the note first', 'Images are copied into an assets folder next to the note.', { ok: 'Save…' })
    if (!ok || !(await host.save())) return
  }
  const docDir = dirOf(host.docPath()!)
  const refs: string[] = []
  const toCopy: Source[] = []
  for (const s of sources) {
    const rel = 'srcPath' in s ? relativePath(docDir, s.srcPath) : null
    if (rel) refs.push(`![${stemOf(rel)}](${rel})`)
    else toCopy.push(s)
  }
  if (toCopy.length > 0) {
    const assetsDir = await assetsDirFor(docDir)
    if (!assetsDir) return
    for (const s of toCopy) {
      try {
        const r = await window.api.importImage({ docDir, assetsDir, name: s.name, ...('srcPath' in s ? { srcPath: s.srcPath } : { data: s.data }) })
        refs.push(`![${stemOf(r.rel)}](${r.rel})`)
      } catch (err) {
        await alertBox(`Could not add ${s.name}`, (err as Error).message)
      }
    }
  }
  if (refs.length === 0) return
  const pos = at ?? view.state.selection.main.head
  // Inside a table cell everything must stay on one line.
  const inTable = !!tableContext(view.state, pos)
  const before = view.state.sliceDoc(Math.max(0, pos - 1), pos)
  const text = (before && !/\s/.test(before) ? ' ' : '') + refs.join(inTable ? ' ' : '\n\n')
  view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length }, scrollIntoView: true, userEvent: 'input.image' })
  view.focus()
}

export async function insertImageFiles(paths: string[], at?: number): Promise<void> {
  await insertImages(paths.filter((p) => IMAGE_FILE.test(p)).map((p) => ({ name: p.split(/[\\/]/).pop()!, srcPath: p })), at)
}

/** Dropped or pasted File objects: real files by path, clipboard bitmaps by content. */
async function insertFileObjects(files: File[], at?: number): Promise<void> {
  await insertImages(await fileSources(files), at)
}

async function fileSources(files: File[]): Promise<Source[]> {
  const sources: Source[] = []
  for (const f of files) {
    if (!f.type.startsWith('image/') && !IMAGE_FILE.test(f.name)) continue
    const p = window.api.pathForFile(f)
    if (p) sources.push({ name: f.name, srcPath: p })
    else {
      const ext = f.type.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') || 'png'
      const stamp = formatDate(new Date(), 'YYYYMMDD-HHmmss')
      sources.push({ name: f.name && f.name !== 'image.png' ? f.name : `image-${stamp}.${ext}`, data: await f.arrayBuffer() })
    }
  }
  return sources
}

/**
 * Everything a drop can carry: File objects (system file manager, clipboard)
 * and bare paths (`text/uri-list` — which is all some Wayland file managers
 * hand over — or the app's own explorer). Non-images are ignored.
 */
async function dropSources(dt: DataTransfer): Promise<Source[]> {
  const sources = await fileSources([...dt.files])
  const seen = new Set(sources.map((s) => ('srcPath' in s ? s.srcPath : '')))
  for (const p of droppedPaths(dt)) {
    if (!IMAGE_FILE.test(p) || seen.has(p)) continue
    seen.add(p)
    sources.push({ name: p.split(/[\\/]/).pop()!, srcPath: p })
  }
  return sources
}

/** During dragover only kinds/types are readable, so accept any file or path payload. */
const carriesFiles = (dt: DataTransfer | null): boolean =>
  !!dt && ([...dt.items].some((i) => i.kind === 'file') || dt.types.includes('text/uri-list') || dt.types.includes('application/x-tendril-paths'))

/** Editor extension: drop or paste image files to insert them. */
export const imageDropPaste = EditorView.domEventHandlers({
  dragover: (e) => {
    if (!carriesFiles(e.dataTransfer)) return false
    e.preventDefault()
    e.dataTransfer!.dropEffect = 'copy'
    return true
  },
  drop: (e, view) => {
    if (!carriesFiles(e.dataTransfer)) return false
    // Claim every file drop: CodeMirror would otherwise paste the bytes as text.
    e.preventDefault()
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head
    void dropSources(e.dataTransfer!).then((s) => insertImages(s, pos))
    return true
  },
  paste: (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
    if (files.length === 0) return false
    e.preventDefault()
    void insertFileObjects(files)
    return true
  }
})

// Dropping anywhere else in the window (preview, reading view) inserts at the cursor.
document.addEventListener('dragover', (e) => {
  if (e.defaultPrevented || !carriesFiles(e.dataTransfer) || (e.target as HTMLElement).closest('#sidebar')) return
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'copy'
})
document.addEventListener('drop', (e) => {
  if (e.defaultPrevented || !carriesFiles(e.dataTransfer) || (e.target as HTMLElement).closest('#sidebar')) return
  e.preventDefault()
  void dropSources(e.dataTransfer!).then((s) => insertImages(s))
})

// ---- Insert Image dialog -----------------------------------------------------------

const dialog = document.getElementById('imagebox') as HTMLDialogElement
const zone = dialog.querySelector('.ib-zone') as HTMLElement

export function openImageDialog(): void {
  dialog.showModal()
}

zone.addEventListener('dragover', (e) => {
  e.preventDefault()
  zone.classList.add('over')
})
zone.addEventListener('dragleave', () => zone.classList.remove('over'))
zone.addEventListener('drop', (e) => {
  e.preventDefault()
  zone.classList.remove('over')
  dialog.close()
  if (e.dataTransfer) void dropSources(e.dataTransfer).then((s) => insertImages(s))
})
dialog.querySelector('#image-browse')!.addEventListener('click', async () => {
  const paths = await window.api.pickImages()
  if (paths.length === 0) return
  dialog.close()
  await insertImageFiles(paths)
})
dialog.querySelector('#image-cancel')!.addEventListener('click', () => dialog.close())

export function initImages(h: Host): void {
  host = h
}
