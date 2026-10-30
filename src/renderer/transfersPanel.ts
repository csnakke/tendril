import type { Transfer } from '../preload/index'
import { icon } from './icons/index'
import { closePopup, showPopup } from './tables/menu'

/**
 * Transfers (main/ssh/transfers.ts) in the status bar: a chip with the overall
 * progress, and a panel listing each upload and download with its speed and
 * time left, Stop and Resume. It stays until the finished ones are cleared.
 */

const chipEl = document.getElementById('xfer-chip') as HTMLButtonElement
let list: Transfer[] = []
let panel: HTMLElement | null = null
/** When the panel last closed: the click that closed it (on the chip) must not reopen it. */
let closedAt = 0

const live = (t: Transfer): boolean => t.state === 'queued' || t.state === 'running' || t.state === 'retrying'
export const activeTransfers = (): number => list.filter(live).length

function renderChip(): void {
  chipEl.hidden = list.length === 0
  if (!list.length) return
  const active = list.filter(live)
  const running = active.find((t) => t.state === 'running' && t.percent !== null)
  const trouble = list.filter((t) => t.state === 'failed' || t.state === 'stopped').length
  const text = active.length
    ? `${active.length} transfer${active.length > 1 ? 's' : ''}${running ? ` · ${running.percent}%` : ''}`
    : trouble
      ? `${trouble} not finished`
      : 'Transfers done'
  chipEl.classList.toggle('warn', !active.length && trouble > 0)
  chipEl.innerHTML = `${icon(active.some((t) => t.direction === 'down') && !active.some((t) => t.direction === 'up') ? 'arrow-down' : 'arrow-up')}<span></span>`
  chipEl.querySelector('span')!.textContent = text
}

function status(t: Transfer): string {
  switch (t.state) {
    case 'queued':
      return 'Waiting'
    case 'running':
      return t.percent === null ? 'Transferring (sftp: no progress shown)' : `${t.percent}%${t.speed ? ` · ${t.speed}` : ''}${t.eta && t.percent < 100 ? ` · ${t.eta} left` : ''}`
    case 'retrying':
      return t.message ?? 'Retrying'
    case 'done':
      return t.message ?? 'Done'
    case 'failed':
      return `Failed: ${t.message ?? ''}`
    case 'stopped':
      return 'Stopped'
  }
}

function renderPanel(): void {
  if (!panel) return
  const rows = list.map((t) => {
    const row = document.createElement('div')
    row.className = `xf-row ${t.state}`
    row.innerHTML = `${icon(t.direction === 'up' ? 'arrow-up' : 'arrow-down')}
      <div class="xf-main">
        <div class="xf-name"></div>
        <div class="xf-where"></div>
        ${t.percent !== null && t.state !== 'done' ? `<div class="xf-bar"><i style="width:${t.percent}%"></i></div>` : ''}
        <div class="xf-status"></div>
      </div>
      ${live(t) ? `<button type="button" data-act="stop" title="Stop (partial files are kept)">Stop</button>` : ''}
      ${t.state === 'failed' || t.state === 'stopped' ? `<button type="button" data-act="resume" title="Continue where it left off">Resume</button>` : ''}`
    row.querySelector('.xf-name')!.textContent = t.name
    row.querySelector('.xf-where')!.textContent = t.direction === 'up' ? `to ${t.host}:${t.dest}` : `from ${t.host} to ${t.dest}`
    row.querySelector('.xf-status')!.textContent = status(t)
    row.dataset.id = String(t.id)
    return row
  })
  const foot = document.createElement('div')
  foot.className = 'xf-foot'
  foot.innerHTML = `<span>${list.length} transfer${list.length === 1 ? '' : 's'}</span><button type="button" data-act="clear">Clear finished</button>`
  panel.replaceChildren(...rows, foot)
}

chipEl.addEventListener('click', () => {
  if (panel) {
    closePopup()
    panel = null
    return
  }
  if (Date.now() - closedAt < 300) return
  panel = document.createElement('div')
  panel.className = 'xfer-panel'
  panel.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]')
    if (!b) return
    const id = Number(b.closest<HTMLElement>('.xf-row')?.dataset.id)
    if (b.dataset.act === 'stop') window.api.transferStop(id)
    else if (b.dataset.act === 'resume') window.api.transferResume(id)
    else window.api.transfersClear()
  })
  renderPanel()
  const r = chipEl.getBoundingClientRect()
  showPopup(panel, r.right, r.top - 8)
  // Opened upward from the chip.
  const h = panel.getBoundingClientRect()
  panel.style.top = `${Math.max(8, r.top - 6 - h.height)}px`
  panel.style.left = `${Math.max(8, r.right - h.width)}px`
  const observer = new MutationObserver(() => {
    if (!panel?.isConnected) {
      panel = null
      closedAt = Date.now()
      observer.disconnect()
    }
  })
  observer.observe(document.body, { childList: true })
})

window.api.onTransfers((next) => {
  list = next
  renderChip()
  renderPanel()
})
void window.api.transfers().then((next) => {
  list = next
  renderChip()
})
