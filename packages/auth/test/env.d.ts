declare namespace Cloudflare {
  interface Env {
    HYPERDRIVE: Hyperdrive
    /** 指向无人监听的端口（vitest.config.ts）：用于证明某条路径没有查库 */
    HYPERDRIVE_REFUSED: Hyperdrive
    /** migrator 账号的连接（vitest.config.ts）：audit_log 对 app 只追加，测试清理审计行用它 */
    HYPERDRIVE_MIGRATOR: Hyperdrive
    CACHE: KVNamespace
    CACHE_EMPTY: KVNamespace
    RL_AUTH: RateLimit
  }
}
