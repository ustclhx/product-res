# 前端导航与数据加载延迟

## 背景（2026-10-24 生产实测）

生产请求从 Cloudflare 边缘节点（如 LAX）经 Tunnel 到新加坡服务器，每个请求往返约 0.5s，服务端处理只有
p50 14ms / p90 30ms，延迟几乎全在网络。切换工作台 tab 时原本有两次**串行**请求：

1. `/app/$slug` 的 `beforeLoad` 调 `getWorkspacePage`（TanStack Router 的 beforeLoad 每次导航都会重跑，
   包括预加载与 `router.invalidate()`）；
2. 之后才开始子路由 loader（`getCandidates`、`getCategoryStudies` 等）。

一次切换约 1s。本地 e2e（`apps/web/e2e/workbench-nav.spec.ts`）记录的基线：连续切 6 个 tab 共 12 个请求，每次 2 个。

## 做法

### 工作空间页数据：浏览器内短缓存

`apps/web/src/features/workspace/page-cache.ts` / `load-page.ts`。

- beforeLoad 中的开通检查只是 UX 门。真正的授权由各 Server Function 的 `withWorkspace` 在服务端强制
  （`apps/web/src/server/middleware.ts`），缓存布局数据不削弱安全。
- 只在浏览器内缓存，按 slug 保留一个条目，TTL 60s。SSR 每个请求照常获取，模块级状态不能跨请求共享。
  水合时 beforeLoad 不在客户端运行，`WorkspaceLayout` 用 SSR 数据填充缓存（已有条目时不覆盖，不延长 TTL）。
- 只缓存 `activation: 'active'`。待开通、出错和重定向都不缓存，管理员开通后用户刷新即可进入。
  `requireActivatedPage` 不变。
- 进行中的请求也在缓存中，悬停预加载与随后的导航共用一次请求。
- 失效：
  - 整页刷新、登出（`window.location.assign('/login')`）、切换或创建空间（`activateWorkspace` 整页跳转）时，内存自然清空；
  - 切到另一个 slug 时，旧条目被替换；
  - 空间设置页总是 `fresh` 获取，并刷新缓存；它的写操作之后执行 `window.location.reload()`；
  - 订阅变更（`billing.tsx`）在 `router.invalidate()` 之前调用 `clearWorkspacePageCache()`，因为它会影响只读状态与席位。
  - 以后新增会改变布局数据的客户端写操作，也照此调用。

### 悬停 / 聚焦预加载

`apps/web/src/router.tsx` 设置 `defaultPreload: 'intent'`、`defaultPreloadStaleTime: 10_000`，
预加载延迟沿用默认的 50ms，触摸时立即预加载。

已安装版本 `@tanstack/react-router` 1.170.41 / `@tanstack/router-core` 1.171.34 的行为
（源码 `router-core/src/load-client.ts` 的 `createLoaderTask` 与 `contextualize`，以及测试
`apps/web/src/router-preload.test.ts`）：

- 预加载的 loader 结果写入路由缓存，并标记 `match.preload = true`。导航命中这条匹配时，新鲜度按
  `preloadStaleTime ?? defaultPreloadStaleTime` 判断，**不看**路由的 `staleTime`。所以各工作台路由保留
  `staleTime: 0`，预加载 10s 内的数据也会被直接复用，不再请求。提交（commit）后 `preload` 被清为 false，
  之后按 `staleTime: 0` 处理。
- 数据过期或失效时，如果已有成功数据，按 stale-while-revalidate 处理：先渲染旧数据，再在后台重新调用 loader
  （`defaultStaleReloadMode` 默认 `'background'`）。这不阻塞导航。
- `router.invalidate()` 会同时把已提交、缓存和预加载的匹配标记为失效，并中止进行中的预加载。写操作后照常调用即可拿到新数据。
- `beforeLoad` 不参与复用：预加载与导航各运行一次。这正是 `/app/$slug` 需要上面那层缓存的原因。

各工作台路由的 `staleTime` 不需要调整。

### 其他放大延迟的点

- 品类洞察报告页（`report-page.tsx`）在分析中时每 4s 轮询。现在只让报告路由失效
  （`router.invalidate({ filter })`），父级 beforeLoad 走缓存，每轮只发一个 `getCategoryReport` 请求。
- 已检查各工作台子路由 loader：多数据源的页面（`config`、`billing`、`chat/$conversationId`）已用 `Promise.all`，
  没有串行瀑布。

## 结果（本地 e2e）

| 场景 | 改动前 | 改动后 |
|---|---|---|
| 直接点击切 tab（6 次） | 12 个请求，每次 2 个串行 | 6 个请求，每次 1 个（只有子路由 loader） |
| 悬停后点击 | 点击时 2 个串行请求 | 悬停时预加载 1 个，点击时 0 个 |
