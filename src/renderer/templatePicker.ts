import type { Template, TemplateKind } from '../preload/index'
import { settings } from './appearance'
import { renderBody } from './markdown'
import { isPaged } from './pages'
import { CURSOR, expandPlaceholders, slugFileName, takeCursor } from './placeholders'
import { BUILTIN_TEMPLATES } from './templates/index'
import { icon } from './icons/index'

/**
 * File > New from Template: pick a note/report template, name it, then choose
 * where to save it. The save dialog starts in the explorer's folder with
 * `<title>.md` filled in; nothing is written until the user confirms a place.
 */

export interface NewDocument {
  content: string
  cursor: number
  /** Where the user saved the new file. */
  path: string
}

const dialog = document.getElementById('templates') as HTMLDialogElement
const $ = <T extends HTMLElement>(sel: string): T => dialog.querySelector(sel) as T
const listEl = $<HTMLUListElement>('#template-list')
const previewEl = $<HTMLElement>('#template-preview')
const titleEl = $<HTMLInputElement>('#template-title')
const folderEl = $<HTMLElement>('#template-folder')
const createBtn = $<HTMLButtonElement>('#template-create')

let kind: TemplateKind = 'notes'
let templates: Template[] = []
let selected: Template | null = null
let folder: string | null = null
let resolveOpen: ((doc: NewDocument | null) => void) | null = null

export async function pickTemplate(targetFolder: string | null): Promise<NewDocument | null> {
  folder = targetFolder
  templates = [...BUILTIN_TEMPLATES, ...(await window.api.listUserTemplates().catch(() => []))]
  titleEl.value = ''
  const name = folder?.split(/[\\/]/).filter(Boolean).pop()
  folderEl.textContent = name ? `You choose where to save it (starting in ${name})` : 'You choose where to save it'
  folderEl.title = folder ?? ''
  setKind(kind)
  dialog.showModal()
  titleEl.focus()
  return new Promise((resolve) => (resolveOpen = resolve))
}

function setKind(next: TemplateKind): void {
  kind = next
  dialog.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach((b) => b.classList.toggle('active', b.dataset.kind === next))
  const list = templates.filter((t) => t.kind === kind)
  select(list.find((t) => t.id === selected?.id) ?? list[0] ?? null)
  renderList()
}

function renderList(): void {
  listEl.replaceChildren(
    ...templates
      .filter((t) => t.kind === kind)
      .map((t) => {
        const li = document.createElement('li')
        li.dataset.id = t.id
        li.className = t.id === selected?.id ? 'active' : ''
        li.innerHTML = `${icon(t.kind === 'reports' ? 'file-text' : 'file')}<span class="name"></span>${t.id.startsWith('user:') ? '<span class="badge">yours</span>' : ''}`
        li.querySelector('.name')!.textContent = t.name
        return li
      })
  )
}

function select(t: Template | null): void {
  selected = t
  listEl.querySelectorAll('li').forEach((li) => li.classList.toggle('active', li.dataset.id === t?.id))
  createBtn.disabled = !t
  renderPreview()
}

function renderPreview(): void {
  if (!selected) {
    previewEl.innerHTML = '<p class="empty">No templates of this kind. Add .md files to the templates folder.</p>'
    previewEl.classList.remove('paged')
    return
  }
  const sample = expandPlaceholders(selected.content, context()).replace(CURSOR, '')
  previewEl.innerHTML = renderBody(sample)
  previewEl.classList.toggle('paged', isPaged(sample))
  previewEl.scrollTop = 0
}

function context(): { title: string; author: string; filename: string } {
  const title = titleEl.value.trim() || 'Untitled'
  return { title, author: settings().author, filename: slugFileName(title) }
}

async function create(): Promise<void> {
  if (!selected) return
  const ctx = context()
  const { text, cursor } = takeCursor(expandPlaceholders(selected.content, ctx))
  const suggested = folder ? `${folder.replace(/[\\/]$/, '')}/${ctx.filename}.md` : `${ctx.filename}.md`
  // The native dialog confirms overwriting; cancelling keeps the picker open with the title intact.
  const path = await window.api.saveFile(null, text, suggested)
  if (!path) return
  close({ content: text, cursor, path })
}

function close(result: NewDocument | null): void {
  dialog.close()
  resolveOpen?.(result)
  resolveOpen = null
}

dialog.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach((b) => b.addEventListener('click', () => setKind(b.dataset.kind as TemplateKind)))
listEl.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-id]')
  if (li) select(templates.find((t) => t.id === li.dataset.id) ?? null)
})
listEl.addEventListener('dblclick', () => void create())
titleEl.addEventListener('input', renderPreview)
titleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    void create()
  }
})
createBtn.addEventListener('click', () => void create())
$('#template-cancel').addEventListener('click', () => close(null))
$('#template-open-folder').addEventListener('click', () => void window.api.openTemplatesFolder())
dialog.addEventListener('cancel', (e) => {
  e.preventDefault()
  close(null)
})
