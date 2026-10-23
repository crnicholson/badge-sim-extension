import * as vscode from 'vscode'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { panelHtml } from './panel'
import { loadBadgeHome } from './badge-home'
import { localDirectory } from './disk'
import { createProject, library, loadLibraryProject, readConfig, readFolder, starter, type LibraryItem } from './projects'
import { fileBytes, listBadgeApps, projectCheckpoint, projectFile, readBadgeProject, simulationRequest, type EditorProject, type ProjectFile } from './vendor/badge-editor-project'
import { ExistingAppError, uploadEditorProject, validateAppName, type DiskDirectory } from './vendor/badge-editor-upload'

type SavedBaseline = { root: string; sourceName: string; origin: EditorProject['origin']; files: { path: string; data: string }[]; diskPaths?: string[]; diskRoot?: string }

export async function activate(context: vscode.ExtensionContext) {
  const studio = new BadgerStudio(context)
  context.subscriptions.push(studio)
  const commands: Record<string, (argument?: vscode.Uri) => unknown> = {
    open: () => studio.open(), run: () => studio.run(), stop: () => studio.stop(), reset: () => studio.reset(),
    new: () => studio.newApp(), openProject: uri => studio.openFolder(uri),
    library: () => studio.browse(), connect: uri => studio.connect(uri), refreshBadge: () => studio.refreshBadge(), disconnect: () => studio.disconnect(),
    upload: () => studio.upload(), skill: () => studio.skill(),
  }
  for (const [name, action] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(`badger.${name}`, argument => studio.perform(() => action(argument))))
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('badger.emulator', { deserializeWebviewPanel: async panel => { await studio.restore(panel) } }))
  return { getStatus: () => studio.getStatus() }
}

class BadgerStudio implements vscode.Disposable {
  private panel?: vscode.WebviewPanel
  private ready = false
  private showLibrary = false
  private homeMode = false
  private homeRequest?: ReturnType<typeof loadBadgeHome>
  private root?: string
  private baseline?: EditorProject
  private disk?: DiskDirectory
  private diskRoot?: string
  private baselineDisk?: string
  private badgeApps: string[] = []
  private items: LibraryItem[] = []
  private timer?: ReturnType<typeof setTimeout>
  private revision = 0
  private busy = false
  private liveOverride?: boolean
  private disposables: vscode.Disposable[] = []
  private watcher?: vscode.FileSystemWatcher
  private runtime: Record<string, unknown> = {}
  private error?: string
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
  private readonly output = vscode.window.createOutputChannel('Badger')

  constructor(private readonly context: vscode.ExtensionContext) {
    this.status.text = '$(device-mobile) Badger'
    this.status.command = 'badger.open'
    this.status.tooltip = 'Open the Badger emulator'
    this.status.show()
    this.disposables.push(this.status, this.output,
      vscode.workspace.onDidChangeTextDocument(event => { if (this.contains(event.document.uri)) this.schedule() }),
      vscode.workspace.onDidSaveTextDocument(document => { if (this.contains(document.uri)) this.schedule() }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('badger')) { if (event.affectsConfiguration('badger.livePreview')) this.liveOverride = undefined; void this.sendSettings(); this.schedule() }
      }),
    )
  }

  getStatus() { return { root: this.root, busy: this.busy, ready: this.ready, runtime: this.runtime, diskRoot: this.diskRoot, error: this.error } }

  async perform(action: () => unknown) {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('Trust this workspace before running Badger apps.')
      return
    }
    try { this.error = undefined; return await action() } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.error = message
      this.output.appendLine(message)
      void this.send({ type: 'message', message, error: true })
      void vscode.window.showErrorMessage(`Badger: ${message}`)
    }
  }

  private contains(uri: vscode.Uri) {
    if (!this.root || uri.scheme !== 'file') return false
    const relative = path.relative(this.root, uri.fsPath)
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
  }

  private send(message: unknown) { return this.ready ? this.panel?.webview.postMessage(message) : undefined }

  private async sendSettings() {
    const config = vscode.workspace.getConfiguration('badger')
    await this.send({ type: 'settings', live: this.liveOverride ?? config.get('livePreview', true) })
  }

  private attach(panel: vscode.WebviewPanel) {
    this.panel = panel
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.png')
    this.ready = false
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.context.extensionUri, 'media')] }
    panel.webview.onDidReceiveMessage(message => void this.perform(() => this.receive(message)), undefined, this.disposables)
    panel.onDidDispose(() => { this.panel = undefined; this.ready = false; clearTimeout(this.timer); this.runtime = {} }, undefined, this.disposables)
    panel.onDidChangeViewState(event => { void this.send({ type: 'visibility', visible: event.webviewPanel.visible }) }, undefined, this.disposables)
    panel.webview.html = panelHtml(panel.webview, this.context.extensionUri)
  }

  async restore(panel: vscode.WebviewPanel) {
    this.attach(panel)
    await this.loadInitial()
  }

  async open() {
    if (!this.panel) {
      this.attach(vscode.window.createWebviewPanel('badger.emulator', 'Badger', { viewColumn: vscode.ViewColumn.Two, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true }))
      await this.loadInitial()
    } else this.panel.reveal(vscode.ViewColumn.Two, true)
  }

  private async loadInitial() {
    this.items = await library(path.join(this.context.extensionPath, 'media'))
    if (this.root) return
    const saved = this.context.workspaceState.get<SavedBaseline>('baseline')
    const active = vscode.window.activeTextEditor?.document.uri
    const candidates: string[] = []
    if (active?.scheme === 'file' && active.path.endsWith('.py')) {
      const folder = vscode.workspace.getWorkspaceFolder(active)?.uri.fsPath
      let directory = path.dirname(active.fsPath)
      for (let depth = 0; depth < 12; depth++) {
        if (await this.exists(path.join(directory, '__init__.py'))) { candidates.push(directory); break }
        if (directory === folder || path.dirname(directory) === directory) break
        directory = path.dirname(directory)
      }
    }
    if (saved?.root) candidates.push(saved.root)
    for (const folder of vscode.workspace.workspaceFolders || []) if (folder.uri.scheme === 'file') candidates.push(folder.uri.fsPath)
    for (const candidate of candidates) {
      if (!await this.exists(path.join(candidate, '__init__.py'))) continue
      await this.setRoot(candidate, false)
      break
    }
    if (this.ready) await this.initialize()
  }

  private async exists(file: string) { try { await fs.access(file); return true } catch { return false } }

  private async initialize() {
    if (!this.items.length) this.items = await library(path.join(this.context.extensionPath, 'media'))
    await this.sendSettings()
    await this.send({ type: 'catalog', items: this.items.map(({ files, example, ...item }) => item) })
    await this.sendDevice()
    if (this.homeMode) await this.reset()
    else if (this.root) await this.run()
    if (this.showLibrary) { await this.send({ type: 'library' }); this.showLibrary = false }
  }

  private async receive(message: unknown) {
    if (!message || typeof message !== 'object') return
    const value = message as Record<string, unknown>
    if (value.type === 'ready') { this.ready = true; await this.initialize(); return }
    if (value.type === 'runtime') {
      this.runtime = { ...this.runtime, ...(value.status && typeof value.status === 'object' ? value.status : {}) }
      return
    }
    if (value.type === 'log' && typeof value.text === 'string') { this.output.appendLine(value.text.slice(0, 18000)); this.runtime.log = ((this.runtime.log || '') + '\n' + value.text).slice(-18000); return }
    if (value.type === 'live' && typeof value.enabled === 'boolean') {
      this.liveOverride = value.enabled
      if (vscode.workspace.workspaceFolders?.length) await vscode.workspace.getConfiguration('badger').update('livePreview', value.enabled, vscode.ConfigurationTarget.Workspace)
      else this.liveOverride = value.enabled
      if (value.enabled) this.schedule()
      return
    }
    if (value.type === 'reset') { await this.reset(); return }
    if (this.busy) return
    if (value.type === 'command' && typeof value.command === 'string' && ['new', 'openProject', 'connect', 'refreshBadge', 'disconnect', 'upload', 'skill'].includes(value.command)) {
      await vscode.commands.executeCommand(`badger.${value.command}`)
      return
    }
    if (value.type === 'run') { await this.run(); return }
    if (value.type === 'stop') { this.stop(); return }
    if (value.type === 'import' && typeof value.id === 'string') { await this.importItem(value.id); return }
    if (value.type === 'preview' && typeof value.id === 'string') {
      const item = this.items.find(item => item.id === value.id)
      if (!item) return
      clearTimeout(this.timer)
      this.homeMode = false
      const revision = ++this.revision
      const project = await loadLibraryProject(path.join(this.context.extensionPath, 'media'), item)
      if (revision === this.revision) await this.send({ type: 'run', request: simulationRequest(project), preview: item.title, mode: 'app' })
      return
    }
    if (value.type === 'file' && typeof value.path === 'string') { await this.openFile(value.path); return }
    if (value.type === 'addFile') { await this.addFile(); return }
    if (value.type === 'reveal' && this.root) await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(this.root))
  }

  private schedule() {
    if (!this.root || this.busy || !this.ready) return
    clearTimeout(this.timer)
    const config = vscode.workspace.getConfiguration('badger')
    const delay = config.get<number>('previewDelay', 650)
    this.timer = setTimeout(() => void this.perform(() => (this.liveOverride ?? config.get('livePreview', true)) ? this.run() : this.updateProject()), delay)
  }

  private async snapshot(): Promise<EditorProject> {
    if (!this.root) throw new Error('Open an app folder, create an app, or choose an example first.')
    const config = await readConfig(this.root)
    const overlays = new Map(vscode.workspace.textDocuments.filter(document => !document.isClosed && this.contains(document.uri)).map(document => [document.uri.fsPath, document.getText()]))
    const files = await readFolder(this.root, overlays)
    const baseline = this.baseline
    const data = new Map(baseline?.files.map(file => [file.path, fileBytes(file)]))
    const supportRoot = path.join(this.root, '.badger-support')
    const supportFiles = await this.exists(supportRoot) ? await readFolder(supportRoot) : baseline?.supportFiles
    return {
      name: config.name, sourceName: baseline?.sourceName || config.sourceName,
      origin: baseline?.origin || 'new', activePath: '__init__.py',
      files: files.map(file => ({ ...file, data: data.get(file.path) ?? file.data })),
      checkpoint: baseline ? projectCheckpoint(baseline) : undefined,
      diskPaths: baseline?.diskPaths,
      removedFiles: baseline?.files.filter(file => !files.some(current => current.path === file.path)),
      supportFiles,
    }
  }

  private async updateProject(project?: EditorProject) {
    if (!this.root) return
    project ??= await this.snapshot()
    await this.send({ type: 'project', name: project.name, root: this.root, files: project.files.map(file => file.path) })
  }

  async run() {
    this.homeMode = false
    clearTimeout(this.timer)
    await this.open()
    if (!this.root || !this.ready) return
    const revision = ++this.revision
    const project = await this.snapshot()
    const request = simulationRequest(project)
    if (revision !== this.revision) return
    await this.updateProject(project)
    await this.send({ type: 'run', request, mode: 'app' })
  }

  async reset() {
    this.homeMode = true
    this.liveOverride = false
    clearTimeout(this.timer)
    const revision = ++this.revision
    await this.open()
    await this.sendSettings()
    if (!this.ready) return
    await this.send({ type: 'stop', status: 'Restarting badge…' })
    this.homeRequest ??= loadBadgeHome(path.join(this.context.extensionPath, 'media')).catch(error => { this.homeRequest = undefined; throw error })
    const request = await this.homeRequest
    if (revision !== this.revision) return
    await this.send({ type: 'run', request, mode: 'home' })
  }

  stop() {
    this.liveOverride = false
    void this.sendSettings()
    clearTimeout(this.timer)
    ++this.revision
    void this.send({ type: 'stop' })
  }

  private async setRoot(root: string, focus = true, initial?: EditorProject) {
    clearTimeout(this.timer)
    const config = await readConfig(root)
    const files = initial?.files || await readFolder(root)
    if (!files.some(file => file.path === '__init__.py' && file.text !== null)) throw new Error('Select an app folder containing a UTF-8 __init__.py entry point.')
    const saved = this.context.workspaceState.get<SavedBaseline>('baseline')
    this.baselineDisk = undefined
    if (!initial && saved?.root === root) {
      this.baseline = { name: config.name, sourceName: saved.sourceName, origin: saved.origin, activePath: '__init__.py', diskPaths: saved.diskPaths, files: saved.files.map(file => projectFile(file.path, new Uint8Array(Buffer.from(file.data, 'base64')))) }
      this.baselineDisk = saved.diskRoot
    } else this.baseline = initial || { name: config.name, sourceName: config.sourceName, files, origin: 'new', activePath: '__init__.py' }
    this.root = root
    this.watcher?.dispose()
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '**/*'))
    this.watcher.onDidCreate(() => this.schedule())
    this.watcher.onDidChange(() => this.schedule())
    this.watcher.onDidDelete(() => this.schedule())
    await this.saveBaseline()
    this.status.tooltip = `Badger: ${config.name}`
    await this.updateProject()
    if (focus) await this.openFile('__init__.py')
  }

  private async saveBaseline() {
    if (!this.root || !this.baseline) return
    await this.context.workspaceState.update('baseline', {
      root: this.root, sourceName: this.baseline.sourceName, origin: this.baseline.origin, diskPaths: this.baseline.diskPaths, diskRoot: this.baselineDisk,
      files: this.baseline.files.map(file => ({ path: file.path, data: Buffer.from(fileBytes(file)).toString('base64') })),
    } satisfies SavedBaseline)
  }

  async openFolder(uri?: vscode.Uri) {
    if (!uri) uri = (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Open Badger App' }))?.[0]
    if (!uri) return
    if (uri.scheme !== 'file') throw new Error('Open a local app folder for the desktop emulator.')
    await this.setRoot(uri.fsPath)
    await this.open()
    await this.run()
    if (!vscode.workspace.getWorkspaceFolder(uri)) vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length || 0, 0, { uri, name: path.basename(uri.fsPath) })
  }

  private async openFile(relative: string) {
    if (!this.root) return
    const project = await this.snapshot()
    if (!project.files.some(file => file.path === relative)) throw new Error('This file is no longer in the app.')
    const uri = vscode.Uri.file(path.join(this.root, relative))
    if (/\.(py|txt|json|csv|md|ini|toml|yaml|yml)$/i.test(relative)) {
      const document = await vscode.workspace.openTextDocument(uri)
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false })
    } else await vscode.commands.executeCommand('vscode.open', uri, { viewColumn: vscode.ViewColumn.One, preview: false })
  }

  private async parentFolder() {
    const folders = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file')
    const choice = folders.length ? await vscode.window.showQuickPick([...folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, uri: folder.uri })), { label: 'Choose another folder…', description: '', uri: undefined }], { placeHolder: 'Where should the local app copy be created?' }) : undefined
    if (folders.length && !choice) return
    if (choice?.uri) return choice.uri.fsPath
    return (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Create App Here' }))?.[0]?.fsPath
  }

  private async materialize(project: EditorProject) {
    if (this.busy) return
    this.busy = true
    clearTimeout(this.timer)
    await this.sendDevice()
    try {
      const parent = await this.parentFolder()
      if (!parent) return
      const name = await vscode.window.showInputBox({ prompt: 'App folder name', value: project.name.toLowerCase(), validateInput: value => { try { validateAppName(value); return null } catch (error) { return (error as Error).message } } })
      if (!name) return
      project.name = validateAppName(name)
      const root = await createProject(parent, project)
      if (project.supportFiles?.length) {
        const support = path.join(root, '.badger-support')
        for (const file of project.supportFiles) {
          const destination = path.join(support, file.path)
          await fs.mkdir(path.dirname(destination), { recursive: true })
          await fs.writeFile(destination, fileBytes(file))
        }
      }
      await this.setRoot(root, true, project)
      await this.open()
      await this.run()
      void this.send({ type: 'message', message: `Created ${root}. Edit its files in VS Code; Live preview includes unsaved changes.` })
      if (!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root))) vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length || 0, 0, { uri: vscode.Uri.file(root), name: project.name })
      return root
    } finally { this.busy = false; await this.sendDevice() }
  }

  async newApp() {
    await this.materialize({ name: 'my-app', sourceName: 'my-app', origin: 'new', activePath: '__init__.py', files: [projectFile('__init__.py', new TextEncoder().encode(starter))] })
  }

  async browse() {
    this.showLibrary = true
    await this.open()
    if (this.ready) { await this.send({ type: 'library' }); this.showLibrary = false }
  }

  private async importItem(id: string) {
    if (id.startsWith('badge/')) {
      if (!this.disk || !this.badgeApps.includes(id.slice(6))) throw new Error('Connect BADGER and refresh its app list.')
      const project = await readBadgeProject(this.disk, id.slice(6))
      if (!await this.materialize(project)) return
      this.baselineDisk = this.diskRoot
      await this.saveBaseline()
      return
    }
    const item = this.items.find(item => item.id === id)
    if (!item) throw new Error('This example is not in the bundled library.')
    await this.materialize(await loadLibraryProject(path.join(this.context.extensionPath, 'media'), item))
  }

  private async addFile() {
    if (!this.root) return
    const relative = await vscode.window.showInputBox({ prompt: 'New file path, relative to the app folder', placeHolder: 'helpers.py' })
    if (!relative) return
    const { validateFilePath } = await import('./vendor/badge-editor-project')
    validateFilePath(relative)
    const parts = relative.split('/')
    let directory = await localDirectory(this.root)
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true })
    for await (const entry of directory.values()) if (entry.name === parts.at(-1)) throw new Error('A file with that name already exists.')
    await directory.getFileHandle(parts.at(-1)!, { create: true })
    await this.updateProject()
    await this.openFile(relative)
  }

  async connect(uri?: vscode.Uri) {
    uri ??= (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Connect BADGER USB Disk', title: 'Select the BADGER drive itself' }))?.[0]
    if (!uri) return
    const windowsDrive = process.platform === 'win32' && /^[a-z]:[\\/]?$/i.test(uri.fsPath)
    if (uri.scheme !== 'file' || (!windowsDrive && path.basename(uri.fsPath).toUpperCase() !== 'BADGER')) throw new Error('Select the BADGER USB drive itself, containing the apps folder.')
    const disk = await localDirectory(uri.fsPath)
    const apps = await listBadgeApps(disk)
    this.disk = disk
    this.diskRoot = await fs.realpath(uri.fsPath)
    this.badgeApps = apps
    await this.sendDevice()
  }

  async refreshBadge() {
    if (!this.disk || this.busy) return
    this.badgeApps = await listBadgeApps(this.disk)
    await this.sendDevice()
  }

  disconnect() {
    if (this.busy) return
    this.disk = undefined
    this.diskRoot = undefined
    this.badgeApps = []
    void this.sendDevice()
    void this.send({ type: 'uploadStatus', message: 'Disconnected. Eject BADGER using your computer before unplugging it.' })
  }

  private async sendDevice() {
    await this.send({ type: 'device', connected: Boolean(this.disk), apps: this.badgeApps, busy: this.busy })
  }

  async upload() {
    if (this.busy) return
    if (!this.disk) { await this.connect(); if (!this.disk) return }
    let project = await this.snapshot()
    validateAppName(project.name)
    const changed = vscode.workspace.textDocuments.filter(document => document.isDirty && this.contains(document.uri))
    if (changed.length && await vscode.window.showWarningMessage(`Upload includes ${changed.length} unsaved ${changed.length === 1 ? 'file' : 'files'}. Save the app files before uploading?`, { modal: true }, 'Save and Upload') !== 'Save and Upload') return
    for (const document of changed) if (!await document.save()) throw new Error('Save the app files before uploading.')
    project = await this.snapshot()
    const expected = project.origin === 'badge' && project.name === project.sourceName && this.baselineDisk === this.diskRoot ? new Map(this.baseline?.files.map(file => [file.path, fileBytes(file)])) : undefined
    const options = { expected, replace: false, onProgress: (progress: { completed: number; total: number; path: string }) => void this.send({ type: 'uploadStatus', message: `${progress.completed}/${progress.total} files: ${progress.path}` }) }
    const disk = this.disk
    const uploadProject = expected ? project : { ...project, origin: 'new' as const, removedFiles: [] }
    this.busy = true
    clearTimeout(this.timer)
    await this.sendDevice()
    try {
      let result
      try { result = await uploadEditorProject(disk, uploadProject, options) } catch (error) {
        if (!(error instanceof ExistingAppError)) throw error
        const decision = await vscode.window.showWarningMessage(`Update /apps/${project.name}/ on BADGER? Matching files will be replaced. Other apps and the launcher are preserved.`, { modal: true }, 'Update App')
        if (decision !== 'Update App') return
        result = await uploadEditorProject(disk, uploadProject, { ...options, replace: true })
      }
      this.baseline = { ...project, sourceName: project.name, origin: 'badge', files: [...result.verified].map(([filePath, data]) => projectFile(filePath, data)), removedFiles: undefined, diskPaths: [...result.verified.keys()] }
      this.baselineDisk = this.diskRoot
      await this.saveBaseline()
      this.badgeApps = await listBadgeApps(disk)
      const message = `${result.written} files uploaded, ${result.deleted} deleted, verified in ${result.path}/. Eject BADGER, then restart the badge.`
      this.output.appendLine(message)
      await this.send({ type: 'uploadStatus', message })
    } finally {
      this.busy = false
      await this.sendDevice()
      await this.updateProject()
      this.schedule()
    }
  }

  async skill() {
    const raw = vscode.workspace.getConfiguration('badger').get<string>('skillUrl', 'https://badger.github.io/build')
    const url = vscode.Uri.parse(raw)
    if (url.scheme !== 'https') throw new Error('The skill link must use HTTPS.')
    await vscode.env.openExternal(url)
  }

  dispose() {
    clearTimeout(this.timer)
    this.watcher?.dispose()
    this.panel?.dispose()
    this.disposables.forEach(item => item.dispose())
  }
}
