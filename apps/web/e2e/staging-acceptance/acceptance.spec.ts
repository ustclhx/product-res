// 同一文件顺序执行模型设置与验收，管理员只需登录一次；失败后停止，避免重复付费操作。
import './models.spec.ts'
import './media.spec.ts'
import './chat.spec.ts'
import './admin.spec.ts'
import './sentry.spec.ts'
import { test } from '@playwright/test'

test.describe.configure({ mode: 'serial' })
