// Assembles the deployable web app into dist/: web/ files + the shared reader assets.
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const out = path.resolve(process.argv[2] || path.join(root, 'dist'))
const readerSrc = path.join(root, 'app/src/main/assets/reader')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
for (const f of fs.readdirSync(path.join(root, 'web'))) {
    if (f === 'build.mjs') continue
    fs.cpSync(path.join(root, 'web', f), path.join(out, f), { recursive: true })
}
fs.cpSync(readerSrc, path.join(out, 'reader'), { recursive: true })
// Precache everything except the large pdf.js cmaps/fonts (fetched on demand and cached then).
const files = []
const walk = (dir, rel = '') => {
    for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f), r = rel ? `${rel}/${f}` : f
        if (fs.statSync(p).isDirectory()) walk(p, r)
        else if (!r.startsWith('reader/pdfjs/cmaps/') && !r.startsWith('reader/pdfjs/standard_fonts/') && !r.endsWith('.md') && r !== 'sw.js' && !r.endsWith('LICENSE') && !r.startsWith('reader/foliate/tests'))
            files.push(r)
    }
}
walk(out)
let version = process.env.GITHUB_SHA?.slice(0, 8)
if (!version) try { version = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim() } catch { version = String(Date.now()) }
version += '-' + Date.now().toString(36)
const sw = fs.readFileSync(path.join(out, 'sw.js'), 'utf8').replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(files.map(f => './' + f)))
fs.writeFileSync(path.join(out, 'sw.js'), sw)
fs.writeFileSync(path.join(out, '.nojekyll'), '')
console.log(`built ${out}: ${files.length} precached files, version ${version}`)
