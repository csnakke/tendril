import type { IconName, IconSet } from './types'
import lucide from './lucide'
import tabler from './tabler'
import phosphor from './phosphor'

export type { IconName } from './types'
export type IconSetId = 'lucide' | 'tabler' | 'phosphor'

export const ICON_SETS: Record<IconSetId, { name: string; set: IconSet }> = {
  lucide: { name: 'Lucide', set: lucide },
  tabler: { name: 'Tabler', set: tabler },
  phosphor: { name: 'Phosphor', set: phosphor }
}

let current: IconSetId = 'lucide'

export function iconSet(): IconSetId {
  return current
}

export function icon(name: IconName, setId: IconSetId = current): string {
  const { attrs, paths } = ICON_SETS[setId].set
  return `<svg class="icon" ${attrs} aria-hidden="true">${paths[name]}</svg>`
}

/**
 * Fill every `<i data-icon>` / `<span class="icon-slot" data-icon>` under `root`.
 * Placeholders become slots on first mount so a later set change can re-fill them.
 */
export function mountIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('i[data-icon], .icon-slot[data-icon]').forEach((el) => {
    const name = el.dataset.icon as IconName
    if (el.tagName === 'I') {
      const slot = document.createElement('span')
      slot.className = 'icon-slot'
      slot.dataset.icon = name
      slot.innerHTML = icon(name)
      el.replaceWith(slot)
    } else {
      el.innerHTML = icon(name)
    }
  })
}

/** Switch the active set and re-render all mounted placeholders. */
export function setIconSet(id: IconSetId): void {
  current = id
  mountIcons()
  document.dispatchEvent(new CustomEvent('iconset-changed'))
}
