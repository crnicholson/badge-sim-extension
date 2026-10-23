import { BadgeInput, initBadgeKeyboard } from '../src/vendor/badge-editor-input'
import { initBadgeModel } from '../src/vendor/badge-editor-model'
import { createBadgeModelController } from '../src/vendor/badge-editor-model-controller'
import { initBadgeMotion } from '../src/vendor/badge-motion'

interface VsCodeApi { postMessage(message: unknown): void; getState(): Record<string, unknown> | undefined; setState(state: unknown): void }
declare function acquireVsCodeApi(): VsCodeApi

type RuntimeRequest = { program: string; files: { name: string; content: number[] | Uint8Array | Record<string, number> }[] }
type Item = { id: string; name: string; title: string; category: string; description: string; kind: string }

const vscode = acquireVsCodeApi()
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const post = (message: unknown) => vscode.postMessage(message)
const screenCanvas = element<HTMLCanvasElement>('badge-screen')
const pane = element('simulator-pane')
const output = element('console-output')
const status = element('runtime-status')
const live = element<HTMLInputElement>('live')
const stopButton = element<HTMLButtonElement>('stop')
const persisted = vscode.getState() || {}
let worker: Worker | undefined
let workerUrl: string | undefined
let workerSource: Promise<[string, string]> | undefined
let bootTimer: ReturnType<typeof setTimeout> | undefined
let generation = 0
let mask = 0
let rotated = Boolean(persisted.rotated)
let connected = false
let busy = false
let hasProject = false
let frameCount = 0
let failed = false
let paused = false
let projectName = ''
let items: Item[] = []
let deviceApps: string[] = []
let tab = 'app'
let lastRequest: RuntimeRequest | undefined
let previewTitle = ''
let runtimeMode: 'app' | 'home' = 'app'
let latestDeviceMotion: number[] | undefined
let shakeTimer: ReturnType<typeof setInterval> | undefined
let shakeStopTimer: ReturnType<typeof setTimeout> | undefined
const motionFields = ['ax', 'ay', 'az', 'gx', 'gy', 'gz']
const motionAbort = new AbortController()

function report(extra: Record<string, unknown> = {}) { post({ type: 'runtime', status: { state: status.textContent, frames: frameCount, mode: runtimeMode, ...extra } }) }
function setStatus(text: string) { status.textContent = text; report() }
function saveState() { vscode.setState({ rotated, library: !element('library').hidden, tab }) }
function showMessage(message: string, error = false) {
  element('message').textContent = message
  element('message').classList.toggle('error', error)
  element('message').hidden = false
}
function log(text: string) {
  output.textContent = ((output.textContent || '') + text + '\n').slice(-18000)
  output.scrollTop = output.scrollHeight
  post({ type: 'log', text })
}

const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-button]')]
const modelView = createBadgeModelController(async (signal, fail) => {
  const view = initBadgeModel(element('badge-model'), screenCanvas, (bit, pressed) => inputs.set('model', bit, pressed), signal, fail, {
  screen: element<HTMLButtonElement>('focus-badge-screen'), full: element<HTMLButtonElement>('focus-badge-full'), status: element('model-status'),
  zoomIn: element<HTMLButtonElement>('zoom-in'), zoomOut: element<HTMLButtonElement>('zoom-out'),
  })
  void view.ready.then(() => report({ model: 'ready' }), () => {})
  return view
}, error => {
  element('badge-model').dataset.state = 'fallback'
  element('model-status').textContent = '3D view unavailable. The flat display and controls remain active.'
  element('model-status').hidden = false
  inputs.clear()
  report({ model: 'fallback', modelError: String(error) })
})
const inputs = new BadgeInput(value => {
  const homePressed = Boolean(value & 32) && !(mask & 32)
  mask = value
  worker?.postMessage({ buttons: mask | (rotated ? 32768 : 0) })
  buttons.forEach(button => button.dataset.pressed = String(Boolean(mask & Number(button.dataset.button))))
  modelView.setButtons(mask)
  report({ buttons: mask | (rotated ? 32768 : 0) })
  if (homePressed && runtimeMode !== 'home') resetToHome()
})
const disposeKeyboard = initBadgeKeyboard(pane, inputs)

for (const button of buttons) {
  const bit = Number(button.dataset.button)
  button.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    button.setPointerCapture(event.pointerId)
    inputs.set(`pointer:${bit}:${event.pointerId}`, bit, true)
  })
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, event => inputs.set(`pointer:${bit}:${(event as PointerEvent).pointerId}`, bit, false))
  button.addEventListener('keydown', event => {
    if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); inputs.set(`button:${bit}`, bit, true) }
  })
  button.addEventListener('keyup', event => {
    if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); inputs.set(`button:${bit}`, bit, false) }
  })
  button.addEventListener('blur', () => inputs.set(`button:${bit}`, bit, false))
}

const clamp = (value: number) => Math.min(32767, Math.max(-32768, Math.round(value)))
function rawMotion() {
  if (element<HTMLInputElement>('device-motion').checked && latestDeviceMotion) return latestDeviceMotion
  return motionFields.map((id, index) => clamp(Number(element<HTMLInputElement>(id).value) * (index < 3 ? 16384 : 14.29)))
}
function sendMotion() {
  const values = rawMotion().map((value, index) => rotated && index !== 2 && index !== 5 ? clamp(-value) : value)
  worker?.postMessage({ motion: values })
  report({ motion: values })
}
initBadgeMotion(pane, values => {
  latestDeviceMotion = values
  if (element<HTMLInputElement>('device-motion').checked) sendMotion()
}, motionAbort.signal)
for (const id of motionFields) {
  const field = element<HTMLInputElement>(id)
  field.addEventListener('input', () => {
    element<HTMLInputElement>('device-motion').checked = false
    document.querySelector(`output[for="${id}"]`)!.textContent = Number(field.value).toFixed(id.startsWith('a') ? 2 : 0)
    sendMotion()
  })
}
element('device-motion').addEventListener('change', sendMotion)
function setMotion(values: number[]) {
  motionFields.forEach((id, index) => {
    const input = element<HTMLInputElement>(id)
    input.value = String(values[index])
    document.querySelector(`output[for="${id}"]`)!.textContent = values[index].toFixed(index < 3 ? 2 : 0)
  })
  element<HTMLInputElement>('device-motion').checked = false
  sendMotion()
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-motion]')) button.addEventListener('click', () => {
  clearInterval(shakeTimer)
  clearTimeout(shakeStopTimer)
  if (button.dataset.motion === 'shake') {
    let tick = 0
    shakeTimer = setInterval(() => { setMotion([tick++ % 2 ? 1.8 : -1.8, -1, tick % 2 ? 0.8 : -0.8, 0, 0, 0]) }, 45)
    shakeStopTimer = setTimeout(() => { clearInterval(shakeTimer); setMotion([0, -1, 0, 0, 0, 0]) }, 600)
  } else setMotion(({ upright: [0, -1, 0, 0, 0, 0], flat: [0, 0, -1, 0, 0, 0], left: [-0.707, -0.707, 0, 0, 0, 0], right: [0.707, -0.707, 0, 0, 0, 0] } as Record<string, number[]>)[button.dataset.motion!])
})
function applyRotation() {
  element('rotate-badge').setAttribute('aria-pressed', String(rotated))
  modelView.setRotated(rotated)
  worker?.postMessage({ buttons: mask | (rotated ? 32768 : 0) })
  sendMotion()
  saveState()
}
element('rotate-badge').addEventListener('click', () => { rotated = !rotated; applyRotation() })

function stop(text = 'Stopped') {
  ++generation
  clearTimeout(bootTimer)
  worker?.terminate()
  worker = undefined
  if (workerUrl) URL.revokeObjectURL(workerUrl)
  workerUrl = undefined
  inputs.clear()
  stopButton.disabled = true
  setStatus(text)
}

async function run(request: RuntimeRequest) {
  stop('Loading MicroPython…')
  frameCount = 0
  failed = false
  output.textContent = ''
  lastRequest = request
  const current = generation
  stopButton.disabled = false
  try {
    const asset = async (url: string) => {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Could not load the runtime (${response.status}).`)
      return response.text()
    }
    workerSource ??= Promise.all([asset(document.body.dataset.worker!), asset(document.body.dataset.runtime!)]).catch(error => { workerSource = undefined; throw error })
    const [source, assets] = await workerSource
    if (current !== generation) return
    const base = new URL('simulator/micropython.worker.js', document.body.dataset.media!).href
    const bootstrap = `
self.BADGER_RUNTIME_URL = ${JSON.stringify(base)};
const assets = ${assets};
const bytes = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));
self.BADGER_WASM_URL = URL.createObjectURL(new Blob([bytes(assets.wasm)], {type:"application/wasm"}));
self.BADGER_MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(assets.manifest)], {type:"application/json"}));
self.BADGER_FILE_URLS = Object.fromEntries(Object.entries(assets.files).map(([name, data]) => [name, URL.createObjectURL(new Blob([bytes(data)]))]));
console.log = (...values) => self.postMessage({stdout: values.map(String).join(" ")});
console.error = console.log;
`
    workerUrl = URL.createObjectURL(new Blob([bootstrap, source], { type: 'text/javascript' }))
    const active = new Worker(workerUrl, { type: 'module', name: 'Badger MicroPython' })
    worker = active
    const fail = (reason: string) => { if (worker === active) { log(reason); stop('Runtime error'); report({ error: reason }) } }
    active.onerror = event => { event.preventDefault(); fail(event.message || 'The simulator worker could not start.') }
    active.onmessageerror = () => fail('Could not read a simulator response.')
    bootTimer = setTimeout(() => fail('MicroPython did not start. Press Run to retry.'), 30000)
    active.onmessage = ({ data }) => {
      if (worker !== active) return
      if (data.bootError) return fail(`Runtime could not start: ${data.bootError}`)
      if (data.stuck) return fail('The app stopped responding. Press Run to restart.')
      if (data.ready) {
        clearTimeout(bootTimer)
        active.postMessage({ buttons: mask | (rotated ? 32768 : 0) })
        sendMotion()
        const files = request.files.map(file => ({ ...file, content: file.content instanceof Uint8Array ? file.content : new Uint8Array(Array.isArray(file.content) ? file.content : Object.values(file.content)) }))
        active.postMessage({ program: request.program, files, debug: false })
      }
      if (data.running) { setStatus(runtimeMode === 'home' ? 'Badge home' : previewTitle ? `Preview: ${previewTitle}` : 'Running'); active.postMessage({ pause: paused || document.hidden }) }
      if (data.failed) { failed = true; setStatus('Python error') }
      if (data.completed) { setStatus(failed ? 'Python error' : 'Finished'); stopButton.disabled = true }
      if (data.stdout) {
        log(String(data.stdout))
        report({ stdout: String(data.stdout) })
        if (String(data.stdout).includes('- ERROR:')) { failed = true; setStatus('Python error') }
      }
      if (data.frame) {
        const { width, height, buffer } = data.frame
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2048 || height > 2048 || buffer.byteLength !== width * height * 4) return
        screenCanvas.width = width
        screenCanvas.height = height
        screenCanvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(buffer), width, height), 0, 0)
        modelView.updateFrame()
        element('screen-placeholder').hidden = true
        frameCount++
        if (frameCount === 1 || frameCount % 60 === 0) report({ width, height })
      }
      if (typeof data.backlight === 'number') {
        const level = Math.max(0, Math.min(1, data.backlight))
        screenCanvas.style.opacity = String(level)
        modelView.setBacklight(level)
      }
      if (data.caselights) report({ caselights: data.caselights })
    }
    screenCanvas.style.opacity = '1'
    modelView.setBacklight(1)
  } catch (error) {
    if (current !== generation) return
    log(String(error))
    stop('Runtime error')
  }
}

function openLibrary(open: boolean) {
  element('library').hidden = !open
  element('library-toggle').setAttribute('aria-expanded', String(open))
  if (open) { renderLibrary(); element('library-search').focus() }
  saveState()
}
const moreControls = element<HTMLDetailsElement>('more-controls')
document.addEventListener('click', event => { if (event.target instanceof Node && !moreControls.contains(event.target)) moreControls.open = false })
moreControls.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); moreControls.open = false; moreControls.querySelector('summary')?.focus() }
})
element('library-toggle').addEventListener('click', () => openLibrary(element('library').hidden))
element('close-library').addEventListener('click', () => openLibrary(false))
element('library-search').addEventListener('input', renderLibrary)
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) button.addEventListener('click', () => {
  tab = button.dataset.tab!
  document.querySelectorAll('[data-tab]').forEach(item => item.setAttribute('aria-selected', String((item as HTMLElement).dataset.tab === tab)))
  renderLibrary()
  saveState()
})
function renderLibrary() {
  const search = element<HTMLInputElement>('library-search').value.toLowerCase().trim()
  const available: Item[] = tab === 'badge' ? deviceApps.map(name => ({ id: `badge/${name}`, name, title: name, category: 'On BADGER', description: 'Open a local copy of this installed app', kind: 'badge' })) : items.filter(item => item.kind === tab)
  const filtered = available.filter(item => `${item.title} ${item.name} ${item.category} ${item.description}`.toLowerCase().includes(search))
  const target = element('library-items')
  target.replaceChildren()
  if (!filtered.length) {
    const empty = document.createElement('p')
    empty.className = 'subtle'
    empty.textContent = tab === 'badge' && !connected ? 'Connect your BADGER drive to browse installed apps.' : 'No matching apps or examples.'
    target.append(empty)
  }
  for (const item of filtered) {
    const row = document.createElement('div')
    row.className = 'library-item'
    const text = document.createElement('div')
    const title = document.createElement('strong')
    title.textContent = item.title
    const description = document.createElement('small')
    description.textContent = item.description || item.category
    text.append(title, description)
    const actions = document.createElement('div')
    actions.className = 'item-actions'
    if (item.kind !== 'badge') {
      const preview = document.createElement('button')
      preview.textContent = 'Preview'
      preview.disabled = busy
      preview.addEventListener('click', () => { post({ type: 'preview', id: item.id }); element('simulator-pane').scrollIntoView({ block: 'start', behavior: 'instant' }) })
      actions.append(preview)
    }
    const open = document.createElement('button')
    open.textContent = 'Open'
    open.disabled = busy
    open.addEventListener('click', () => post({ type: 'import', id: item.id }))
    actions.append(open)
    row.append(text, actions)
    target.append(row)
  }
}

function updateActions() {
  element<HTMLButtonElement>('upload').disabled = !connected || !hasProject || busy
  element<HTMLButtonElement>('connect').disabled = busy
  element<HTMLButtonElement>('disconnect').disabled = busy
  element<HTMLButtonElement>('refresh-badge').disabled = busy || !connected
  element<HTMLButtonElement>('add-file').disabled = !hasProject || busy
  document.querySelectorAll<HTMLButtonElement>('[data-command="new"], [data-command="openProject"]').forEach(button => button.disabled = busy)
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-command]')) button.addEventListener('click', () => { moreControls.open = false; post({ type: 'command', command: button.dataset.command }) })
function resetToHome() {
  stop('Restarting badge…')
  live.checked = false
  post({ type: 'reset' })
}
element('reset').addEventListener('click', resetToHome)
element('run').addEventListener('click', () => { if (hasProject) post({ type: 'run' }); else if (lastRequest) void run(lastRequest); else openLibrary(true) })
stopButton.addEventListener('click', () => { stop(); post({ type: 'stop' }); live.checked = false; post({ type: 'live', enabled: false }) })
live.addEventListener('change', () => post({ type: 'live', enabled: live.checked }))
element('clear-console').addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); output.textContent = '' })
element('entry-file').addEventListener('click', () => post({ type: 'file', path: '__init__.py' }))
element('add-file').addEventListener('click', () => post({ type: 'addFile' }))
element('reveal-project').addEventListener('click', () => post({ type: 'reveal' }))
window.addEventListener('message', event => {
  const message = event.data
  if (!message || typeof message !== 'object') return
  if (message.type === 'settings') live.checked = message.live
  if (message.type === 'catalog') { items = message.items; renderLibrary() }
  if (message.type === 'project') {
    hasProject = true
    projectName = message.name
    element('entry-file').textContent = projectName
    element('entry-file').title = `${message.root}/__init__.py`
    element('upload-path').textContent = `/apps/${projectName}/`
    element('file-count').textContent = `(${message.files.length})`
    element('files').replaceChildren(...message.files.map((file: string) => {
      const button = document.createElement('button')
      button.textContent = file
      button.addEventListener('click', () => post({ type: 'file', path: file }))
      return button
    }))
    updateActions()
  }
  if (message.type === 'run') { runtimeMode = message.mode === 'home' ? 'home' : 'app'; previewTitle = message.preview || ''; void run(message.request) }
  if (message.type === 'stop') stop(message.status || 'Stopped')
  if (message.type === 'library') openLibrary(true)
  if (message.type === 'message') showMessage(message.message, message.error)
  if (message.type === 'device') {
    connected = message.connected
    busy = message.busy
    deviceApps = message.apps
    element('disk-status').textContent = connected ? `BADGER · ${deviceApps.length} apps` : 'No badge connected'
    element('connect').hidden = connected
    element('disconnect').hidden = !connected
    element('refresh-badge').hidden = !connected
    updateActions()
    renderLibrary()
  }
  if (message.type === 'uploadStatus') {
    element('upload-status').textContent = message.message
    element('upload-status').classList.toggle('error', Boolean(message.error))
  }
  if (message.type === 'visibility') {
    paused = !message.visible
    inputs.clear()
    worker?.postMessage({ pause: paused || document.hidden })
  }
})
document.addEventListener('visibilitychange', () => { inputs.clear(); worker?.postMessage({ pause: document.hidden || paused }) })
window.addEventListener('pagehide', () => { stop(); modelView.dispose(); disposeKeyboard(); motionAbort.abort(); clearInterval(shakeTimer); clearTimeout(shakeStopTimer) })
applyRotation()
modelView.start()
openLibrary(Boolean(persisted.library))
updateActions()
post({ type: 'ready' })
