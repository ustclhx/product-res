import { seedCatalog } from '@product-res/billing'
import { createDb } from '@product-res/db'
import { readLocalEnv } from '@product-res/db/worktree-env'

/**
 * 价格目录夹具（harden-derived-project-checks D2）：开发服务器把公开价格目录缓存 1 小时，
 * 第一个访问 /pricing 的用例若早于目录写入，后续用例都读到空目录。这里在用例开始前写入项目自己的示例目录，
 * 结果与用例顺序无关；seedCatalog 按套餐 key upsert、价格按元组去重，重复运行幂等且保留后台授权的 models。
 */
export default async function catalogSetup() {
  const url = readLocalEnv('DATABASE_URL')
  // 与 fixtures.ts 的 fixtureDb 相同：只写隔离的 worktree 库，不落到共享开发库。
  if (!url || !new URL(url).pathname.startsWith('/product_res_wt_'))
    throw new Error('E2E catalog setup requires an isolated worktree DATABASE_URL')
  const db = createDb({ connectionString: url })
  try {
    await seedCatalog(db)
  } finally {
    await db.$client.end()
  }
}
