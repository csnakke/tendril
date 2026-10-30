import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Tendril's own password store: the `pass` tool (https://www.passwordstore.org)
 * with a store and a GPG keyring of Tendril's, inside its data folder
 * (userData/pass and userData/gnupg). Your own ~/.password-store and ~/.gnupg
 * are never used or changed, and uninstalling removes both folders.
 *
 * The store is set up once, the first time something is saved (setupStore):
 * a GPG key for Tendril, protected by a passphrase you choose, and `pass init`
 * with it. Every later secret uses that key. gpg-agent asks for the
 * passphrase with its own dialog (pinentry) and remembers it for an hour.
 */

/** Entry names Tendril writes: `tendril/` and plain path segments, nothing a shell or `pass` could misread. */
const ENTRY = /^tendril(\/[A-Za-z0-9._@:+=-]+)+$/

export const storeDir = (): string => join(app.getPath('userData'), 'pass')
export const gnupgDir = (): string => join(app.getPath('userData'), 'gnupg')

/** Every pass and gpg Tendril runs uses its own store and keyring. */
const env = (): NodeJS.ProcessEnv => ({ ...process.env, PASSWORD_STORE_DIR: storeDir(), GNUPGHOME: gnupgDir() })

function run(cmd: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { env: env(), stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      return resolve({ code: -1, stdout: '', stderr: `${cmd} is not installed` })
    }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', () => resolve({ code: -1, stdout: '', stderr: `${cmd} is not installed` }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.stdin.end(input ?? '')
  })
}
const pass = (args: string[], input?: string): ReturnType<typeof run> => run('pass', args, input)

function check(name: string): void {
  if (!ENTRY.test(name) || name.split('/').some((s) => s === '.' || s === '..')) throw new Error(`Not a Tendril pass entry: ${name}`)
}

/** Segment-safe form of a user-supplied name (host, user@host, key file name). */
export const passSegment = (s: string): string => s.replace(/[^A-Za-z0-9._@:+=-]/g, '_').replace(/^\.+/, '_') || '_'

export interface PassStatus {
  installed: boolean
  /** Tendril's store is set up and its key is there: secrets can be saved. */
  ready: boolean
  /** Set up once, but the key it encrypts to is gone: it has to be set up again. */
  broken: boolean
}

export async function passStatus(): Promise<PassStatus> {
  const installed = (await pass(['version'])).code === 0 && (await run('gpg', ['--version'])).code === 0
  if (!installed) return { installed, ready: false, broken: false }
  const ids = (await fs.readFile(join(storeDir(), '.gpg-id'), 'utf8').catch(() => '')).split('\n').map((l) => l.trim()).filter(Boolean)
  if (!ids.length) return { installed, ready: false, broken: false }
  for (const id of ids) {
    if ((await run('gpg', ['--batch', '--list-secret-keys', id])).code !== 0) return { installed, ready: false, broken: true }
  }
  return { installed, ready: true, broken: false }
}

/** The windowed passphrase dialog: Tendril has no terminal for gpg to ask in. */
async function guiPinentry(): Promise<string | null> {
  const names = ['pinentry-mac', 'pinentry-gnome3', 'pinentry-qt', 'pinentry-qt5', 'pinentry-gtk-2', 'pinentry-gtk', 'pinentry-gnome']
  const dirs = [...(process.env['PATH'] ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
  for (const n of names) {
    for (const d of dirs) {
      const p = join(d, n)
      if (d && (await fs.access(p, fs.constants.X_OK).then(() => true, () => false))) return p
    }
  }
  return null
}

/**
 * Set up Tendril's store: its own keyring, a GPG key protected by
 * `passphrase`, `pass init` with that key, and a test entry written, read back
 * and removed. Anything left from a failed or broken setup is started over.
 */
export async function setupStore(passphrase: string): Promise<void> {
  if (passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.')
  const st = await passStatus()
  if (!st.installed) throw new Error('pass and gnupg are not installed. Run the Tendril installer again to install them.')
  if (st.ready) return

  // A fresh keyring and store; a half-made or broken one has nothing readable in it.
  await run('gpgconf', ['--kill', 'gpg-agent'])
  await fs.rm(gnupgDir(), { recursive: true, force: true })
  await fs.rm(storeDir(), { recursive: true, force: true })
  await fs.mkdir(gnupgDir(), { recursive: true, mode: 0o700 })
  await fs.chmod(gnupgDir(), 0o700)
  const pinentry = await guiPinentry()
  await fs.writeFile(
    join(gnupgDir(), 'gpg-agent.conf'),
    `${pinentry ? `pinentry-program ${pinentry}\n` : ''}# Ask for the passphrase at most once an hour, and again after 8 hours at the latest.\ndefault-cache-ttl 3600\nmax-cache-ttl 28800\n`,
    { mode: 0o600 }
  )

  const uid = `Tendril (${userInfo().username}@${hostname()}) <tendril@localhost>`
  // default/default: an ed25519 signing key with a cv25519 encryption subkey.
  const gen = await run('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase-fd', '0', '--quick-generate-key', uid, 'default', 'default', 'never'], passphrase + '\n')
  if (gen.code !== 0) throw new Error(`gpg could not create Tendril's key: ${gen.stderr.trim().split('\n').pop()}`)
  const list = await run('gpg', ['--batch', '--with-colons', '--list-secret-keys', uid])
  const fpr = list.stdout.split('\n').find((l) => l.startsWith('fpr:'))?.split(':')[9]
  if (!fpr) throw new Error('gpg created Tendril’s key but could not find it.')

  await fs.mkdir(storeDir(), { recursive: true, mode: 0o700 })
  const init = await pass(['init', fpr])
  if (init.code !== 0) throw new Error(`pass init failed: ${init.stderr.trim()}`)

  // Proof that encrypting and decrypting both work before anything real is saved.
  const probe = 'tendril/.selftest'
  await pass(['insert', '--multiline', '--force', probe], 'ok')
  const back = await run('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase-fd', '0', '--decrypt', join(storeDir(), `${probe}.gpg`)], passphrase + '\n')
  await pass(['rm', '--force', probe])
  if (back.stdout !== 'ok') throw new Error(`The new store could not be read back: ${back.stderr.trim().split('\n').pop()}`)

  await migrateOldEntries()
}

/** Secrets saved by earlier versions in ~/.password-store/tendril move into Tendril's own store, once. */
async function migrateOldEntries(): Promise<void> {
  const old = join(process.env['PASSWORD_STORE_DIR'] || join(homedir(), '.password-store'), 'tendril')
  if (!(await fs.stat(old).then((s) => s.isDirectory(), () => false))) return
  const files: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(dir, e.name))
      else if (e.name.endsWith('.gpg')) files.push(join(dir, e.name))
    }
  }
  await walk(old)
  for (const f of files) {
    const name = 'tendril/' + f.slice(old.length + 1, -4)
    // Decrypted with your own keyring (where they were made), saved with Tendril's.
    const plain = await new Promise<string | null>((resolve) => {
      const p = spawn('gpg', ['--batch', '--quiet', '--decrypt', f], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      p.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
      p.on('error', () => resolve(null))
      p.on('close', (code) => resolve(code === 0 ? out : null))
    })
    if (plain !== null && ENTRY.test(name)) await passSet(name, plain)
  }
}

/** Whether an entry is saved (without decrypting it, so no passphrase is asked). */
export async function passHas(name: string): Promise<boolean> {
  check(name)
  return fs.access(join(storeDir(), `${name}.gpg`)).then(() => true, () => false)
}

/** The whole entry, or null when it does not exist (or the GPG passphrase was not given). */
export async function passGet(name: string): Promise<string | null> {
  check(name)
  const r = await pass(['show', name])
  return r.code === 0 ? r.stdout : null
}

/** First line only: what `pass` calls the password, without the newline `pass insert` adds. */
export async function passGetSecret(name: string): Promise<string | null> {
  const v = await passGet(name)
  return v === null ? null : v.split('\n')[0]
}

export async function passSet(name: string, value: string): Promise<void> {
  check(name)
  const r = await pass(['insert', '--multiline', '--force', name], value)
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'pass could not save the entry')
}

export async function passRemove(name: string): Promise<void> {
  check(name)
  await pass(['rm', '--recursive', '--force', name])
}

export async function passMove(from: string, to: string): Promise<void> {
  check(from)
  check(to)
  const r = await pass(['mv', '--force', from, to])
  // Nothing saved under the old name yet is fine; anything else is not.
  if (r.code !== 0 && !/is not in the password store/.test(r.stderr)) throw new Error(r.stderr.trim() || 'pass could not rename the entry')
}
