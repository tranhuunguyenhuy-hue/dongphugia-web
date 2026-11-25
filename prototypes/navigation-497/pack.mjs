import { readFile, writeFile } from 'node:fs/promises'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')
const assetFiles = {
  'Logo.png': 'Logo.png', 'interior.jpg': 'about-bathroom.jpg',
  'inax.png': 'brands/inax.png', 'toto.png': 'brands/toto.png',
  'elica.png': 'brands/elica.png', 'karofi.png': 'brands/karofi.png',
}
const assets = Object.fromEntries(await Promise.all(Object.entries(assetFiles).map(async ([key, file]) => {
  const bytes = await readFile(new URL('../../public/images/' + file, import.meta.url))
  return [key, 'data:image/png;base64,' + bytes.toString('base64')]
})))
const modules = Object.fromEntries(await Promise.all(['catalogue', 'presentation', 'icons'].map(async name => [
  name, 'data:text/javascript;base64,' + Buffer.from(await read(name + '.mjs')).toString('base64'),
])))
const app = (await read('app.mjs')).replace(/from '\.\/([a-z]+)\.mjs'/g, (_, name) => `from '${modules[name]}'`)
const state = JSON.stringify({ snapshot: JSON.parse(await read('snapshot.json')), assets }).replace(/</g, '\\u003c')
const css = await read("style.css")
const html = (await read('index.html'))
  .replace('<link rel="stylesheet" href="./style.css">', () => '<style>\n' + css + '\n</style>')
  .replace('<script type="module" src="./app.mjs"></script>', () => `<script>globalThis.navigationOffline = ${state}</script>\n<script type="module">\n${app}\n</script>`)
  .replace('src="/assets/Logo.png"', () => `src="${assets['Logo.png']}"`)
await writeFile(process.argv[2] || '/tmp/navigation-497.html', html)
