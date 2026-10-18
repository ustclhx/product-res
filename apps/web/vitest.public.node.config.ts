import { defineConfig } from 'vitest/config'
import templateConfig from '../../template.config.ts'
import { i18nMessages } from './scripts/i18n-project.ts'
import { APP_AREA_PREFIXES } from './src/features/i18n/app-area.ts'

/** public 冒烟不读取生产凭据，也不要求数据库或缓存服务。 */
export default defineConfig({
  plugins: [i18nMessages({ i18n: templateConfig.i18n, appAreaPrefixes: APP_AREA_PREFIXES })],
  test: {
    environment: 'node',
    include: [
      'src/features/i18n/**/*.test.ts',
      'src/features/marketing/**/*.test.ts',
      'src/features/seo/**/*.test.{ts,tsx}',
      'test/public-node/*.node.ts',
    ],
  },
})
