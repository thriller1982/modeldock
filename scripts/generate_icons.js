import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

function createPng(width, height, pixelFn) {
  const rowSize = 1 + width * 4
  const rawData = Buffer.alloc(rowSize * height)

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize
    rawData[rowOffset] = 0 // Filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y, width, height)
      const pxOffset = rowOffset + 1 + x * 4
      rawData[pxOffset] = Math.max(0, Math.min(255, Math.round(r)))
      rawData[pxOffset + 1] = Math.max(0, Math.min(255, Math.round(g)))
      rawData[pxOffset + 2] = Math.max(0, Math.min(255, Math.round(b)))
      rawData[pxOffset + 3] = Math.max(0, Math.min(255, Math.round(a)))
    }
  }

  const compressed = zlib.deflateSync(rawData, { level: 9 })

  function crc32(buf) {
    let crc = -1
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
    }
    return (crc ^ -1) >>> 0
  }
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const typeBuf = Buffer.from(type, 'ascii')
    const crcBuf = Buffer.alloc(4)
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
    return Buffer.concat([len, typeBuf, data, crcBuf])
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  ihdrData[8] = 8 // 8-bit
  ihdrData[9] = 6 // RGBA
  ihdrData[10] = 0
  ihdrData[11] = 0
  ihdrData[12] = 0

  const ihdr = chunk('IHDR', ihdrData)
  const idat = chunk('IDAT', compressed)
  const iend = chunk('IEND', Buffer.alloc(0))

  return Buffer.concat([sig, ihdr, idat, iend])
}

function pngToIco(pngBuf, width, height) {
  const header = Buffer.from([0, 0, 1, 0, 1, 0])
  const entry = Buffer.alloc(16)
  entry[0] = width >= 256 ? 0 : width
  entry[1] = height >= 256 ? 0 : height
  entry[2] = 0 // Palette
  entry[3] = 0 // Reserved
  entry.writeUInt16LE(1, 4) // Planes
  entry.writeUInt16LE(32, 6) // BPP
  entry.writeUInt32LE(pngBuf.length, 8) // Size
  entry.writeUInt32LE(22, 12) // Offset: header (6) + entry (16) = 22
  return Buffer.concat([header, entry, pngBuf])
}

// Distance to rounded rectangle (squircle)
function sdRoundedBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r
  const qy = Math.abs(py) - by + r
  const inside = Math.min(Math.max(qx, qy), 0)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  return inside + outside - r
}

// Pixel function for ModelDock logo
function renderModelDockPixel(x, y, w, h) {
  // Normalize coordinates: center is (0, 0), radius is roughly 1.0
  const nx = (x + 0.5 - w / 2) / (w / 2)
  const ny = (y + 0.5 - h / 2) / (h / 2)

  // Rounded squircle container
  const distBox = sdRoundedBox(nx, ny, 0.88, 0.88, 0.32)
  const edgeWidth = 2.0 / w

  if (distBox > edgeWidth) {
    return [0, 0, 0, 0] // Fully transparent outside
  }

  // Alpha of base squircle with anti-aliasing
  let alpha = 1.0
  if (distBox > -edgeWidth) {
    alpha = Math.max(0, Math.min(1, (-distBox + edgeWidth) / (2 * edgeWidth)))
  }

  // Background gradient: from deep navy #0b1120 (top) to midnight indigo #1e1b4b (bottom)
  const tY = (ny + 1) / 2 // 0 at top, 1 at bottom
  let bgR = 11 + tY * (28 - 11)
  let bgG = 17 + tY * (25 - 17)
  let bgB = 32 + tY * (72 - 32)

  // Glowing border effect: cyan -> emerald gradient border
  const borderDist = Math.abs(distBox + 0.04)
  if (borderDist < 0.05) {
    const borderIntensity = 1.0 - borderDist / 0.05
    // Top-left is cyan (14, 165, 233), bottom-right is emerald (16, 185, 129)
    const tBorder = (nx + ny + 2) / 4
    const bColorR = 14 + tBorder * (16 - 14)
    const bColorG = 165 + tBorder * (185 - 165)
    const bColorB = 233 + tBorder * (129 - 233)

    bgR = bgR * (1 - borderIntensity * 0.8) + bColorR * (borderIntensity * 0.8)
    bgG = bgG * (1 - borderIntensity * 0.8) + bColorG * (borderIntensity * 0.8)
    bgB = bgB * (1 - borderIntensity * 0.8) + bColorB * (borderIntensity * 0.8)
  }

  // Foreground: Geometric "M" Dock Station
  // Left pillar: nx in [-0.55, -0.32], ny in [-0.45, 0.45]
  // Right pillar: nx in [0.32, 0.55], ny in [-0.45, 0.45]
  // Central V: from (-0.35, -0.40) to (0, 0.08) and (0.35, -0.40) to (0, 0.08)
  // Dock base bar: nx in [-0.55, 0.55], ny in [0.35, 0.50]
  // Cyan glowing LED nodes on bottom base: (-0.35, 0.42) and (0.35, 0.42)

  let fgIntensity = 0
  let fgR = 255, fgG = 255, fgB = 255

  // Left & right pillars
  const leftPillar = Math.abs(nx - (-0.42)) < 0.11 && Math.abs(ny - (-0.02)) < 0.42
  const rightPillar = Math.abs(nx - 0.42) < 0.11 && Math.abs(ny - (-0.02)) < 0.42

  // Center chevron / V
  // Left slope line: nx + ny / 1.4
  const vLine1 = Math.abs((nx - (-0.18)) * 1.3 + (ny - (-0.15))) < 0.14 && ny > -0.42 && ny < 0.15 && nx < 0.08
  const vLine2 = Math.abs((-(nx - 0.18)) * 1.3 + (ny - (-0.15))) < 0.14 && ny > -0.42 && ny < 0.15 && nx > -0.08

  // Base dock platform
  const baseDock = Math.abs(nx) < 0.55 && Math.abs(ny - 0.42) < 0.08

  if (leftPillar || rightPillar || vLine1 || vLine2) {
    fgIntensity = 0.95
    // Gradient: cyan top -> teal/emerald
    const tM = (ny + 0.45) / 0.9
    fgR = 56 + tM * (20 - 56)
    fgG = 189 + tM * (230 - 189)
    fgB = 248 + tM * (180 - 248)
  }

  if (baseDock) {
    fgIntensity = 0.9
    fgR = 30; fgG = 41; fgB = 59 // slate-800 dock
  }

  // Cyan and Emerald connection LEDs on dock
  const led1Dist = Math.hypot(nx - (-0.32), ny - 0.42)
  if (led1Dist < 0.08) {
    fgIntensity = 1.0
    fgR = 56; fgG = 189; fgB = 248 // Vivid cyan
  }

  const led2Dist = Math.hypot(nx - 0.32, ny - 0.42)
  if (led2Dist < 0.08) {
    fgIntensity = 1.0
    fgR = 52; fgG = 211; fgB = 153 // Vivid emerald
  }

  // Central glowing core pulse at (0, -0.08)
  const coreDist = Math.hypot(nx, ny - (-0.08))
  if (coreDist < 0.12) {
    fgIntensity = 1.0
    fgR = 255; fgG = 255; fgB = 255 // White core
  } else if (coreDist < 0.22) {
    const pulse = (0.22 - coreDist) / 0.10
    fgIntensity = Math.max(fgIntensity, pulse * 0.7)
    fgR = 125; fgG = 211; fgB = 252 // Light sky blue
  }

  // Blend background and foreground
  const finalR = bgR * (1 - fgIntensity) + fgR * fgIntensity
  const finalG = bgG * (1 - fgIntensity) + fgG * fgIntensity
  const finalB = bgB * (1 - fgIntensity) + fgB * fgIntensity

  return [finalR, finalG, finalB, alpha * 255]
}

const resourcesDir = path.resolve('resources')
if (!fs.existsSync(resourcesDir)) {
  fs.mkdirSync(resourcesDir, { recursive: true })
}

console.log('Generating 256x256 icon.png...')
const icon256 = createPng(256, 256, renderModelDockPixel)
fs.writeFileSync(path.join(resourcesDir, 'icon.png'), icon256)

console.log('Generating 32x32 tray.png...')
const tray32 = createPng(32, 32, renderModelDockPixel)
fs.writeFileSync(path.join(resourcesDir, 'tray.png'), tray32)

console.log('Generating icon.ico...')
const icoBuf = pngToIco(icon256, 256, 256)
fs.writeFileSync(path.join(resourcesDir, 'icon.ico'), icoBuf)

console.log('Generating Base64 Data URLs...')
const trayBase64 = `data:image/png;base64,${tray32.toString('base64')}`
const iconBase64 = `data:image/png;base64,${icon256.toString('base64')}`

fs.writeFileSync(
  path.join(resourcesDir, 'icons-data.ts'),
  `// Auto-generated embedded icons for ModelDock\n` +
  `export const TRAY_ICON_DATA_URL = ${JSON.stringify(trayBase64)};\n` +
  `export const APP_ICON_DATA_URL = ${JSON.stringify(iconBase64)};\n`
)

console.log('✅ Icons generated successfully!')
