import { promises as fs } from 'node:fs'
import { hostname as machineName, userInfo } from 'node:os'
import { basename, isAbsolute, posix } from 'node:path'
import { clipboard, dialog, Menu, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron'
import { forwardLabel, hostProblems, HOSTNAME, USER, type RemoteState, type SshHost, type SshHostInput, type SshPrompt, type SshSecrets, type Transfer } from '../../shared/ssh'
import { loadSettings, saveSettings } from '../settings'
import { setAskHandler, stopAskpass, type AskContext, type PromptKind } from './askpass'
import { Connection } from './connection'
import { passGetSecret, passHas, passMove, passRemove, passSegment, passSet, passStatus, setupStore } from './pass'
import { Transfers } from './transfers'

/**
 * The Remote section of the explorer: saved hosts (Settings › SSH), the one
 * open connection, its port forwards and transfers, and the answers to ssh's
 * password prompts. Keys, passwords and passphrases go to `pass` and come
 * back from it here, in the main process; the window never receives them.
 */

type Handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: never[]) => unknown) => void
type On = (channel: string, fn: (e: IpcMainEvent, ...args: never[]) => void) => void

let getWin: () => BrowserWindow | null = () => null
let conn: Connection | null = null
let lastError: string | undefined
/** The remote folder last opened in the explorer: where "Upload to remote" sends things. */
let remoteDir: string | null = null

const send = (channel: string, ...args: unknown[]): void => {
  const w = getWin()
  if (w && !w.isDestroyed()) w.webContents.send(channel, ...args)
}

// ---- Saved hosts ------------------------------------------------------------------

const entry = (name: string, what: 'key' | 'password' | 'passphrase'): string => `tendril/ssh/${name}/${what}`
export const sudoEntry = (): string => `tendril/sudo/${passSegment(`${userInfo().username}@${machineName()}`)}`

async function hosts(): Promise<SshHost[]> {
  return (await loadSettings()).sshHosts
}

async function saveHost(input: SshHostInput, secrets: SshSecrets): Promise<SshHost[]> {
  const host: SshHostInput = {
    id: String(input.id || Date.now().toString(36)),
    name: String(input.name ?? '').trim(),
    hostname: String(input.hostname ?? '').trim(),
    user: String(input.user ?? '').trim(),
    port: Number(input.port),
    forwards: (Array.isArray(input.forwards) ? input.forwards : []).map((f) => ({
      id: String(f.id || Math.random().toString(36).slice(2)),
      type: f.type === 'R' || f.type === 'D' ? f.type : 'L',
      bindPort: Number(f.bindPort),
      host: String(f.host ?? '').trim(),
      port: Number(f.port),
      lan: !!f.lan,
      enabled: !!f.enabled
    }))
  }
  const problems = hostProblems(host)
  const list = await hosts()
  const old = list.find((h) => h.id === host.id)
  if (list.some((h) => h.name === host.name && h.id !== host.id)) problems.push(`There is already a host called ${host.name}.`)
  if (problems.length) throw new Error(problems.join('\n'))

  let key = typeof secrets.key === 'string' ? secrets.key.trim() : ''
  if (secrets.keyPath) {
    const st = await fs.stat(secrets.keyPath)
    if (!st.isFile() || st.size > 64 * 1024) throw new Error('That does not look like a private key file.')
    key = (await fs.readFile(secrets.keyPath, 'utf8')).trim()
  }
  if (key && !/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(key)) {
    throw new Error('The key is not a private key (it should start with -----BEGIN … PRIVATE KEY-----).')
  }
  const password = typeof secrets.password === 'string' ? secrets.password : ''
  const passphrase = typeof secrets.passphrase === 'string' ? secrets.passphrase : ''
  if ((key || password || passphrase) && !(await passStatus()).ready) {
    throw new Error('Tendril’s password store is not set up yet; save again to set it up.')
  }

  // A renamed host takes its saved secrets along.
  if (old && old.name !== host.name) await passMove(`tendril/ssh/${old.name}`, `tendril/ssh/${host.name}`)
  const clear = new Set(Array.isArray(secrets.clear) ? secrets.clear : [])
  const flags = { hasKey: !!old?.hasKey, hasPassword: !!old?.hasPassword, hasPassphrase: !!old?.hasPassphrase }
  for (const [what, value, flag] of [['key', key ? key + '\n' : '', 'hasKey'], ['password', password, 'hasPassword'], ['passphrase', passphrase, 'hasPassphrase']] as const) {
    if (value) {
      await passSet(entry(host.name, what), value)
      flags[flag] = true
    } else if (clear.has(what)) {
      await passRemove(entry(host.name, what))
      flags[flag] = false
    }
  }
  const saved: SshHost = { ...host, ...flags }
  const next = old ? list.map((h) => (h.id === saved.id ? saved : h)) : [...list, saved]
  await saveSettings({ sshHosts: next })
  return next
}

async function deleteHost(id: string): Promise<SshHost[]> {
  const list = await hosts()
  const host = list.find((h) => h.id === id)
  if (!host) return list
  if (conn?.hostId === id) disconnect()
  await passRemove(`tendril/ssh/${host.name}`)
  const next = list.filter((h) => h.id !== id)
  await saveSettings({ sshHosts: next })
  return next
}

/** What each host (and sudo) has saved, read from the store itself: right after a new or rebuilt store. */
async function syncSavedFlags(): Promise<void> {
  const list = await hosts()
  for (const h of list) {
    h.hasKey = await passHas(entry(h.name, 'key'))
    h.hasPassword = await passHas(entry(h.name, 'password'))
    h.hasPassphrase = await passHas(entry(h.name, 'passphrase'))
  }
  await saveSettings({ sshHosts: list, sudoSaved: await passHas(sudoEntry()) })
}

// ---- Password prompts ----------------------------------------------------------------

let promptSeq = 0
const prompts = new Map<number, (r: { value: string | null; save: boolean }) => void>()

function askWindow(p: Omit<SshPrompt, 'id'>): Promise<{ value: string | null; save: boolean }> {
  const w = getWin()
  if (!w || w.isDestroyed()) return Promise.resolve({ value: null, save: false })
  const id = ++promptSeq
  w.webContents.send('ssh:prompt', { ...p, id })
  return new Promise((resolve) => prompts.set(id, resolve))
}

/** When each entry was last answered from `pass`: asked again soon after means it was wrong. */
const triedAt = new Map<string, number>()
const RETRY_WINDOW = 60_000
/** Typed with "Save in pass" ticked: saved once the login it was for succeeds. */
const toSave = new Map<string, string>()

/** The `pass` entry that answers this prompt, if any. */
async function entryFor(ctx: AskContext, prompt: string, kind: PromptKind): Promise<string | null> {
  const keyFile = prompt.match(/passphrase for key ['"]?([^'"]+?)['"]?:/i)?.[1]
  if (ctx.host) return kind === 'password' ? entry(ctx.host.name, 'password') : kind === 'passphrase' ? entry(ctx.host.name, 'passphrase') : null
  if (kind === 'passphrase') return keyFile ? `tendril/ssh-key/${passSegment(basename(keyFile))}` : null
  if (kind !== 'password') return null
  let user = ctx.target?.user
  let host = ctx.target?.hostname
  if (ctx.terminal) {
    // "user@host's password:" (ssh) or "(user@host) Password:" (keyboard-interactive)
    const m = prompt.match(/\(?([^\s@()']+)@([^\s:()']+)\)?(?:'s)?\s+password/i)
    if (!m) return null
    ;[, user, host] = m
    const saved = (await hosts()).find((h) => h.user === user && h.hostname === host)
    if (saved) return entry(saved.name, 'password')
  }
  return user && host ? `tendril/ssh/${passSegment(`${user}@${host}`)}/password` : null
}

/**
 * Answer one askpass prompt. A saved secret is used once; asked again within a
 * minute (a wrong password makes ssh ask again) the person is asked instead.
 * Host keys are always confirmed by the person.
 */
async function answer(ctx: AskContext, prompt: string, kind: PromptKind): Promise<string | null> {
  if (kind === 'confirm') {
    const r = await askWindow({ title: 'Trust this host?', detail: prompt, kind: 'confirm', canSave: false })
    return r.value === null ? 'no' : 'yes'
  }
  const name = await entryFor(ctx, prompt, kind)
  if (name) {
    const last = triedAt.get(name)
    if (last === undefined || Date.now() - last > RETRY_WINDOW) {
      triedAt.set(name, Date.now())
      const saved = await passGetSecret(name).catch(() => null)
      if (saved) return saved
    }
  }
  const canSave = !!name && (await passStatus()).ready
  const title = kind === 'passphrase' ? 'Key passphrase' : kind === 'password' ? 'Password' : 'SSH asks'
  const r = await askWindow({ title, detail: prompt, kind: kind === 'other' ? 'text' : 'secret', canSave })
  if (r.value !== null && r.save && name) {
    // In the terminal there is no telling whether it worked: save as typed.
    if (ctx.terminal) void passSet(name, r.value).catch(() => {})
    else toSave.set(name, r.value)
  }
  return r.value
}

/** A login succeeded: keep what was typed for it, and let its saved secrets be used again. */
async function loginWorked(prefix: string): Promise<void> {
  for (const name of [...triedAt.keys()]) if (name.startsWith(prefix)) triedAt.delete(name)
  const list = await hosts()
  let changed = false
  for (const [name, value] of [...toSave]) {
    if (!name.startsWith(prefix)) continue
    toSave.delete(name)
    await passSet(name, value).catch(() => {})
    const host = list.find((h) => name.startsWith(`tendril/ssh/${h.name}/`))
    if (host) {
      if (name.endsWith('/password')) host.hasPassword = true
      if (name.endsWith('/passphrase')) host.hasPassphrase = true
      changed = true
    }
  }
  if (changed) await saveSettings({ sshHosts: list })
}

// ---- The connection ---------------------------------------------------------------------

function state(): RemoteState {
  const host = conn?.saved
  return {
    connected: !!conn,
    label: conn?.label ?? '',
    hostId: conn?.hostId ?? null,
    home: conn?.home ?? '',
    forwards: (host?.forwards ?? []).map((f) => ({ id: f.id, label: `${f.type} ${forwardLabel(f)}`, on: !!conn?.forwards.get(f.id)?.on, error: conn?.forwards.get(f.id)?.error })),
    error: lastError
  }
}
const pushState = (): void => send('remote:state', state())

function parseQuick(spec: string): { user: string; hostname: string; port: number } {
  const m = String(spec).trim().match(/^(?:([^@\s]+)@)?(\[[^\]]+\]|[^:\s]+)(?::(\d+))?$/)
  const user = m?.[1] ?? userInfo().username
  const hostname = (m?.[2] ?? '').replace(/^\[|\]$/g, '')
  const port = Number(m?.[3] ?? 22)
  if (!m || !HOSTNAME.test(hostname) || !USER.test(user) || port < 1 || port > 65535) throw new Error('Use user@host or user@host:port.')
  return { user, hostname, port }
}

async function open(target: { hostId: string } | { quick: string }): Promise<Connection> {
  const t = 'hostId' in target ? await hosts().then((l) => l.find((h) => h.id === target.hostId)) : null
  if ('hostId' in target && !t) throw new Error('That saved host no longer exists.')
  const c = new Connection(t ? { host: t } : { quick: parseQuick((target as { quick: string }).quick) }, (why) => {
    if (conn !== c) return
    conn = null
    lastError = `Connection to ${c.label} lost: ${why}`
    pushState()
  })
  await c.open()
  await loginWorked(t ? `tendril/ssh/${t.name}/` : `tendril/ssh/${passSegment(`${c.user}@${c.hostname}`)}/`)
  return c
}

async function connect(target: { hostId: string } | { quick: string }): Promise<RemoteState> {
  disconnect()
  lastError = undefined
  try {
    conn = await open(target)
  } catch (err) {
    lastError = (err as Error).message
    pushState()
    throw err
  }
  remoteDir = conn.home
  for (const f of conn.saved?.forwards ?? []) if (f.enabled) await conn.forward(f, true).catch(() => {})
  pushState()
  return state()
}

function disconnect(): void {
  const c = conn
  conn = null
  remoteDir = null
  c?.close()
  pushState()
}

/** The live connection for a transfer: the same host, reconnected (logins answered from pass) if it dropped. */
async function live(c: Connection): Promise<Connection | null> {
  if (conn === c && (await c.alive())) return c
  if (conn && conn !== c && conn.label === c.label) return conn
  if (conn && conn !== c) return null
  if (conn === c) c.close()
  try {
    conn = await open(c.hostId ? { hostId: c.hostId } : { quick: `${c.user}@${c.hostname}:${c.port}` })
    for (const f of conn.saved?.forwards ?? []) if (f.enabled) await conn.forward(f, true).catch(() => {})
    lastError = undefined
    pushState()
    return conn
  } catch {
    return null
  }
}

const transfers = new Transfers((list: Transfer[]) => send('xfer:list', list), live)

function need(): Connection {
  if (!conn) throw new Error('Not connected.')
  return conn
}

async function upload(paths: string[], dir: string): Promise<void> {
  const c = need()
  for (const p of paths) {
    if (typeof p !== 'string' || !isAbsolute(p)) continue
    await fs.access(p)
    transfers.add(c, 'up', p, dir)
  }
}

async function download(paths: string[], localDir: string | null): Promise<void> {
  const c = need()
  let dir = localDir
  if (!dir) {
    const r = await dialog.showOpenDialog(getWin()!, { title: 'Download to…', properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || !r.filePaths[0]) return
    dir = r.filePaths[0]
  }
  if (!isAbsolute(dir)) throw new Error('Pick a local folder.')
  for (const p of paths) if (typeof p === 'string' && p.startsWith('/')) transfers.add(c, 'down', p, dir)
}

async function pickUpload(dir: string, folders: boolean): Promise<void> {
  const r = await dialog.showOpenDialog(getWin()!, {
    title: `Upload to ${conn?.label}:${dir}`,
    properties: folders ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections']
  })
  if (!r.canceled) await upload(r.filePaths, dir)
}

/** Items for the local explorer's right-click menu while connected. */
export function remoteMenuItems(localPath: string): MenuItemConstructorOptions[] {
  if (!conn || !remoteDir) return []
  const dir = remoteDir
  return [{ type: 'separator' }, { label: `Upload to ${conn.label}:${dir}`, click: () => void upload([localPath], dir).catch(() => {}) }]
}

// ---- IPC ------------------------------------------------------------------------------------

export function registerRemote(handle: Handle, on: On, win: () => BrowserWindow | null): void {
  getWin = win
  setAskHandler(answer)
  on('ssh:promptReply', (_e, id: number, value: string | null, save: boolean) => {
    const resolve = prompts.get(id)
    prompts.delete(id)
    resolve?.({ value: typeof value === 'string' ? value : null, save: !!save })
  })

  handle('ssh:passStatus', () => passStatus())
  handle('ssh:setupStore', async (_e, passphrase: string) => {
    await setupStore(String(passphrase ?? ''))
    await syncSavedFlags()
  })
  handle('ssh:saveHost', (_e, input: SshHostInput, secrets: SshSecrets) => saveHost(input, secrets ?? {}))
  handle('ssh:deleteHost', (_e, id: string) => deleteHost(id))
  handle('ssh:pickKey', async () => {
    const r = await dialog.showOpenDialog(win()!, { title: 'Private key', properties: ['openFile', 'showHiddenFiles'] })
    return r.canceled ? null : r.filePaths[0] ?? null
  })
  handle('ssh:test', async (_e, id: string) => {
    const c = await open({ hostId: id })
    const msg = `Connected as ${c.user}@${c.hostname}; home folder ${c.home}.`
    c.close()
    return msg
  })
  handle('ssh:saveSudo', async (_e, password: string) => {
    if (typeof password !== 'string' || !password) throw new Error('Enter the password.')
    if (!(await passStatus()).ready) throw new Error('Tendril’s password store is not set up yet.')
    await passSet(sudoEntry(), password)
    await saveSettings({ sudoSaved: true })
  })
  handle('ssh:clearSudo', async () => {
    await passRemove(sudoEntry())
    await saveSettings({ sudoSaved: false })
  })

  handle('remote:connect', (_e, target: { hostId: string } | { quick: string }) => connect(target))
  on('remote:disconnect', () => disconnect())
  handle('remote:state', () => state())
  handle('remote:list', (_e, dir: string) => need().list(String(dir)))
  on('remote:select', (_e, dir: string) => {
    if (conn && typeof dir === 'string' && dir.startsWith('/')) remoteDir = dir
  })
  handle('remote:forward', async (_e, id: string, enable: boolean) => {
    const c = need()
    const f = c.saved?.forwards.find((x) => x.id === id)
    if (!f) throw new Error('No such forward.')
    try {
      await c.forward(f, !!enable)
    } finally {
      // The switch is remembered for the next connection too.
      const list = await hosts()
      const h = list.find((x) => x.id === c.hostId)
      const saved = h?.forwards.find((x) => x.id === id)
      if (saved) {
        saved.enabled = !!enable
        await saveSettings({ sshHosts: list })
      }
      pushState()
    }
  })
  handle('remote:shellCommand', () => need().shellCommand())
  handle('remote:upload', (_e, paths: string[], dir: string) => upload(Array.isArray(paths) ? paths : [], String(dir)))
  handle('remote:download', (_e, paths: string[], localDir: string | null) => download(Array.isArray(paths) ? paths : [], typeof localDir === 'string' ? localDir : null))
  on('remote:contextMenu', (e, path: string, isDir: boolean, localRoot: string | null) => {
    if (!conn || typeof path !== 'string') return
    const dir = isDir ? path : posix.dirname(path)
    const items: MenuItemConstructorOptions[] = [
      ...(localRoot ? [{ label: `Download to ${basename(localRoot) || localRoot}`, click: () => void download([path], localRoot).catch(() => {}) }] : []),
      { label: 'Download to…', click: () => void download([path], null).catch(() => {}) },
      { type: 'separator' },
      { label: 'Upload Files Here…', click: () => void pickUpload(dir, false).catch(() => {}) },
      { label: 'Upload Folders Here…', click: () => void pickUpload(dir, true).catch(() => {}) },
      { type: 'separator' },
      { label: 'Copy Path', click: () => clipboard.writeText(path) },
      { label: 'Refresh', click: () => e.sender.send('remote:refresh', dir) }
    ]
    Menu.buildFromTemplate(items).popup({ window: win()! })
  })

  handle('xfer:list', () => transfers.list())
  on('xfer:stop', (_e, id: number) => transfers.stop(Number(id)))
  on('xfer:resume', (_e, id: number) => transfers.resume(Number(id)))
  on('xfer:clear', () => transfers.clear())
}

/** Window gone or app quitting: stop transfers (partial files stay) and close the connection. */
export function closeRemote(): void {
  transfers.stopAll()
  for (const resolve of prompts.values()) resolve({ value: null, save: false })
  prompts.clear()
  disconnect()
  stopAskpass()
}

export const transfersActive = (): number => transfers.active
