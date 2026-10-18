import {
  deepseekCall,
  deepseekToken,
  ensureAcceptanceModels,
  falImage,
  falVideo,
  workersImage,
} from './models.ts'
import { login, requireEnv, test } from './support.ts'

test('configure or verify text acceptance models through the admin UI', async ({ page }) => {
  requireEnv(['NEON_READONLY_URL'])
  await login(page, 'admin')
  await ensureAcceptanceModels(page, [deepseekToken, deepseekCall])
})

test('configure or verify media acceptance models through the admin UI', async ({ page }) => {
  requireEnv(['NEON_READONLY_URL'])
  await login(page, 'admin')
  await ensureAcceptanceModels(page, [workersImage, falImage, falVideo])
})
