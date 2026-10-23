import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

const root = process.cwd()
const temporary = await mkdtemp(path.join(os.tmpdir(), 'badger-vscode-host-'))
const workspace = path.join(temporary, 'workspace')
await mkdir(path.join(workspace, 'my-app'), { recursive: true })
await mkdir(path.join(root, '.test-results'), { recursive: true })
const source = `import badgeware
print("BADGER_HOST_BOOT")
badge.mode(HIRES | VSYNC)
last_motion = None

def update():
    global last_motion
    screen.pen = color.rgb(13, 17, 23)
    screen.clear()
    screen.pen = color.rgb(95, 237, 131)
    screen.rectangle(10, 10, 160, 80)
    if BUTTON_A in badge.pressed():
        print("BADGER_INPUT_A")
    motion = badge._imu.get_readings()
    if motion != last_motion:
        print("BADGER_MOTION", motion[0], motion[1], motion[2])
        last_motion = motion

run(update)
`
await writeFile(path.join(workspace, 'my-app', '__init__.py'), source)
const result = path.join(root, '.test-results', 'host.json')
const args = [
  '--user-data-dir', path.join(temporary, 'user'), '--extensions-dir', path.join(temporary, 'extensions'),
  '--extensionDevelopmentPath', process.env.BADGER_PACKAGE_ROOT || root, '--extensionTestsPath', path.join(root, 'tests', 'host-suite.cjs'),
  '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-updates', '--disable-telemetry',
  workspace,
]
const executable = process.env.VSCODE_EXECUTABLE || '/Applications/Visual Studio Code.app/Contents/MacOS/Code'
const child = spawn(executable, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, BADGER_TEST_WORKSPACE: workspace, BADGER_TEST_RESULT: result, BADGER_EXTENSION_ROOT: root }, stdio: 'inherit' })
const timeout = setTimeout(() => { child.kill('SIGTERM'); process.exitCode = 1 }, 150000)
const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
clearTimeout(timeout)
try {
  const report = await readFile(result, 'utf8')
  process.stdout.write(report + '\n')
  if (!JSON.parse(report).passed) process.exitCode = 1
} catch { process.stderr.write('The Extension Host did not produce a test report.\n'); process.exitCode = 1 }
process.exitCode = Number(code) || process.exitCode || 0
