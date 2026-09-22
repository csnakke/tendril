import { localUrl } from './paths'

/** Lightbox for images picked in the explorer: they are viewed, never loaded into the editor. */

const dialog = document.getElementById('imageview') as HTMLDialogElement
const img = dialog.querySelector('.iv-img') as HTMLImageElement
const nameEl = dialog.querySelector('.iv-name') as HTMLElement
const metaEl = dialog.querySelector('.iv-meta') as HTMLElement

export function openImageViewer(path: string): void {
  nameEl.textContent = path.split(/[\\/]/).pop() ?? path
  nameEl.title = path
  metaEl.textContent = ''
  img.src = localUrl('asset', path)
  if (!dialog.open) dialog.showModal()
}

img.addEventListener('load', () => (metaEl.textContent = `${img.naturalWidth} × ${img.naturalHeight}`))
img.addEventListener('error', () => (metaEl.textContent = 'cannot display'))
dialog.querySelector('#imageview-close')!.addEventListener('click', () => dialog.close())
// Click on the backdrop (outside the header/image) closes, like an image viewer.
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close()
})
dialog.addEventListener('close', () => (img.removeAttribute('src')))
