declare namespace Cloudflare {
  interface Env {
    /** migrator 账号的连接（vitest.config.ts）：audit_log 对 app 只追加，测试清理审计行用它 */
    HYPERDRIVE_MIGRATOR: Hyperdrive
  }
}
