declare namespace Cloudflare {
  interface Env {
    /** 指向接受连接但从不响应的端口（vitest.config.ts） */
    HYPERDRIVE_HANGING: Hyperdrive
    /** 指向无人监听的端口（vitest.config.ts） */
    HYPERDRIVE_REFUSED: Hyperdrive
    /** migrator 账号的连接（vitest.config.ts）：audit_log 对 app 只追加，测试清理审计行用它 */
    HYPERDRIVE_MIGRATOR: Hyperdrive
  }
}
