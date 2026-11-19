/**
 * Package versions from the top-level `packages:` section of a pnpm-lock.yaml text.
 * @param {string} text Lockfile contents ('' when absent).
 * @returns {Map<string, Set<string>>} Package name → resolved versions.
 */
export function lockPackages(text) {
  const packages = new Map()
  let inside = false
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) inside = line.startsWith('packages:')
    if (!inside) continue
    const key = line.match(/^ {2}(?:'([^']+)'|"([^"]+)"|([^\s'"][^:]*)):\s*$/)
    if (!key) continue
    const spec = (key[1] ?? key[2] ?? key[3]).replace(/\(.*$/, '')
    const at = spec.lastIndexOf('@')
    if (at <= 0) continue
    const name = spec.slice(0, at)
    if (!packages.has(name)) packages.set(name, new Set())
    packages.get(name).add(spec.slice(at + 1))
  }
  return packages
}

/**
 * Packages whose resolved versions differ between two lockfiles, sorted by name.
 * @param {string} before
 * @param {string} after
 * @returns {{name: string, before: string[], after: string[]}[]}
 */
export function diffLockPackages(before, after) {
  const a = lockPackages(before)
  const b = lockPackages(after)
  return [...new Set([...a.keys(), ...b.keys()])]
    .sort()
    .map((name) => ({
      name,
      before: [...(a.get(name) ?? [])].sort(),
      after: [...(b.get(name) ?? [])].sort(),
    }))
    .filter((item) => item.before.join(',') !== item.after.join(','))
}

const statusText = { pass: '通过', fail: '失败', skip: '跳过' }
const list = (items, render) => (items.length ? items.map(render).join('\n') : '- 无')

/**
 * @typedef {object} SyncReport
 * @property {string} template Template source as given.
 * @property {{commit: string, version: string | null}} base
 * @property {{ref: string, defaulted?: boolean, commit: string, version: string | null}} target
 * @property {string} branch Sync branch.
 * @property {boolean} resumed True when the file merge was already done on the branch.
 * @property {string[]} applied
 * @property {{path: string, reason: string}[]} conflicts
 * @property {string} setupDiff PROJECT_SETUP.md diff between the copies.
 * @property {{path: string, modified: boolean}[]} [retained] Files the template deleted, kept in the project.
 * @property {{source: string, tag: string}[]} ported
 * @property {string[]} skippedMigrations
 * @property {string[]} [commentOnlyMigrations] Published template migrations whose change is whole-line comments only.
 * @property {{name: string, before: string[], after: string[]}[]} lockChanges
 * @property {{name: string, command: string, status: 'pass' | 'fail' | 'skip', detail?: string}[]} checks
 * @property {boolean} baseUpdated
 * @property {{documents: {version: string, link: string, summary: string, actions: {text: string}[]}[], warnings: string[], boundary: object | null}} [upgrades]
 * @property {{actual: string[], documented: string[], warnings: string[]}} [migrationComparison]
 * @property {string[]} [notes]
 */

/**
 * Render the sync report as Markdown.
 * @param {SyncReport} report
 * @returns {string}
 */
export function renderReport(report) {
  const short = (sha) => sha.slice(0, 12)
  const version = (v) => (v ? ` (template-v${v})` : '')
  const lines = [
    `# 模板同步报告 ${short(report.base.commit)}..${short(report.target.commit)}`,
    '',
    `- 模板：${report.template}`,
    `- 基准：${report.base.commit}${version(report.base.version)}`,
    `- 目标：${report.target.commit}${version(report.target.version)}（--to ${report.target.ref}${report.target.defaulted ? '，默认' : ''}${report.target.version ? '' : '，目标未发布'}）`,
    `- 同步分支：${report.branch}${report.resumed ? '（继续：文件合并已在本分支完成）' : ''}`,
    `- 基准记录：${report.baseUpdated ? '已更新到目标提交' : '未更新'}`,
    ...(report.notes ?? []).map((note) => `- 注意：${note}`),
    '',
    '## 升级说明（按版本顺序）',
    '',
    list(
      report.upgrades?.documents ?? [],
      (doc) => `- [template-v${doc.version}](${doc.link})：${doc.summary}`,
    ),
    '',
    '## 必须执行的动作',
    '',
    list(
      (report.upgrades?.documents ?? []).flatMap((doc) =>
        doc.actions.map((action) => ({ ...action, version: doc.version })),
      ),
      (action) => `- [ ] ${action.version}：${action.text}`,
    ),
    '',
    '## 升级说明与迁移核对',
    '',
    `- 实际迁移计划（含跳过）：${report.migrationComparison?.actual.join(', ') || '无'}`,
    `- 说明中的迁移：${report.migrationComparison?.documented.join(', ') || '无'}`,
    ...[...(report.upgrades?.warnings ?? []), ...(report.migrationComparison?.warnings ?? [])].map(
      (warning) => `- 警告：${warning}`,
    ),
    '',
    `## 冲突（${report.conflicts.length}）`,
    '',
    report.conflicts.length
      ? `${report.conflicts.map((item) => `- \`${item.path}\`：${item.reason}`).join('\n')}\n\n解决冲突并提交后，在同步分支上用相同的 --to 重新运行同步，继续迁移移植与验证。`
      : '- 无',
    '',
    `## 模板已删除、项目中保留的文件（${report.retained?.length ?? 0}）`,
    '',
    report.retained?.length
      ? `${report.retained.map((item) => `- \`${item.path}\`${item.modified ? '（项目改过）' : ''}`).join('\n')}\n\n同步不删除这些文件。确认项目不再使用后自行删除并提交；仍在使用的文件今后由项目自己维护。`
      : '- 无',
    '',
    `## 已应用的模板变更（${report.applied.length}）`,
    '',
    list(report.applied, (path) => `- \`${path}\``),
    '',
    '## 移植的迁移',
    '',
    list(report.ported, (item) => `- \`${item.source}\` → \`${item.tag}\``),
    '',
    '## 已跳过的迁移',
    '',
    report.skippedMigrations.length
      ? `${report.skippedMigrations.map((tag) => `- \`${tag}\``).join('\n')}\n\n这些迁移未移植，但已登记为已处理，以后不会再出现。请自行确认项目代码不依赖它们。`
      : '- 无',
    '',
    '## 仅注释变化的已发布迁移',
    '',
    report.commentOnlyMigrations?.length
      ? `${report.commentOnlyMigrations.map((tag) => `- \`${tag}\``).join('\n')}\n\n模板只改了这些迁移的整行注释，语义不变；项目中的文件保持原样，不重新执行。`
      : '- 无',
    '',
    '## 锁文件中版本变化的包',
    '',
    list(
      report.lockChanges,
      (item) =>
        `- \`${item.name}\`：${item.before.join(', ') || '（无）'} → ${item.after.join(', ') || '（无）'}`,
    ),
    '',
    '## 验证',
    '',
    list(
      report.checks,
      (item) =>
        `- ${item.name}：${statusText[item.status]}（\`${item.command}\`）${item.detail ? ` — ${item.detail}` : ''}`,
    ),
    '',
    '## PROJECT_SETUP.md 的变化（未写入项目，请人工核对）',
    '',
    report.setupDiff.trim() ? `\`\`\`diff\n${report.setupDiff.trimEnd()}\n\`\`\`` : '- 无',
    '',
  ]
  return lines.join('\n')
}
