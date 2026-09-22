/**
 * electron-builder `afterAllArtifactBuild` hook.
 *
 * GNOME/KDE have no thumbnailer for AppImages, so a freshly built one shows a
 * generic gear icon in the file manager until the app is launched once (the app
 * writes its own thumbnails on startup, see integrateAppImage in src/main).
 * Do the same here right after the build so the artifact gets its icon
 * immediately. Best-effort and Linux-only; dependency-free so it works in a
 * plain Node process.
 */
const fs = require('fs/promises')
const { createHash } = require('crypto')
const { homedir } = require('os')
const { join } = require('path')
const { pathToFileURL } = require('url')
const zlib = require('zlib')

const SIZES = [['normal', 128], ['large', 256], ['x-large', 512], ['xx-large', 1024]]

exports.default = async function afterAllArtifactBuild(result) {
  if (process.platform !== 'linux') return []
  const images = (result.artifactPaths || []).filter((p) => p.endsWith('.AppImage'))
  if (images.length === 0) return []
  try {
    const icon = decodePng(await fs.readFile(join(__dirname, '..', 'icons', 'icon.png')))
    const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
    for (const image of images) {
      const uri = pathToFileURL(image).href
      const mtime = String(Math.floor((await fs.stat(image)).mtimeMs / 1000))
      const hash = createHash('md5').update(uri).digest('hex')
      for (const [dir, size] of SIZES) {
        const out = join(cache, 'thumbnails', dir)
        await fs.mkdir(out, { recursive: true })
        const png = encodePng(resize(icon, size), { 'Thumb::URI': uri, 'Thumb::MTime': mtime })
        await fs.writeFile(join(out, `${hash}.png`), png, { mode: 0o600 })
      }
      // Drop any earlier "failed thumbnail" marker so the file manager retries.
      await fs.rm(join(cache, 'thumbnails', 'fail', 'gnome-thumbnail-factory', `${hash}.png`), { force: true })
      console.log(`  • wrote file-manager thumbnails for ${image}`)
    }
  } catch (err) {
    console.warn(`  • skipped AppImage thumbnails: ${err.message}`)
  }
  return []
}

// ---- Minimal PNG codec (8-bit RGBA, non-interlaced) -------------------------

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** Returns { width, height, data } with data = unfiltered RGBA bytes. */
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('icons/icon.png is not a PNG')
  let width = 0, height = 0, channels = 0
  const idat = []
  for (let pos = 8; pos < buf.length; ) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const depth = data[8], color = data[9], interlace = data[12]
      channels = { 2: 3, 6: 4 }[color]
      if (depth !== 8 || !channels || interlace !== 0) throw new Error('icons/icon.png must be 8-bit RGB/RGBA, non-interlaced')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const data = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let add = 0
      if (filter === 1) add = a
      else if (filter === 2) add = b
      else if (filter === 3) add = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[i] = (line[i] + add) & 0xff
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4
      data[d] = line[s]; data[d + 1] = line[s + 1]; data[d + 2] = line[s + 2]
      data[d + 3] = channels === 4 ? line[s + 3] : 255
    }
    prev = line
  }
  return { width, height, data }
}

/** Box-filter resize to size×size (alpha-weighted so transparent edges stay clean). */
function resize(img, size) {
  if (img.width === size && img.height === size) return img
  const data = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor((y * img.height) / size), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / size))
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor((x * img.width) / size), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / size))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
        const s = (sy * img.width + sx) * 4, w = img.data[s + 3]
        r += img.data[s] * w; g += img.data[s + 1] * w; b += img.data[s + 2] * w; a += w; n++
      }
      const d = (y * size + x) * 4
      if (a > 0) { data[d] = r / a; data[d + 1] = g / a; data[d + 2] = b / a }
      data[d + 3] = a / n
    }
  }
  return { width: size, height: size, data }
}

function encodePng(img, text) {
  const stride = img.width * 4
  const raw = Buffer.alloc((stride + 1) * img.height)
  for (let y = 0; y < img.height; y++) img.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(img.width, 0)
  ihdr.writeUInt32BE(img.height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const texts = Object.entries(text).map(([k, v]) =>
    chunk('tEXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.of(0), Buffer.from(v, 'latin1')]))
  )
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), ...texts, chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
