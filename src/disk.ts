import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { DiskDirectory, DiskFile } from './vendor/badge-editor-upload'

function diskError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT') throw new DOMException('File or folder not found.', 'NotFoundError')
  if (code === 'ENOTDIR' || code === 'EISDIR') throw new DOMException('File type does not match.', 'TypeMismatchError')
  throw error
}

function segment(name: string) {
  if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f<>:"|?*]/.test(name)) throw new Error('Invalid file or folder name.')
  return name
}

export async function localDirectory(directory: string): Promise<DiskDirectory> {
  const info = await fs.lstat(directory).catch(diskError)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Select a real folder, without symbolic links.')
  const root = await fs.realpath(directory)
  async function checked(target: string, allowMissing = false) {
    try {
      const info = await fs.lstat(target)
      if (info.isSymbolicLink()) throw new Error('Symbolic links are not supported in badge projects.')
      const real = await fs.realpath(target)
      const relative = path.relative(root, real)
      if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('File is outside the selected folder.')
      return info
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
      return diskError(error)
    }
  }
  function handle(current: string): DiskDirectory {
    return {
      name: path.basename(current),
      async *values() {
        await checked(current)
        for (const item of await fs.readdir(current, { withFileTypes: true })) {
          if (item.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${item.name}`)
          yield { name: item.name, kind: item.isDirectory() ? 'directory' as const : 'file' as const }
        }
      },
      async getDirectoryHandle(name, options) {
        await checked(current)
        const child = path.join(current, segment(name))
        let info = await checked(child, Boolean(options?.create))
        if (!info && options?.create) {
          await fs.mkdir(child).catch(diskError)
          info = await checked(child)
        }
        if (!info?.isDirectory()) throw new DOMException('Expected a folder.', 'TypeMismatchError')
        return handle(child)
      },
      async getFileHandle(name, options) {
        await checked(current)
        const child = path.join(current, segment(name))
        const info = await checked(child, Boolean(options?.create))
        if (!info && options?.create) await (await fs.open(child, 'wx').catch(diskError)).close()
        else if (!info?.isFile()) throw new DOMException('Expected a file.', 'TypeMismatchError')
        const file: DiskFile = {
          async getFile() {
            await checked(child)
            const data = new Uint8Array(await fs.readFile(child).catch(diskError))
            return new File([data], name)
          },
          async createWritable() {
            await checked(child)
            let data: string | Uint8Array = new Uint8Array()
            let done = false
            return {
              async write(value) { if (done) throw new Error('File is closed.'); data = value },
              async close() {
                if (done) return
                done = true
                await checked(current)
                await checked(child)
                const target = await fs.open(child, 'w').catch(diskError)
                try { await target.writeFile(data); await target.sync() } finally { await target.close() }
              },
              async abort() { done = true },
            }
          },
        }
        return file
      },
      async removeEntry(name, options) {
        await checked(current)
        const child = path.join(current, segment(name))
        const info = await checked(child)
        if (info?.isDirectory()) {
          if (options?.recursive) await fs.rm(child, { recursive: true }).catch(diskError)
          else await fs.rmdir(child).catch(diskError)
        } else await fs.unlink(child).catch(diskError)
      },
    }
  }
  return handle(root)
}
