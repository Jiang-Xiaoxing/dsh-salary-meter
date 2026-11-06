// Shrink the Codex-drawn icon to what the plugin manifest allows (<= 256 KiB) and make the
// small-size previews used to check it still reads at 36 px.
import { createRequire } from 'node:module'
import { statSync } from 'node:fs'

// sharp lives in the DSH profile's node_modules, not in this plugin (plugins keep their
// dependency lists empty on purpose), so it is resolved from there on demand.
const require = createRequire('C:/Users/Lenovo/.ds-bot/profiles/ds-bot/package.json')
const sharp = require('sharp')

const src = 'assets/icon-draft.png'
const meta = await sharp(src).metadata()
console.log(`source: ${meta.width}x${meta.height} hasAlpha=${meta.hasAlpha} size=${statSync(src).size}`)

await sharp(src)
  .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png({ compressionLevel: 9, palette: true, quality: 95 })
  .toFile('icon.png')

const out = await sharp('icon.png').metadata()
console.log(`icon.png: ${out.width}x${out.height} hasAlpha=${out.hasAlpha} size=${statSync('icon.png').size} bytes`)

// What the Plugins page actually draws, on a light and on a dark strip.
for (const [name, bg] of [['light', { r: 246, g: 247, b: 250, alpha: 1 }], ['dark', { r: 32, g: 33, b: 38, alpha: 1 }]]) {
  await sharp('icon.png')
    .resize(36, 36, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({ top: 12, bottom: 12, left: 12, right: 12, background: bg })
    .png()
    .toFile(`E:/SalaryMeter/tmp/icon-36-${name}.png`)
}
console.log('previews written')
