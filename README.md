# Badger for VS Code

Write Badger badge apps in VS Code, with the live emulator in an editor group on the right. Python stays in VS Code's native editor on the left, so your existing AI tools, Git, search, refactoring, undo, and extensions work with normal project files.

## Install

1. In VS Code, run **Extensions: Install from VSIX…**.
2. Select `badger-simulator-0.1.3.vsix` from this project.
3. Open your app folder, then run **Badger: Open Emulator** from the Command Palette. An app folder contains `__init__.py` and its assets.

Use **Badger: New App** or **Badger: Browse Apps and Examples** to start a project. Opening a bundled app or example creates a complete local copy in a folder you choose. Existing folders are never overwritten. App folders created outside the current workspace are added to Explorer.

## The IDE workflow

Run, Stop, Reset, Live, and Apps & examples sit in the compact top toolbar. Open folder, New app, Screen / Full, Rotate, and zoom are available in More controls (…).

- **Native editing:** click a project file in the panel to open it on the left. Live preview includes unsaved text changes. New, renamed, deleted, and externally edited files are picked up by the file watcher.
- **Emulator:** the website's MicroPython WebAssembly runtime, current firmware compatibility layer, and interactive 2026 3D badge are bundled locally. There is no website iframe, separate server, browser editor, Python installation, or network download needed to run the emulator.
- **Apps and examples:** search 36 apps and 36 categorized examples. Preview an item without replacing the current project, or open a local copy with its images, fonts, and other assets. **On BADGER** lists installed apps after connection.
- **Controls:** clickable physical buttons and capacitive pads, keyboard input, Screen and Full framing, zoom, drag to orbit, and Rotate. A flat display remains usable if WebGL or the model cannot load.
- **Motion:** accelerometer sliders in g, gyroscope sliders in degrees per second, upright/face-up/tilt presets, and Shake. Device motion is optional where the host provides it. Rotation updates the firmware's upside-down flag and motion axes.
- **Console:** Python output appears below the emulator and in VS Code's **Badger** output channel.
- **Files:** use the normal Explorer to add, rename, delete, copy, or save files. The panel also has New file and Show in Explorer actions. Keep the required `__init__.py` entry point.

**Run:** click Run or press `Ctrl+Alt+Enter` (`Cmd+Alt+Enter` on macOS). Stop terminates the worker and disables Live preview. Turn Live back on to restart automatically after edits.

**Reset** reboots the emulator into the bundled Mona OS home menu, matching the website’s badge simulator. It terminates the current app even if it is unresponsive and disables Live preview so edits do not immediately replace the home screen. Your app and unsaved files stay open in VS Code; click Run to return to them. Home / Escape also returns a standalone app to the home menu. In the home menu, you can launch the stock apps and use Home to return.

Click the badge or its controls before using its keyboard shortcuts. Keys in the native Python editor keep their normal editing behavior.

| Input | Keys |
| --- | --- |
| Physical A / B | Left / Right arrows |
| Physical Up / Down | Up / Down arrows |
| Physical C / Select | Enter |
| Home | Escape |
| Capacitive direction pad | W, A, S, D |
| Capacitive A / B / Back | J, K, U |

## Upload to a badge

1. Put the badge into USB disk mode and connect it by USB.
2. Click **Connect BADGER** and select the **BADGER drive itself**, containing `apps/`. On Windows, select the drive letter at its root; the extension checks that it contains `apps/`.
3. Click **Upload app**. Save any unsaved app files when prompted.
4. After read-back verification succeeds, eject BADGER through your operating system and restart the badge.

Uploads target `/apps/<app-name>/` on the mounted drive. The launcher and Startup are protected. A first upload to an existing app requires confirmation. Later uploads track a baseline, skip unchanged files, apply tracked deletions, and block conflicts with files changed independently on the badge. Failed writes attempt to restore prior files. Other apps and firmware files are preserved.

**Refresh** updates the installed app directory. **On BADGER** opens a local copy of an installed app rather than editing the mounted drive directly. Shared dependencies found by the website's importer are kept in `.badger-support/` for simulation and are not uploaded as app files. Disconnect releases the extension's reference to the drive; it does not eject it.

Physical USB hardware has not been tested in this project. The native upload commands and rollback paths are tested against temporary disk fixtures.

## Use the Badger badge skill with AI

Download and install the Badger badge skill, called `hyb26-skill` in the site's build guides, for badge-aware AI assistance. Then ask your AI assistant to use it when writing or checking an app.

The panel's **Get the skill** button opens the [Badger build guide](https://badger.github.io/build). The upstream site currently describes preinstalled skills without exposing a public download URL. Set **Badger: Skill Url** to the official download page when one is available. This extension does not install or execute a skill automatically.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `badger.livePreview` | `true` | Restart after source and asset changes |
| `badger.previewDelay` | `650` | Debounce time in milliseconds |
| `badger.skillUrl` | `https://badger.github.io/build` | Badge skill setup or download link |

A generated `.badger.json` records the app name and original source folder. Apps with hard-coded absolute asset paths must keep their original app name or have those paths updated before renaming. Projects are limited to 16 MB and 2048 files; Git metadata, virtual environments, dependency folders, and hidden files are excluded. Symbolic links are rejected.

The extension targets desktop VS Code 1.95 or newer and local app folders. A trusted workspace is required. Simulated HTTP uses browser requests and is subject to CORS, network availability, and host policies. Bluetooth, IR, USB reboot, and other hardware-specific APIs are shims, as in the upstream website. Simulation does not prove behavior or timing on physical hardware.

## Development

```sh
npm ci
npm run check
npm test
npm run build
npm run test:host
npm run package
```

Press F5 in this project to start an Extension Development Host. `npm run test:host` uses the installed macOS VS Code application with a temporary profile and mock BADGER folder. Set `VSCODE_EXECUTABLE` to another desktop VS Code executable when needed.

`node scripts/preview.mjs` serves a test-only panel at `http://127.0.0.1:4318` for visual and control checks. Its VS Code bridge is simulated; native integration is checked separately by the Extension Host tests.

## Source and notices

Ported from [`badger/badger.github.io` at `947ed46`](https://github.com/badger/badger.github.io/commit/947ed46bd0356bf119f0b10437453063a0008386), including merged [PR #42](https://github.com/badger/badger.github.io/pull/42) and [PR #43](https://github.com/badger/badger.github.io/pull/43). The bundled app catalog pins `badger/home` at `6cbc7e81dc7023ee66ad48f85ef33b635d87e360`.

See `THIRD_PARTY.md`, `media/simulator/THIRD_PARTY.md`, the bundled license files, and `media/simulator/COMPATIBILITY.md` for sources, licenses, and model limitations.
