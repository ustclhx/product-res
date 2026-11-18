// 在路由依赖解析 schema 前关闭浏览器 JIT；Zod 的 Function 探测也会触发 CSP 违规。
// 不 import zod：zod 把全局配置放在 globalThis.__zod_globalConfig（v4 core.js，先建后用、已存在则沿用），
// 直接写这个对象即可。import { config } 会让打包器把入口连到含整套 zod 的共享分包（约 35KB gzip），
// 首页因此静态依赖 zod（衍生项目 xuanxue 反馈）。security-client.test.ts 核对 zod 读到的是同一配置。
const scope = globalThis as { __zod_globalConfig?: { jitless?: boolean } }
scope.__zod_globalConfig = Object.assign(scope.__zod_globalConfig ?? {}, { jitless: true })
