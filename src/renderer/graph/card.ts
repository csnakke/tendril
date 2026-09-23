import { escapeHtml } from '../escape'
import type { VNode } from './view'

/**
 * The details card beside the zoomed graph: what the clicked node is, and its
 * neighbours (a note's tags, a tag's notes and sub-tags) as buttons that act
 * like clicking that node.
 */
export function renderCard(el: HTMLElement, node: VNode, neighbours: VNode[], colorOf: (id: string) => string, onPick: (id: string) => void): void {
  const notes = neighbours.filter((n) => n.kind === 'note').sort(byLabel)
  const tags = neighbours.filter((n) => n.kind === 'tag').sort(byLabel)
  const item = (n: VNode): string =>
    `<li><button data-id="${escapeHtml(n.id)}" class="${n.kind}"><span class="dot" style="--dot: ${escapeHtml(colorOf(n.id))}"></span><span class="label">${escapeHtml(n.label)}</span></button></li>`
  const section = (title: string, list: VNode[]): string =>
    list.length ? `<h4>${title} <span>${list.length}</span></h4><ul>${list.map(item).join('')}</ul>` : ''
  el.innerHTML = `
    <div class="gc-kind ${node.kind}" style="--dot: ${escapeHtml(colorOf(node.id))}">${node.kind === 'tag' ? 'Tag' : 'Note'}</div>
    <h3>${escapeHtml(node.label)}</h3>
    ${node.path ? `<div class="gc-path" title="${escapeHtml(node.path)}">${escapeHtml(node.path)}</div>` : ''}
    ${node.kind === 'note' ? section('Tags', tags) : section('Notes', notes) + section('Related tags', tags)}
    ${neighbours.length === 0 ? '<p class="gc-none">No connections.</p>' : ''}`
  el.querySelectorAll<HTMLButtonElement>('button[data-id]').forEach((b) => b.addEventListener('click', () => onPick(b.dataset.id!)))
  el.hidden = false
}

const byLabel = (a: VNode, b: VNode): number => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
