# Source provenance

The editor project, upload, input, motion, model controller, firmware compatibility, home launcher, and 3D viewer modules in `src/vendor/` are adapted from `badger/badger.github.io` commit `947ed46bd0356bf119f0b10437453063a0008386`, licensed under the repository's MIT license retained in `LICENSE`.

The MicroPython runtime, simulator filesystem, examples, and app collection are vendored from that same website snapshot. Keep every upstream license and asset notice when updating them. Their original notices remain in `media/simulator/THIRD_PARTY.md`, `media/simulator/LICENSE`, `media/simulator/licenses/`, and the app/example folders. Three.js is bundled into the panel under its MIT license in `media/simulator/licenses/three.txt`.

The 3D model is updated from [website PR #44](https://github.com/badger/badger.github.io/pull/44), commit `9199f0e17d3fd8cbd1549a3a203203d1aa9140e2`. It removes the protruding side port and preserves the five front buttons. Its output checksum and original attribution are retained in `media/simulator/THIRD_PARTY.md`.

The extension icon in `media/icon.svg` depicts the badge and incorporates the existing GitHub mark from the panel. GitHub and Badger branding and model artwork retain their owners' rights. The upstream model notice does not assert a license for the model or GitHub artwork; this extension makes no additional license claim for those assets.

# Extension adaptations

The VS Code extension uses native document and filesystem APIs instead of CodeMirror, IndexedDB drafts, and browser directory pickers. The worker is bundled into one module. Its asyncify WebAssembly binary and firmware files are preloaded through the webview before worker creation and exposed to the worker through local blob URLs. The runtime and firmware behavior otherwise follow the pinned website source.

`dist/runtime-assets.json` contains the unmodified asyncify WebAssembly bytes and firmware file bytes encoded as base64, plus the original firmware manifest. It is generated from `media/simulator/` by `scripts/build.mjs`. The build fails if the expected upstream worker loader no longer matches. Updating the source requires reviewing the adapter, byte manifest, license notices, app catalog, and firmware compatibility layer together.

The new host integration, desktop motion controls, workspace project management, and VS Code panel are part of this extension's MIT-licensed source.
