import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { projectFile, validateFilePath, type EditorProject, type ProjectFile, type EditorCatalog, type SimulatorExamples } from './vendor/badge-editor-project'
import { validateAppName } from './vendor/badge-editor-upload'

export const excluded = new Set(['.git', '.badger.json', '.vscode', '.venv', 'venv', 'node_modules', '__pycache__', '.DS_Store'])
export const starter = `import badgeware
import math

badge.mode(HIRES | VSYNC)
screen.font = font.compass
phase = 0
paused = False

def update():
    global phase, paused
    if BUTTON_A in badge.pressed():
        paused = not paused
    if not paused:
        phase += 0.05
    screen.pen = color.rgb(13, 17, 23)
    screen.clear()
    screen.pen = color.rgb(240, 246, 252)
    screen.text("Hello, Badger", 14, 18)
    for x in range(21):
        for y in range(7):
            glow = 0.2 + (math.sin(x * 0.45 + phase) + math.cos(y * 0.7 - phase) + 2) * 0.2
            screen.pen = color.rgb(int(95 * glow), int(237 * glow), int(131 * glow))
            screen.rectangle(14 + x * 14, 62 + y * 14, 11, 11)
    screen.pen = color.rgb(139, 148, 158)
    screen.text("A: pause / play", 14, 200)

run(update)
`

export async function readFolder(root: string, overlays = new Map<string, string>()): Promise<ProjectFile[]> {
  const files: ProjectFile[] = []
  let total = 0
  const rootInfo = await fs.lstat(root)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Select an app folder without symbolic links.')
  async function visit(relative: string, depth: number) {
    if (depth > 12) throw new Error('App folders can be at most 12 levels deep.')
    for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      if (excluded.has(item.name) || item.name.startsWith('.')) continue
      const filePath = relative ? `${relative}/${item.name}` : item.name
      validateFilePath(filePath)
      if (item.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${filePath}`)
      if (item.isDirectory()) await visit(filePath, depth + 1)
      else if (item.isFile()) {
        const absolute = path.join(root, filePath)
        const size = (await fs.stat(absolute)).size
        if (size > 16 * 1024 * 1024) throw new Error('App files must fit within 16 MB.')
        const data = new Uint8Array(await fs.readFile(absolute))
        const file = projectFile(filePath, data)
        if (overlays.has(absolute) && file.text !== null) file.text = overlays.get(absolute)!
        total += file.text === null ? data.length : Buffer.byteLength(file.text)
        if (total > 16 * 1024 * 1024 || files.length >= 2048) throw new Error('Apps can contain up to 16 MB and 2048 files.')
        files.push(file)
      }
    }
  }
  await visit('', 0)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

export async function readConfig(root: string) {
  try {
    const configPath = path.join(root, '.badger.json')
    if ((await fs.lstat(configPath)).isSymbolicLink()) throw new Error('Project configuration cannot be a symbolic link.')
    const value = JSON.parse(await fs.readFile(configPath, 'utf8'))
    return { name: validateAppName(value.name), sourceName: String(value.sourceName || value.name) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const name = path.basename(root).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 48)
    return { name: validateAppName(name), sourceName: name }
  }
}

export type LibraryItem = { id: string; name: string; title: string; category: string; description: string; kind: 'app' | 'example'; files?: string[]; example?: SimulatorExamples['categories'][number]['examples'][number] }

export async function library(media: string): Promise<LibraryItem[]> {
  const apps: EditorCatalog = JSON.parse(await fs.readFile(path.join(media, 'editor-apps/catalog.json'), 'utf8'))
  const examples: SimulatorExamples = JSON.parse(await fs.readFile(path.join(media, 'editor-examples/catalog.json'), 'utf8'))
  return [
    ...apps.apps.filter(app => !['menu', 'startup'].includes(app.name)).map(app => ({ id: `app/${app.name}`, name: app.name, title: app.title, category: 'Apps', description: '', kind: 'app' as const, files: app.files })),
    ...examples.categories.flatMap(category => category.examples.map(example => ({ id: `example/${example.file}`, name: `example-${example.file.replace(/\.py$/, '').replaceAll('_', '-')}`, title: example.file.replace(/\.py$/, '').replaceAll('_', ' '), category: category.name, description: example.description, kind: 'example' as const, example }))),
  ]
}

export async function loadLibraryProject(media: string, item: LibraryItem): Promise<EditorProject> {
  validateFilePath(item.name)
  const name = validateAppName(item.name.toLowerCase())
  if (item.kind === 'app') {
    const root = path.join(media, 'editor-apps', item.name)
    const files = await Promise.all(item.files!.map(async file => projectFile(validateFilePath(file), new Uint8Array(await fs.readFile(path.join(root, file))))))
    if (name !== item.name) for (const file of files) {
      if (file.text !== null && file.path.endsWith('.py')) {
        for (const root of ['/system/apps/', '/remote/apps/', '/apps/']) file.text = file.text.replaceAll(root + item.name, root + name)
      }
    }
    return { name, sourceName: name, origin: 'example', activePath: '__init__.py', files }
  }
  const example = item.example!
  let source = await fs.readFile(path.join(media, 'editor-examples', validateFilePath(example.file)), 'utf8')
  if (/\brom_font\./.test(source)) source = `rom_font = font\n\n${source}`
  if (['text.py', 'vector_text.py'].includes(example.file)) {
    source = source.replace(/^  tokens = text\.tokenise\([^\n]+\)\n/m, '  for glyph_name, renderer in glyph_renderers.items():\n    add_glyph(glyph_name, renderer)\n')
    source = source.replace('text.draw(screen, tokens, bounds, line_spacing=1, word_spacing=1.05, size=size)', 'screen.text(message, bounds, font_size=size, line_height=1, word_spacing=1.05)')
    source = source.replace('text.draw(screen, tokens, bounds, line_spacing=1, word_spacing=1.05)', 'screen.text(message, bounds, line_height=1, word_spacing=1.05)')
  }
  const assets = await Promise.all(example.assets.map(async asset => {
    validateFilePath(asset)
    source = source.replaceAll(`/system/${asset}`, asset)
    return projectFile(asset, new Uint8Array(await fs.readFile(path.join(media, 'editor-examples', asset))))
  }))
  return { name: item.name, sourceName: item.name, origin: 'example', activePath: '__init__.py', files: [projectFile('__init__.py', new TextEncoder().encode(source)), ...assets] }
}

export async function createProject(parent: string, project: EditorProject) {
  validateAppName(project.name)
  const directory = path.join(parent, project.name)
  await fs.mkdir(directory)
  try {
    for (const file of project.files) {
      validateFilePath(file.path)
      const destination = path.join(directory, file.path)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.writeFile(destination, file.text ?? file.data, { flag: 'wx' })
    }
    await fs.writeFile(path.join(directory, '.badger.json'), JSON.stringify({ name: project.name, sourceName: project.sourceName }, null, 2) + '\n', { flag: 'wx' })
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true })
    throw error
  }
  return directory
}
