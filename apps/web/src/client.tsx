import './security-client.ts'
import { StrictMode, startTransition } from 'react'
import { hydrateRoot } from 'react-dom/client'

// 先配置 Zod，再加载含业务 schema 的路由图；静态 import 会先执行依赖中的 schema 初始化。
void import('@tanstack/react-start/client').then(({ StartClient }) => {
  startTransition(() => {
    hydrateRoot(
      document,
      <StrictMode>
        <StartClient />
      </StrictMode>,
    )
  })
})
