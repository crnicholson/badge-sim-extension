import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import * as path from 'node:path'

const result = await build({ stdin: { contents: `export * from './src/panel'; export * from './src/badge-home'; export * from './src/projects'; export * from './src/vendor/badge-editor-project';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [{ name: 'preview-vscode', setup(build) { build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'mock' })); build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: 'export const Uri = {joinPath: (root, ...parts) => ({toString: () => root.toString() + "/" + parts.join("/")})}' })) } }] })
const modulePath = path.join(process.cwd(), '.test-results/preview.cjs')
await writeFile(modulePath, result.outputFiles[0].contents)
const core = createRequire(import.meta.url)(modulePath)
const items = await core.library(path.resolve('media'))
const source = `import badgeware
print("BADGER_CONTROL_TEST")
badge.mode(HIRES | VSYNC)
last_motion = None

def update():
    global last_motion
    screen.pen = color.rgb(13, 17, 23)
    screen.clear()
    screen.pen = color.rgb(95, 237, 131)
    screen.rectangle(10, 10, 160, 80)
    screen.pen = color.white
    screen.text("Badger in VS Code", 12, 120)
    if BUTTON_A in badge.pressed():
        print("BADGER_INPUT_A")
    if BUTTON_C in badge.pressed():
        print("BADGER_INPUT_C")
    motion = badge._imu.get_readings()
    if motion != last_motion:
        print("BADGER_MOTION", motion[0], motion[1], motion[2], motion[3], motion[4], motion[5])
        last_motion = motion

run(update)
`
const project = { name: 'my-app', sourceName: 'my-app', origin: 'new', activePath: '__init__.py', files: [core.projectFile('__init__.py', new TextEncoder().encode(source))] }
const state = { items, project: { type: 'project', name: project.name, root: '/preview/my-app', files: ['__init__.py'] }, request: core.simulationRequest(project) }
const events = []
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.png': 'image/png' }
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1:4318')
    if (url.pathname === '/event') {
      let content = ''
      for await (const chunk of req) content += chunk
      events.push(JSON.parse(content))
      await writeFile('.test-results/browser.json', JSON.stringify(events, null, 2))
      res.end('{}')
      return
    }
    if (url.pathname === '/state') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state)); return }
    if (url.pathname === '/home') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({type: 'run', request: await core.loadBadgeHome(path.resolve('media')), mode: 'home'})); return }
    if (url.pathname === '/preview') {
      const item = items.find(item => item.id === url.searchParams.get('id'))
      const project = await core.loadLibraryProject(path.resolve('media'), item)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ type: 'run', request: core.simulationRequest(project), preview: item.title }))
      return
    }
    if (url.pathname === '/bridge.js') {
      res.setHeader('Content-Type', 'text/javascript')
      res.end(`let state; const send = data => window.dispatchEvent(new MessageEvent('message', {data})); window.acquireVsCodeApi = () => ({getState: () => ({}), setState: () => {}, postMessage: async message => { await fetch('/event', {method: 'POST', body: JSON.stringify(message)}); if (message.type === 'ready') {state = await fetch('/state').then(r => r.json()); send({type:'catalog',items:state.items}); send(state.project); send({type:'device',connected:false,apps:[]}); send({type:'run',request:state.request});} if (message.type === 'reset') {send({type:'settings',live:false});send(await fetch('/home').then(r=>r.json()));} if (message.type === 'run') send({type:'run',request:state.request}); if (message.type === 'preview') send(await fetch('/preview?id='+encodeURIComponent(message.id)).then(r=>r.json())); }});`)
      return
    }
    if (url.pathname === '/') {
      let html = core.panelHtml({ cspSource: "'self'", asWebviewUri: uri => uri }, { toString: () => 'http://127.0.0.1:4318' })
      if (url.searchParams.has('flat')) html = html.replace('data-media="http://127.0.0.1:4318/media/"', 'data-media="http://127.0.0.1:4318/missing/"')
      const nonce = html.match(/nonce="([^"]+)"/)[1]
      html = html.replace(`<script nonce="${nonce}" type="module"`, `<script nonce="${nonce}" src="/bridge.js"></script><script nonce="${nonce}" type="module"`)
      res.setHeader('Content-Type', 'text/html')
      res.end(html)
      return
    }
    const file = path.resolve('.' + decodeURIComponent(url.pathname))
    if (!file.startsWith(process.cwd() + path.sep)) throw new Error('Invalid path')
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream')
    res.end(await readFile(file))
  } catch (error) { res.statusCode = 500; res.end(String(error)) }
})
server.listen(4318, '127.0.0.1', () => process.stdout.write('Preview: http://127.0.0.1:4318\n'))
