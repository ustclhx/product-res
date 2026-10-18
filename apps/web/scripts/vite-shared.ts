import contentCollections from '@content-collections/vite'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import templateConfig from '../../../template.config.ts'
import { APP_AREA_PREFIXES } from '../src/features/i18n/app-area.ts'
import { isPrerenderedPath, prerenderEntryPages } from '../src/features/marketing/prerender.ts'
import { activeLocales, i18nMessages } from './i18n-project.ts'

/** 两目标共用内容、文案与预渲染范围；平台插件留在各自配置中。 */
export function sitePlugins(serverEntry?: string) {
  const { i18n, marketing } = templateConfig
  const locales = activeLocales(i18n)
  return [
    tailwindcss(),
    i18nMessages({ i18n, appAreaPrefixes: APP_AREA_PREFIXES }),
    contentCollections(),
    tanstackStart({
      ...(serverEntry ? { server: { entry: serverEntry } } : {}),
      pages: marketing.enabled ? prerenderEntryPages(locales, i18n.defaultLocale) : [],
      prerender: {
        enabled: marketing.enabled,
        crawlLinks: true,
        autoStaticPathsDiscovery: false,
        autoSubfolderIndex: false,
        filter: (page) => isPrerenderedPath(page.path, locales),
      },
    }),
    viteReact(),
  ]
}
