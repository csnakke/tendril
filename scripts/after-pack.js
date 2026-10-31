/**
 * electron-builder `afterPack` hook.
 *
 * On macOS node-pty starts every shell through a small `spawn-helper` program
 * (prebuilds/darwin-<arch>/spawn-helper). Its npm package ships it without the
 * executable bit, and without it the terminal cannot start a shell
 * ("posix_spawnp failed"). Set the bit in the packed app, whatever machine
 * built it. Dependency-free so it runs in a plain Node process.
 */
const fs = require('fs/promises')
const { join } = require('path')

exports.default = async function afterPack(context) {
  const entries = await fs.readdir(context.appOutDir, { recursive: true }).catch(() => [])
  for (const rel of entries) {
    if (!rel.endsWith('spawn-helper')) continue
    const file = join(context.appOutDir, rel)
    await fs.chmod(file, 0o755)
    console.log(`  • made ${rel} executable`)
  }
}
