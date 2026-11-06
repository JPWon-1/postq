// Render the title as text while preserving the original mascot artwork.
import sharp from 'sharp'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const background = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640">
  <defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#082c30"/><stop offset="1" stop-color="#10464a"/></linearGradient></defs>
  <rect width="1280" height="640" fill="url(#bg)"/>
  <text x="528" y="300" font-family="Helvetica,Arial,sans-serif" font-weight="700" font-size="76" fill="#fff5df">postq</text>
  <text x="534" y="365" font-family="Helvetica,Arial,sans-serif" font-size="30" fill="#b3d2d4">A lightweight, local-first API client</text>
</svg>`)
const icon = await sharp(resolve(root, 'branding/postq-icon-1024.png')).resize(400, 400).png().toBuffer()
await sharp(background).composite([{ input: icon, left: 70, top: 120 }]).png().toFile(resolve(root, 'branding/social-preview.png'))
