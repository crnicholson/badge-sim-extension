import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { projectFile, validateFilePath, type EditorCatalogApp } from './vendor/badge-editor-project'
import { badgeOsRequest, type BadgeOsApp, type BadgeOsCatalog } from './vendor/badge-os-simulator'

export async function loadBadgeHome(media: string) {
  const catalog: BadgeOsCatalog = JSON.parse(await fs.readFile(path.join(media, 'editor-apps/catalog.json'), 'utf8'))
  if (!catalog.launcher) throw new Error('The bundled app catalog has no home menu.')
  const stock = new Set(catalog.launcher.stock ?? catalog.apps.map(app => app.name))
  const loadApp = async (app: EditorCatalogApp): Promise<BadgeOsApp> => {
    validateFilePath(app.name)
    const files = await Promise.all(app.files.map(async relative => {
      validateFilePath(relative)
      const data = new Uint8Array(await fs.readFile(path.join(media, 'editor-apps', app.name, relative)))
      return projectFile(relative, data)
    }))
    return { name: app.name, files }
  }
  const [menu, ...apps] = await Promise.all([catalog.launcher, ...catalog.apps.filter(app => stock.has(app.name))].map(loadApp))
  return badgeOsRequest(menu, apps)
}
