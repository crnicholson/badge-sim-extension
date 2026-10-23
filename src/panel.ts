import * as vscode from 'vscode'
import { randomBytes } from 'node:crypto'

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)

export function panelHtml(webview: vscode.Webview, extension: vscode.Uri) {
  const resource = (...parts: string[]) => escape(webview.asWebviewUri(vscode.Uri.joinPath(extension, ...parts)).toString())
  const nonce = randomBytes(16).toString('hex')
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} blob: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src blob:; connect-src ${webview.cspSource} blob: https: http:; font-src ${webview.cspSource};">
<link rel="stylesheet" href="${resource('dist', 'panel.css')}"><title>Badger</title></head>
<body data-media="${resource('media')}/" data-worker="${resource('dist', 'worker.js')}" data-runtime="${resource('dist', 'runtime-assets.json')}">
<header class="top-controls">
<button id="run" class="primary" title="Run app (Ctrl/Cmd+Alt+Enter)"><span aria-hidden="true">▶</span> Run</button>
<button id="stop" class="icon-button" title="Stop emulator" aria-label="Stop emulator" disabled><svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1" fill="currentColor"/></svg></button>
<button id="reset" class="icon-button" title="Reset to badge home screen" aria-label="Reset to badge home screen"><svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5a5 5 0 1 1-1 5M3 1.5v3.5h3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
<label class="check"><input type="checkbox" id="live" checked> Live</label>
<span class="spacer"></span>
<button id="library-toggle" aria-expanded="false" aria-controls="library">Apps &amp; examples</button>
<details id="more-controls" class="more-controls"><summary aria-label="More controls" title="More controls"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><g fill="currentColor"><circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/></g></svg></summary><div class="controls-menu">
<div class="project-actions"><button data-command="openProject">Open folder</button><button data-command="new">New app</button></div>
<div class="view-actions"><div class="segment"><button id="focus-badge-screen" aria-pressed="true" disabled>Screen</button><button id="focus-badge-full" aria-pressed="false" disabled>Full</button></div><button id="rotate-badge" aria-pressed="false" title="Rotate the badge 180 degrees">Rotate</button><div class="zoom-controls"><button id="zoom-out" aria-label="Zoom out" disabled>−</button><button id="zoom-in" aria-label="Zoom in" disabled>+</button></div></div>
</div></details>
</header>
<main>
<div class="project-line"><button id="entry-file" title="Open the entry point in VS Code">Choose an app</button><span id="runtime-status" role="status">Ready</span></div>
<div id="message" role="status" hidden></div>
<section id="simulator-pane" tabindex="0" aria-label="Badge emulator and keyboard controls">
<div id="badge-model" data-state="loading"><canvas id="badge-screen" width="320" height="240" aria-label="Badge display"></canvas><p id="screen-placeholder">Open an app folder, create an app,<br>or choose an example to start.</p></div>
<p id="model-status" class="subtle">Loading 3D badge…</p>
<div class="physical-controls"><button data-button="16" title="A / Left arrow">A <span>←</span></button><button data-button="8" title="B / Right arrow">B <span>→</span></button><button data-button="4" title="C / Enter">C <span>↵</span></button><button data-button="2" title="Up arrow">↑</button><button data-button="1" title="Down arrow">↓</button><button data-button="32" title="Home / Escape">Home</button></div>
<details class="controls-details"><summary>Touch pads &amp; keyboard</summary><div class="touch-controls"><button data-button="256">← <small>A</small></button><button data-button="2048">↑ <small>W</small></button><button data-button="4096">↓ <small>S</small></button><button data-button="512">→ <small>D</small></button><button data-button="1024">A <small>J</small></button><button data-button="8192">B <small>K</small></button><button data-button="16384">Back <small>U</small></button><button data-button="32">Menu <small>Esc</small></button></div><p class="subtle">Click the badge to use arrow keys. Enter presses C / Select. Drag to orbit; scroll to zoom.</p></details>
<details id="motion-controls"><summary>Accelerometer &amp; gyroscope</summary><p class="subtle">Acceleration in g, rotation in degrees per second.</p><div class="motion-grid"><label>X <input id="ax" type="range" min="-2" max="2" step="0.01" value="0"><output for="ax">0.00</output></label><label>Y <input id="ay" type="range" min="-2" max="2" step="0.01" value="-1"><output for="ay">-1.00</output></label><label>Z <input id="az" type="range" min="-2" max="2" step="0.01" value="0"><output for="az">0.00</output></label><label>Gyro X <input id="gx" type="range" min="-1000" max="1000" step="1" value="0"><output for="gx">0</output></label><label>Gyro Y <input id="gy" type="range" min="-1000" max="1000" step="1" value="0"><output for="gy">0</output></label><label>Gyro Z <input id="gz" type="range" min="-1000" max="1000" step="1" value="0"><output for="gz">0</output></label></div><div class="motion-presets"><button data-motion="upright">Upright</button><button data-motion="flat">Face up</button><button data-motion="left">Tilt left</button><button data-motion="right">Tilt right</button><button data-motion="shake">Shake</button></div><label class="check"><input type="checkbox" id="device-motion">Use device motion if available</label></details>
</section>
<section class="device"><div class="section-line"><strong id="disk-status">No badge connected</strong><button id="connect" data-command="connect">Connect BADGER</button><button id="refresh-badge" data-command="refreshBadge" hidden title="Refresh installed badge apps">Refresh</button><button id="disconnect" data-command="disconnect" hidden>Disconnect</button></div><div class="section-line"><code id="upload-path">/apps/</code><button id="upload" data-command="upload" disabled>Upload app</button></div><p id="upload-status" class="subtle">Enter USB disk mode on your badge, then select its BADGER drive.</p></section>
<section id="library" hidden><div class="section-line"><strong>Apps &amp; examples</strong><button id="close-library" aria-label="Close library">×</button></div><input id="library-search" type="search" aria-label="Search apps and examples" placeholder="Search apps and examples"><div class="tabs" role="tablist" aria-label="Library"><button role="tab" data-tab="app" aria-selected="true">Apps</button><button role="tab" data-tab="example" aria-selected="false">Examples</button><button role="tab" data-tab="badge" aria-selected="false">On BADGER</button></div><div id="library-items"></div><p class="subtle">Opening a library app creates a local copy for editing in VS Code.</p></section>
<details id="files-section"><summary>Project files <span id="file-count"></span></summary><div id="files"></div><div class="file-actions"><button id="add-file">New file</button><button id="reveal-project">Show in Explorer</button></div></details>
<details id="console-section" open><summary>Console <button id="clear-console" aria-label="Clear console">Clear</button></summary><pre id="console-output" aria-live="off"></pre></details>
<footer><span>Building with AI? Download the Badger badge skill.</span><button data-command="skill">Get the skill</button></footer>
</main><script nonce="${nonce}" type="module" src="${resource('dist', 'webview.js')}"></script></body></html>`
}
