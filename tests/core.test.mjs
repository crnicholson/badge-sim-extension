import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'badger-core-'))
await build({ stdin: { contents: `export * from './src/projects'; export * from './src/badge-home'; export * from './src/disk'; export * from './src/vendor/badge-editor-project'; export * from './src/vendor/badge-editor-upload'; export * from './src/vendor/badge-editor-input'; export * from './src/vendor/badge-editor-model-controller';`, resolveDir: process.cwd() }, outfile: path.join(directory, 'core.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
const core = createRequire(import.meta.url)(path.join(directory, 'core.cjs'))
const media = path.resolve('media')

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'badger-disk-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'apps'))
  return { root, disk: await core.localDirectory(root) }
}
const file = (name, value) => core.projectFile(name, new TextEncoder().encode(value))
const app = files => ({ name: 'hello', sourceName: 'hello', origin: 'new', activePath: '__init__.py', files })

test('bundled apps and every example have a complete runnable project payload', async () => {
  const items = await core.library(media)
  assert.ok(items.filter(item => item.kind === 'app').length >= 23)
  assert.equal(items.filter(item => item.kind === 'example').length, 36)
  for (const item of items) {
    const project = await core.loadLibraryProject(media, item)
    assert.ok(project.files.some(file => file.path === '__init__.py' && file.text !== null), item.id)
    const request = core.simulationRequest(project)
    assert.ok(request.program.includes('exec(compile('), item.id)
    assert.equal(request.files.length, project.files.length, item.id)
  }
})

test('workspace copies preserve binary assets, take unsaved overlays, and never overwrite an existing folder', async t => {
  const { root } = await fixture(t)
  const project = app([file('__init__.py', 'print("saved")'), core.projectFile('assets/image.png', new Uint8Array([0, 255, 128]))])
  const destination = await core.createProject(root, project)
  const files = await core.readFolder(destination, new Map([[path.join(destination, '__init__.py'), 'print("unsaved")']]))
  assert.equal(files.find(item => item.path === '__init__.py').text, 'print("unsaved")')
  assert.deepEqual([...files.find(item => item.path === 'assets/image.png').data], [0, 255, 128])
  await assert.rejects(core.createProject(root, project), /EEXIST/)
  assert.equal(await fs.readFile(path.join(destination, '__init__.py'), 'utf8'), 'print("saved")')
})

test('native upload installs all assets, verifies bytes, and protects the launcher', async t => {
  const { root, disk } = await fixture(t)
  const project = app([file('__init__.py', 'print("hello")'), file('assets/info.txt', 'asset')])
  const result = await core.uploadEditorProject(disk, project)
  assert.equal(result.written, 2)
  assert.equal(result.verified.size, 2)
  assert.equal(await fs.readFile(path.join(root, 'apps/hello/assets/info.txt'), 'utf8'), 'asset')
  await assert.rejects(core.uploadEditorProject(disk, project), core.ExistingAppError)
  await assert.rejects(core.uploadEditorProject(disk, { ...project, name: 'menu' }), /protected/)
  await assert.rejects(core.uploadEditorProject(disk, { ...project, name: 'startup' }), /protected/)
})

test('incremental upload applies edits and deletion, skips unchanged files, and blocks external badge edits', async t => {
  const { root, disk } = await fixture(t)
  const initial = app([file('__init__.py', 'print(1)'), file('helper.py', 'x = 1'), file('old.txt', 'delete')])
  const installed = await core.uploadEditorProject(disk, initial)
  const project = { ...initial, origin: 'badge', diskPaths: initial.files.map(file => file.path), checkpoint: core.projectCheckpoint(initial), files: initial.files.map(file => ({ ...file })) }
  project.files[0].text = 'print(2)'
  core.removeProjectFile(project, 'old.txt')
  const result = await core.uploadEditorProject(disk, project, { expected: installed.verified })
  assert.equal(result.written, 1)
  assert.equal(result.deleted, 1)
  assert.equal(await fs.readFile(path.join(root, 'apps/hello/helper.py'), 'utf8'), 'x = 1')
  await assert.rejects(fs.access(path.join(root, 'apps/hello/old.txt')))
  const baseline = { ...project, files: [...result.verified].map(([name, data]) => core.projectFile(name, data)), removedFiles: [] }
  baseline.checkpoint = core.projectCheckpoint(baseline)
  baseline.files.find(item => item.path === '__init__.py').text = 'print(3)'
  await fs.writeFile(path.join(root, 'apps/hello/__init__.py'), 'external edit')
  await assert.rejects(core.uploadEditorProject(disk, baseline, { expected: result.verified }), /changed on the badge/)
  assert.equal(await fs.readFile(path.join(root, 'apps/hello/__init__.py'), 'utf8'), 'external edit')
})

test('failed native upload restores earlier writes', async t => {
  const { root, disk } = await fixture(t)
  const initial = app([file('__init__.py', 'before'), file('helper.py', 'before')])
  const installed = await core.uploadEditorProject(disk, initial)
  let failed = false
  function faulty(handle) {
    return { ...handle, async getDirectoryHandle(name, options) { return faulty(await handle.getDirectoryHandle(name, options)) }, async getFileHandle(name, options) {
      const fileHandle = await handle.getFileHandle(name, options)
      return { ...fileHandle, async createWritable() {
        const writer = await fileHandle.createWritable()
        if (name !== '__init__.py' || failed) return writer
        return { ...writer, async close() { failed = true; throw new Error('disk disconnected') } }
      } }
    } }
  }
  const project = { ...initial, origin: 'badge', checkpoint: core.projectCheckpoint(initial), files: initial.files.map(item => ({ ...item, text: 'after' })) }
  await assert.rejects(core.uploadEditorProject(faulty(disk), project, { expected: installed.verified }), /disk disconnected/)
  assert.equal(await fs.readFile(path.join(root, 'apps/hello/helper.py'), 'utf8'), 'before')
  assert.equal(await fs.readFile(path.join(root, 'apps/hello/__init__.py'), 'utf8'), 'before')
})

test('paths and symlinks cannot escape native disk or workspace project roots', async t => {
  const { root, disk } = await fixture(t)
  for (const name of ['..', '../outside', '/tmp', 'x/y', 'x\\y']) await assert.rejects(disk.getFileHandle(name, { create: true }))
  await fs.symlink(os.tmpdir(), path.join(root, 'escape'))
  await assert.rejects(disk.getDirectoryHandle('escape'), /Symbolic/)
  await assert.rejects(core.readFolder(root), /Symbolic/)
  assert.throws(() => core.validateFilePath('../escape.py'))
})

test('keyboard, pointer, and model inputs combine and clear independently', () => {
  let mask = 0
  const input = new core.BadgeInput(value => { mask = value })
  input.set('key:ArrowLeft', core.badgeKey('ArrowLeft'), true)
  input.set('model', 16, true)
  input.set('key:ArrowLeft', 16, false)
  assert.equal(mask, 16)
  input.set('pointer', core.badgeKey('Enter'), true)
  assert.equal(mask, 20)
  input.clear()
  assert.equal(mask, 0)
  assert.equal(core.badgeKey('Enter'), 4)
  assert.equal(core.badgeKey(' '), 0)
  assert.equal(core.badgeKey('W'), 2048)
  assert.equal(core.badgeKey('Escape'), 32)
})

test('firmware manifest byte lengths match bundled files', async () => {
  const { files } = JSON.parse(await fs.readFile('media/simulator/filesystem.json', 'utf8'))
  for (const [name, size] of Object.entries(files)) assert.equal((await fs.stat(path.join(media, 'simulator/filesystem', name))).size, size, name)
})

test('3D loading failure and timeout keep fallback available and dispose late models', async () => {
  let fallback = 0
  let disposed = 0
  let release
  const delayed = new Promise(resolve => { release = resolve })
  const controller = core.createBadgeModelController(() => delayed, () => { fallback++ }, 10)
  controller.start()
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(fallback, 1)
  release({ ready: Promise.resolve(), updateFrame() {}, setButtons() {}, setBacklight() {}, dispose() { disposed++ } })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(disposed, 1)
  controller.dispose()
  let rejects = 0
  const failure = core.createBadgeModelController(async () => { throw new Error('WebGL unavailable') }, () => { rejects++ })
  failure.start()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(rejects, 1)
  failure.dispose()
})

test('Reset boots the complete home launcher and stock apps without a workspace project', async () => {
  const request = await core.loadBadgeHome(media)
  const catalog = JSON.parse(await fs.readFile(path.join(media, 'editor-apps/catalog.json'), 'utf8'))
  const names = new Set(request.files.map(file => file.name))
  for (const name of ['menu', ...catalog.launcher.stock]) {
    assert.ok(names.has(`/system/apps/${name}/__init__.py`), name)
  }
  assert.ok(names.has('/system/apps/menu/mona_menu.p3d'))
  assert.ok(!names.has('/system/apps/Copilot/__init__.py'))
  assert.equal(names.size, request.files.length)
  assert.ok(request.program.includes('badge.poll = _poll'))
  assert.ok(request.program.includes('machine.reset = _reset'))
  assert.ok(request.program.includes('except _ReturnHome:'))
})
