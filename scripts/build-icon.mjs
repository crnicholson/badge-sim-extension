import { Resvg } from '@resvg/resvg-js'
import { readFile, writeFile } from 'node:fs/promises'

const source = await readFile('media/icon.svg', 'utf8')
const rendered = new Resvg(source, { fitTo: { mode: 'width', value: 256 } }).render()
await writeFile('media/icon.png', rendered.asPng())
