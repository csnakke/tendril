import type { SshForward, SshHost, SshHostInput, SshSecrets } from '../preload/index'
import { settings, updateSettings } from './appearance'
import { icon } from './icons/index'
import { alertBox, confirmBox, errorMessage } from './messageBox'
import { forwardLabel, hostProblems } from '../shared/ssh'
import { promptSecret } from './sshPrompt'

/**
 * Settings › SSH: the hosts the explorer's Remote section connects to.
 *
 * Two views: the list of saved hosts (Connect, Edit) with this machine's sudo
 * password underneath, and one host's editor in three cards: Connection,
 * Authentication (key, password or both; the key is dropped, pasted or
 * browsed, never shown) and Port forwarding (one line per forward). Name,
 * address and forwards are saved in settings; the key, password and
 * passphrase go straight to `pass` through the main process.
 */

const page = document.querySelector('#settings section[data-page="ssh"]') as HTMLElement
const $ = <T extends HTMLElement>(sel: string): T => page.querySelector(sel) as T
const form = $<HTMLFormElement>('#ssh-form')
const listView = $('#ssh-list-view')
const field = (name: string): HTMLInputElement => form.elements.namedItem(name) as HTMLInputElement
const listEl = $<HTMLUListElement>('#ssh-hosts')
const statusEl = $('#ssh-pass-status')
const errorsEl = $('#ssh-errors')
const fwdListEl = $<HTMLUListElement>('#ssh-forwards')
const fwdEditEl = $('#ssh-fwd-edit')
const dropEl = $('#ssh-drop')
const submitEl = $<HTMLButtonElement>('#ssh-submit')
const testEl = $<HTMLButtonElement>('#ssh-test')

type Auth = 'key' | 'password' | 'both'

/** The host being edited, or null for a new one. */
let editing: SshHost | null = null
let auth: Auth = 'key'
/** A key picked or dropped (read by the main process on save), or pasted text. */
let keyPath: string | null = null
let keyText: string | null = null
const clear = new Set<'key' | 'password' | 'passphrase'>()
let forwards: SshForward[] = []
/** The forward in the inline editor: its index, or -1 for a new one. */
let fwdEditing = -1
/** The host just added or saved: highlighted in the list once. */
let justSaved: { id: string; added: boolean } | null = null

const hosts = (): SshHost[] => settings().sshHosts ?? []

export async function syncSsh(): Promise<void> {
  showList()
  await syncStatus()
}

/** Only a problem is shown: an unset store is simply set up on the first save. */
async function syncStatus(): Promise<void> {
  const st = await window.api.sshPassStatus()
  statusEl.hidden = st.installed && !st.broken
  statusEl.textContent = !st.installed
    ? 'pass is not installed, so keys and passwords cannot be saved. Run the Tendril installer again to install it.'
    : 'Tendril’s password store has lost its key, so saved keys and passwords cannot be read. Saving a key or password sets it up again.'
}

/**
 * Tendril's own password store, set up the first time a secret is saved: a
 * passphrase (typed twice) protects the key Tendril makes for it. False when
 * it is not available (not installed, cancelled, or the setup failed).
 */
async function ensureStore(): Promise<boolean> {
  const st = await window.api.sshPassStatus()
  if (st.ready) return true
  if (!st.installed) {
    await alertBox('pass is not installed', 'Keys and passwords are kept with pass and gnupg. Run the Tendril installer again to install them, then save again.')
    return false
  }
  const intro = st.broken
    ? 'Its key is gone, so keys and passwords saved before cannot be read; they have to be entered again.\n\nChoose a passphrase for the new key.'
    : 'Keys and passwords are kept encrypted in Tendril’s own store, with a key made just for Tendril.\n\nChoose a passphrase for it (8 characters or more). You are asked for it when Tendril needs a saved secret, at most once an hour.'
  const first = await promptSecret('Set up Tendril’s password store', intro, 'Next')
  if (first === null) return false
  if (first.length < 8) {
    await alertBox('Passphrase too short', 'Use at least 8 characters.')
    return false
  }
  const again = await promptSecret('Confirm the passphrase', 'Type the same passphrase again.', 'Set up')
  if (again === null) return false
  if (again !== first) {
    await alertBox('The passphrases do not match', 'Nothing was set up; save again to retry.')
    return false
  }
  try {
    await window.api.sshSetupStore(first)
    await updateSettings({})
    await syncStatus()
    return true
  } catch (err) {
    await alertBox('Could not set up the password store', errorMessage(err))
    return false
  }
}

// ---- Host list ------------------------------------------------------------------------

function showList(): void {
  form.hidden = true
  listView.hidden = false
  $('#ssh-add').hidden = false
  editing = null
  renderHosts()
  $<HTMLInputElement>('#sudo-password').value = ''
  $('#sudo-state').textContent = settings().sudoSaved ? 'Saved in pass' : ''
}

function badge(text: string): string {
  return `<span class="ssh-badge">${text}</span>`
}

function renderHosts(): void {
  if (!hosts().length) {
    listEl.innerHTML = `<li class="ssh-empty"><b>No hosts yet</b><span>Add a server once; connect to it from the explorer's Remote section.</span></li>`
    return
  }
  listEl.replaceChildren(
    ...hosts().map((h) => {
      const li = document.createElement('li')
      li.dataset.id = h.id
      const fresh = justSaved?.id === h.id
      li.classList.toggle('just-saved', fresh)
      li.innerHTML = `<span class="sh-icon">${icon('server')}</span>
        <span class="sh-main"><span class="sh-name"></span><span class="sh-addr"></span></span>
        ${fresh ? `<span class="ssh-saved">${justSaved!.added ? 'Added' : 'Saved'}</span>` : ''}
        <span class="sh-badges">${h.hasKey ? badge('key') : ''}${h.hasPassword ? badge('password') : ''}${h.forwards.length ? badge(`${h.forwards.length} forward${h.forwards.length > 1 ? 's' : ''}`) : ''}</span>
        <button type="button" class="ssh-ghost" data-act="connect">Connect</button>
        <button type="button" class="ssh-btn" data-act="edit">Edit</button>`
      li.querySelector('.sh-name')!.textContent = h.name
      li.querySelector('.sh-addr')!.textContent = `${h.user}@${h.hostname}${h.port === 22 ? '' : `:${h.port}`}`
      return li
    })
  )
  if (justSaved) {
    listEl.querySelector('li.just-saved')?.scrollIntoView({ block: 'nearest' })
    justSaved = null
  }
}

listEl.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]')
  const host = hosts().find((h) => h.id === (e.target as HTMLElement).closest<HTMLElement>('li')?.dataset.id)
  if (!host) return
  if (!btn || btn.dataset.act === 'edit') return openEditor(host)
  // Connect: the Remote section shows the connection; Settings steps aside.
  ;(document.getElementById('settings') as HTMLDialogElement).close()
  try {
    await window.api.remoteConnect({ hostId: host.id })
  } catch (err) {
    await alertBox(`Could not connect to ${host.name}`, errorMessage(err))
  }
})

$('#ssh-add').addEventListener('click', () => openEditor(null))
$('#ssh-back').addEventListener('click', () => showList())

// ---- Editor ---------------------------------------------------------------------------

function openEditor(host: SshHost | null): void {
  editing = host
  keyPath = null
  keyText = null
  clear.clear()
  form.reset()
  field('name').value = host?.name ?? ''
  field('hostname').value = host?.hostname ?? ''
  field('user').value = host?.user ?? ''
  field('port').value = String(host?.port ?? 22)
  forwards = (host?.forwards ?? []).map((f) => ({ ...f }))
  setAuth(host ? (host.hasKey && host.hasPassword ? 'both' : host.hasPassword && !host.hasKey ? 'password' : 'key') : 'key')
  $('#ssh-form-title').textContent = host ? host.name : 'New host'
  submitEl.textContent = host ? 'Save' : 'Add host'
  testEl.hidden = !host
  $('#ssh-delete').hidden = !host
  errorsEl.textContent = ''
  closeFwdEditor()
  renderForwards()
  syncKey()
  listView.hidden = true
  $('#ssh-add').hidden = true
  form.hidden = false
  page.closest<HTMLElement>('.st-pages')!.scrollTop = 0
  field(host ? 'hostname' : 'name').focus()
}

function setAuth(next: Auth): void {
  auth = next
  page.querySelectorAll<HTMLButtonElement>('.ssh-seg button').forEach((b) => b.classList.toggle('active', b.dataset.auth === next))
  form.dataset.auth = next
}
page.querySelectorAll<HTMLButtonElement>('.ssh-seg button').forEach((b) => b.addEventListener('click', () => setAuth(b.dataset.auth as Auth)))

/** The key area says what will happen to the key; it never shows the key itself. */
function syncKey(): void {
  const saved = !!editing?.hasKey && !clear.has('key')
  const title = $('#ssh-drop-title')
  const sub = $('#ssh-drop-sub')
  dropEl.classList.toggle('ready', !!(keyPath || keyText || saved))
  if (keyPath) {
    title.textContent = keyPath.split(/[\\/]/).pop() ?? keyPath
    sub.textContent = 'Saved to pass when you save the host.'
  } else if (keyText) {
    title.textContent = 'Pasted key'
    sub.textContent = `${keyText.match(/BEGIN ([A-Z0-9 ]*)PRIVATE KEY/)?.[1]?.trim() || 'Private'} key · saved to pass when you save the host.`
  } else if (saved) {
    title.textContent = 'Key saved in pass'
    sub.textContent = 'Drop or paste another key to replace it.'
  } else {
    title.textContent = 'Drop a private key here, or paste it'
    sub.textContent = 'An OpenSSH or PEM key, such as an AWS .pem file.'
  }
  page.querySelector<HTMLButtonElement>('button[data-clear="key"]')!.hidden = !(keyPath || keyText || saved)
  for (const what of ['password', 'passphrase'] as const) {
    const has = what === 'password' ? !!editing?.hasPassword : !!editing?.hasPassphrase
    field(what).placeholder = has && !clear.has(what) ? 'Saved in pass. Leave empty to keep it.' : what === 'passphrase' ? 'Only if the key has one' : ''
  }
}

page.querySelector<HTMLButtonElement>('button[data-clear="key"]')!.addEventListener('click', () => {
  keyPath = null
  keyText = null
  if (editing?.hasKey) clear.add('key')
  syncKey()
})

$('#ssh-browse').addEventListener('click', async () => {
  const path = await window.api.sshPickKey()
  if (!path) return
  keyPath = path
  keyText = null
  clear.delete('key')
  syncKey()
})

dropEl.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return
  e.preventDefault()
  dropEl.classList.add('over')
})
dropEl.addEventListener('dragleave', () => dropEl.classList.remove('over'))
dropEl.addEventListener('drop', (e) => {
  e.preventDefault()
  dropEl.classList.remove('over')
  const file = e.dataTransfer?.files[0]
  const path = file ? window.api.pathForFile(file) : ''
  if (!path) return
  keyPath = path
  keyText = null
  clear.delete('key')
  syncKey()
})
dropEl.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text/plain') ?? ''
  if (!text.trim()) return
  e.preventDefault()
  if (!/PRIVATE KEY-----/.test(text)) {
    errorsEl.textContent = 'That is not a private key (it should start with -----BEGIN … PRIVATE KEY-----).'
    return
  }
  errorsEl.textContent = ''
  keyText = text
  keyPath = null
  clear.delete('key')
  syncKey()
})

// ---- Port forwards --------------------------------------------------------------------

const typeName = { L: 'Local', R: 'Remote', D: 'Dynamic' } as const

function renderForwards(): void {
  fwdListEl.replaceChildren(
    ...forwards.map((f, i) => {
      const li = document.createElement('li')
      li.dataset.i = String(i)
      li.innerHTML = `<label class="ssh-switch" title="Start with the connection"><input type="checkbox" ${f.enabled ? 'checked' : ''} /><span></span></label>
        <span class="fw-type"></span><span class="fw-desc"></span>${f.lan ? badge('LAN') : ''}
        <button type="button" class="ssh-ghost" data-act="edit">Edit</button>
        <button type="button" class="ssh-icon" data-act="remove" title="Remove">${icon('x')}</button>`
      li.querySelector('.fw-type')!.textContent = typeName[f.type]
      li.querySelector('.fw-desc')!.textContent = forwardLabel(f)
      return li
    })
  )
  $('#ssh-fwd-hint').textContent = forwards.length || !fwdEditEl.hidden ? '' : 'None. Local reaches a server-side port from here; Remote the other way; Dynamic is a SOCKS proxy.'
}

fwdListEl.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('li')
  if (!li) return
  const i = Number(li.dataset.i)
  const target = e.target as HTMLElement
  if (target.matches('input[type="checkbox"]')) {
    forwards[i].enabled = (target as HTMLInputElement).checked
    return
  }
  const act = target.closest<HTMLButtonElement>('button[data-act]')?.dataset.act
  if (act === 'remove') {
    forwards.splice(i, 1)
    closeFwdEditor()
    renderForwards()
  } else if (act === 'edit') {
    openFwdEditor(i)
  }
})

const fq = <T extends HTMLElement>(k: string): T => fwdEditEl.querySelector(`[data-f="${k}"]`) as T

function syncFwdType(): void {
  const d = fq<HTMLSelectElement>('type').value === 'D'
  fq<HTMLInputElement>('host').hidden = d
  fq<HTMLInputElement>('port').hidden = d
  fwdEditEl.querySelector<HTMLElement>('.ssh-arrow')!.hidden = d
}
fq('type').addEventListener('change', syncFwdType)

function openFwdEditor(i: number): void {
  fwdEditing = i
  const f = forwards[i]
  fq<HTMLSelectElement>('type').value = f?.type ?? 'L'
  fq<HTMLInputElement>('bindPort').value = f ? String(f.bindPort) : ''
  fq<HTMLInputElement>('host').value = f?.host || 'localhost'
  fq<HTMLInputElement>('port').value = f && f.type !== 'D' ? String(f.port) : ''
  fq<HTMLInputElement>('lan').checked = !!f?.lan
  syncFwdType()
  fwdEditEl.hidden = false
  renderForwards()
  fq<HTMLInputElement>('bindPort').focus()
}

function closeFwdEditor(): void {
  fwdEditing = -1
  fwdEditEl.hidden = true
}

$('#ssh-add-forward').addEventListener('click', () => openFwdEditor(-1))
$('#ssh-fwd-cancel').addEventListener('click', () => {
  closeFwdEditor()
  renderForwards()
})
$('#ssh-fwd-done').addEventListener('click', () => {
  const type = fq<HTMLSelectElement>('type').value as SshForward['type']
  const f: SshForward = {
    id: forwards[fwdEditing]?.id ?? Math.random().toString(36).slice(2),
    type,
    bindPort: Number(fq<HTMLInputElement>('bindPort').value),
    host: type === 'D' ? '' : fq<HTMLInputElement>('host').value.trim(),
    port: type === 'D' ? 0 : Number(fq<HTMLInputElement>('port').value),
    lan: fq<HTMLInputElement>('lan').checked,
    enabled: forwards[fwdEditing]?.enabled ?? true
  }
  const problems = hostProblems({ id: '', name: 'x', hostname: 'x', user: 'x', port: 22, forwards: [f] })
  if (problems.length) {
    errorsEl.textContent = problems.join('\n')
    return
  }
  errorsEl.textContent = ''
  if (fwdEditing >= 0) forwards[fwdEditing] = f
  else forwards.push(f)
  closeFwdEditor()
  renderForwards()
})

// ---- Save, test, delete ---------------------------------------------------------------

function readForm(): SshHostInput {
  return {
    id: editing?.id ?? '',
    name: field('name').value.trim(),
    hostname: field('hostname').value.trim(),
    user: field('user').value.trim(),
    port: Number(field('port').value || 22),
    forwards
  }
}

/** Save the host; back to the list (showing it) unless `stay` (Test connection). */
async function submit(stay = false): Promise<SshHost | null> {
  const host = readForm()
  const problems = hostProblems(host)
  if (problems.length) {
    errorsEl.textContent = problems.join('\n')
    return null
  }
  const secrets: SshSecrets = { clear: [...clear] }
  const useKey = auth !== 'password'
  const usePassword = auth !== 'key'
  if (useKey) {
    if (keyPath) secrets.keyPath = keyPath
    else if (keyText) secrets.key = keyText
    if (field('passphrase').value) secrets.passphrase = field('passphrase').value
  } else {
    // Password only: a key saved before goes.
    if (editing?.hasKey) secrets.clear!.push('key')
    if (editing?.hasPassphrase) secrets.clear!.push('passphrase')
  }
  if (usePassword) {
    if (field('password').value) secrets.password = field('password').value
  } else if (editing?.hasPassword) {
    secrets.clear!.push('password')
  }
  // The first secret ever saved sets the store up.
  if ((secrets.key || secrets.keyPath || secrets.password || secrets.passphrase) && !(await ensureStore())) return null
  submitEl.disabled = true
  try {
    const list = await window.api.sshSaveHost(host, secrets)
    await updateSettings({})
    const saved = list.find((h) => h.name === host.name) ?? null
    if (saved && stay) openEditor(saved)
    else if (saved) {
      justSaved = { id: saved.id, added: !host.id }
      showList()
    }
    return saved
  } catch (err) {
    errorsEl.textContent = errorMessage(err)
    return null
  } finally {
    submitEl.disabled = false
  }
}

submitEl.addEventListener('click', () => void submit())
form.addEventListener('submit', (e) => {
  e.preventDefault()
  void submit()
})
// Enter in a field saves the host; in the forward editor it finishes that forward.
form.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement
  if (e.key !== 'Enter' || !t.matches('input:not([type="checkbox"])')) return
  e.preventDefault()
  if (fwdEditEl.contains(t)) $<HTMLButtonElement>('#ssh-fwd-done').click()
  else void submit()
})

testEl.addEventListener('click', async () => {
  const saved = await submit(true)
  if (!saved) return
  testEl.disabled = true
  testEl.textContent = 'Connecting…'
  try {
    await alertBox(`${saved.name} works`, await window.api.sshTest(saved.id))
  } catch (err) {
    await alertBox(`Could not connect to ${saved.name}`, errorMessage(err))
  } finally {
    testEl.disabled = false
    testEl.textContent = 'Test connection'
  }
})

$('#ssh-delete').addEventListener('click', async () => {
  const host = editing
  if (!host) return
  if (!(await confirmBox(`Delete ${host.name}?`, 'Its saved key, password and passphrase are removed from pass too.', { ok: 'Delete', danger: true }))) return
  try {
    await window.api.sshDeleteHost(host.id)
    await updateSettings({})
    showList()
  } catch (err) {
    await alertBox('Could not delete the host', errorMessage(err))
  }
})

// ---- sudo -----------------------------------------------------------------------------

$('#sudo-save').addEventListener('click', async () => {
  const input = $<HTMLInputElement>('#sudo-password')
  if (!input.value) return
  if (!(await ensureStore())) return
  try {
    await window.api.sshSaveSudo(input.value)
    input.value = ''
    await updateSettings({})
    $('#sudo-state').textContent = 'Saved in pass'
  } catch (err) {
    await alertBox('Could not save the sudo password', errorMessage(err))
  }
})
$('#sudo-clear').addEventListener('click', async () => {
  await window.api.sshClearSudo()
  await updateSettings({})
  $('#sudo-state').textContent = ''
})
