import { passGetSecret, passRemove, passSet, passStatus } from './ssh/pass'
import { loadSettings, saveSettings, type Settings } from './settings'

/**
 * The OpenRouter key lives in Tendril's password store, like the SSH secrets.
 * A key saved by an earlier version (encrypted with the OS keychain in
 * settings.json) stays there only until the store is set up, then moves.
 */

export const OPENROUTER_ENTRY = 'tendril/ai/openrouter'

export async function saveOpenRouterKey(key: string): Promise<void> {
  key = String(key ?? '').trim()
  if (!key) throw new Error('Enter the key.')
  if (!(await passStatus()).ready) throw new Error('Tendril’s password store is not set up yet.')
  await passSet(OPENROUTER_ENTRY, key)
  await saveSettings({ openRouterKeyInPass: true, openRouterKey: '' })
}

export async function clearOpenRouterKey(): Promise<void> {
  await passRemove(OPENROUTER_ENTRY).catch(() => {})
  await saveSettings({ openRouterKeyInPass: false, openRouterKey: '' })
}

/** The key for a request: from pass (gpg asks for the passphrase if it has not got it), or the old keychain copy. */
export async function openRouterKey(s: Settings): Promise<string> {
  if (!s.openRouterKeyInPass) return s.openRouterKey.trim()
  const key = await passGetSecret(OPENROUTER_ENTRY)
  if (!key) throw new Error('Could not read the OpenRouter key from Tendril’s password store (was the passphrase given?).')
  return key.trim()
}

/** A keychain-saved key moves into the store once the store is there. */
export async function moveOpenRouterKeyToPass(): Promise<void> {
  const s = await loadSettings()
  if (!s.openRouterKey.trim() || !(await passStatus()).ready) return
  await passSet(OPENROUTER_ENTRY, s.openRouterKey.trim())
  await saveSettings({ openRouterKeyInPass: true, openRouterKey: '' })
}
