import { build } from 'esbuild'
import './build-icon.mjs'
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises'

await mkdir('dist', { recursive: true })
await build({ entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', bundle: true, platform: 'node', target: 'node20', format: 'cjs', external: ['vscode'], sourcemap: true, legalComments: 'none' })
await build({ entryPoints: ['webview/main.ts'], outfile: 'dist/webview.js', bundle: true, platform: 'browser', target: 'chrome120', format: 'esm', minify: true, legalComments: 'none' })
let worker = await readFile('media/simulator/micropython.worker.js', 'utf8')
const dynamicImport = /import\(new URL\(`\.\/\$\{t\.async_backend\}\/micropython\.mjs`,import\.meta\.url\)\.href\)/
if (!dynamicImport.test(worker)) throw new Error('Upstream worker loader changed. Review the VS Code worker adapter.')
worker = 'import * as runtime from "./asyncify/micropython.mjs";\n' + worker.replace(dynamicImport, 'Promise.resolve(runtime)')
worker = worker.replace(/t\.async_backend=typeof WebAssembly\.Suspending[^,]+/, 't.async_backend="asyncify"')
worker = worker.replace('heapsize:7*1024*1024', 'url:self.BADGER_WASM_URL,heapsize:7*1024*1024')
worker = worker.replaceAll('import.meta.url', 'self.BADGER_RUNTIME_URL')
worker = worker.replace('new URL("./filesystem.json",self.BADGER_RUNTIME_URL).href', 'self.BADGER_MANIFEST_URL')
worker = worker.replace('new URL(`./filesystem${i}`,self.BADGER_RUNTIME_URL).href', 'self.BADGER_FILE_URLS[i]')
await build({ stdin: { contents: worker, resolveDir: process.cwd() + '/media/simulator', sourcefile: 'vscode-worker.js' }, outfile: 'dist/worker.js', bundle: true, platform: 'browser', target: 'chrome120', format: 'esm', minify: true, external: ['node:*', 'fs', 'path', 'url'], legalComments: 'none' })
await copyFile('webview/panel.css', 'dist/panel.css')
await writeFile('dist/build.json', JSON.stringify({ upstream: '947ed46bd0356bf119f0b10437453063a0008386', backend: 'asyncify', modelUpstream: '9199f0e17d3fd8cbd1549a3a203203d1aa9140e2' }, null, 2))

const manifest = JSON.parse(await readFile('media/simulator/filesystem.json', 'utf8'))
const files = Object.fromEntries(await Promise.all(Object.keys(manifest.files).map(async name => [name, (await readFile('media/simulator/filesystem' + name)).toString('base64')])))
await writeFile('dist/runtime-assets.json', JSON.stringify({ manifest, files, wasm: (await readFile('media/simulator/asyncify/micropython.wasm')).toString('base64') }))
