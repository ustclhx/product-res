---
name: security-scan
description: 对本模板当前变更执行本地安全检查，扫描敏感文件与凭据特征，审查权限、租户、注入、Webhook、SSRF 和积分边界，并给出脱敏证据。
---

# 本地安全扫描

在含 `package.json` 与 `template.config.ts` 的项目根执行，路径均相对根目录。先读 `AGENTS.md`、`docs/01-architecture.md`、`docs/02-project-structure.md`；本技能执行本地只读审查和现有工程检查，不调用云端、线上或部署入口，不改 secrets。用户授权修复后再修改相应源码。

## 1. 固定范围与工程检查

记录用户指定的比较基准、当前提交、工作区状态和包含的产物。默认审查 HEAD 以来已暂存/未暂存变更及未忽略的新增文件；PR/分支审查按明确的 merge-base 范围。扫描工作树不会覆盖 Git 历史中的已删除凭据或远端运行配置，这些另列未覆盖。

```sh
git rev-parse HEAD
git status --short
git diff --stat HEAD
git diff --name-only HEAD
git diff --check HEAD
pnpm check
pnpm check:deps
pnpm check:singletons
```

有源码变化时按影响范围运行 typecheck、相关测试与目标构建，命令从对应 manifest 核对；避免为了扫描重复生成所有产物。`pnpm check` 包含积分写入/支付运行时边界检查；`check:deps` 检查包依赖和 Cloudflare 导入；`check:singletons` 检查关键依赖实例。它们都不能代替凭据或业务安全审查。

仓库没有专用源码泄漏扫描脚本。`pnpm staging:check-secrets` / `scripts/staging/check-secrets.mjs` 检查远端 Worker secret 名称是否齐全，需要云端权限；它不是源码凭据扫描，本流程不调用。

完成标准：确定可重现的基准、变更清单和工程检查结果，失败项保持原始原因，不弱化检查。

## 2. 执行脱敏凭据与路径扫描

以下 Python 3 标准库命令扫描 Git 跟踪与未忽略新增文件，也扫描现存 web/jobs 构建输出（包含被忽略的输出）。它只报告 `路径:行号 [规则]` 与计数；不输出匹配内容。忽略的 `.env.local`、`.dev.vars` 和 secret 文件不读取；若用户要求审查这些文件，明确扩大本地范围并继续仅报告名称/位置。敏感路径与命中是待核验线索，示例和测试假值也可能命中。

```sh
python3 - <<'PY'
import pathlib
import re
import subprocess
import sys

root = pathlib.Path.cwd()
listed = subprocess.check_output(
    ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z']
)
paths = {pathlib.Path(p.decode()) for p in listed.split(b'\0') if p}
artifact_roots = [
    pathlib.Path('apps/web/dist'),
    pathlib.Path('apps/web/.output'),
    pathlib.Path('apps/jobs/dist'),
]
for directory in artifact_roots:
    if directory.exists():
        paths.update(p for p in directory.rglob('*') if p.is_file())

rules = {
    'private-key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'provider-token': re.compile(
        r'\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}'
        r'|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}'
        r'|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,})\b'
    ),
    'credential-url': re.compile(r"""\b(?:postgres(?:ql)?|https?)://[^\s/:"'`]+:[^\s/@"'`]+@"""),
    'literal-secret': re.compile(
        r'''(?ix)\b(?:[a-z0-9_]*(?:api_key|secret|password|access_token)[a-z0-9_]*)
        ["']?\s*[:=]\s*["']([A-Za-z0-9_./+=-]{16,})["']'''
    ),
}
placeholder = re.compile(r'(?i)(?:example|placeholder|dummy|fake|test|replace|changeme|your[-_])')
sensitive = re.compile(r'(?:^|/)(?:secrets/|\.env(?:\.[^/]+)?$|\.dev\.vars(?:\.[^/]+)?$|id_rsa$|id_ed25519$)|\.(?:pem|p12|pfx|key)$')
findings = 0
errors = 0
for relative in sorted(paths, key=str):
    path = root / relative
    if not path.is_file() or path.is_symlink():
        continue
    if sensitive.search(relative.as_posix()) and not relative.name.endswith('.example'):
        print(f'{relative}:1 [sensitive-path]')
        findings += 1
    try:
        raw = path.read_bytes()
    except OSError:
        print(f'{relative}:1 [read-error]')
        errors += 1
        continue
    if b'\0' in raw:
        continue
    for number, line in enumerate(raw.decode('utf-8', errors='replace').splitlines(), 1):
        for label, pattern in rules.items():
            matches = list(pattern.finditer(line))
            if not matches:
                continue
            if label == 'literal-secret' and all(placeholder.search(m.group(1)) for m in matches):
                continue
            print(f'{relative}:{number} [{label}]')
            findings += 1
print(f'files={len(paths)} candidates={findings} read_errors={errors}')
sys.exit(2 if errors else 1 if findings else 0)
PY
```

退出 0 表示此规则/范围无候选，1 表示需人工确认候选，2 表示读取不完整。规则只匹配常见特征，不能证明没有泄漏；未引号包裹的通用密钥、非典型 token、编码/拆分值和二进制不在完整覆盖内。新增/变更 env、配置、日志、测试录制和构建文件须人工补审，使用本地编辑器核对而不把值复制到终端/报告。

每个候选标记为已确认泄漏、测试/占位误报或待核验，并记录路径/行号及依据。确认真值时立即停止传播；报告键名和位置，向用户说明需要撤销/轮换的对象与移除计划，只有已授权才执行变更。不要在报告中展示前缀、片段或 diff 原文来证明泄漏。

完成标准：扫描实际执行；每个候选都有脱敏分类，读取错误与未扫描产物明确记录。

## 3. 按 diff 审查安全边界

先依据变更文件列表和凭据候选确认安全输出范围，再在本地阅读完整 diff 与调用上下文。对可能含密钥的文件仅输出脱敏定位。未跟踪文件需单独审阅，因为 `git diff HEAD` 不包含它们。每项报告受影响入口、事实与风险；无相关变更写明不适用，不能只重复检查清单。

| 边界 | 核查重点与现有入口 |
|---|---|
| 身份与租户 | `apps/web/src/server/auth.ts`、`workspace-context.ts`；会话/可信 workspace、角色与资源归属检查在服务端，租户查询复用 `packages/db/src/scoped.ts`。后台写入复用 `features/admin/action.ts` / `action.server.ts` 的 adminAction，列表沿用 admin/list.ts。客户端隐藏按钮不能替代权限。 |
| 输入与注入 | Server Functions / HTTP 入参使用共享 schema；SQL 参数化，排序/字段由白名单决定；正文/HTML 与 URL 各走可信内容或既有校验链路；命令参数使用结构化参数或正确 shell 引用。检查 `dangerouslySetInnerHTML` 和动态 SQL 的来源。 |
| Webhook | `apps/web/src/features/billing/webhook-http.ts`、`packages/billing/src/`、`apps/web/src/routes/api/webhooks/media/$provider.ts`；先原始体验签，投递去重，事务处理业务，异步副作用；媒体先落库再唤醒。重放不能再次发积分，网络失败不能被吞成成功。 |
| SSRF/文件 | `packages/storage/src/media-validation.ts`；精确域名、协议、重定向、大小/MIME；上传完成用真实对象大小核验；下载按 tenant/ready/权限检查。客户端不能任意指定服务端端点。 |
| 账本与 AI | `packages/credits/src/index.ts` / `lifecycle.ts`、`packages/ai/src/models.ts` / `pricing.ts`；通过 hold/capture/release 等 API，整数积分、事务和幂等；权益/余额/能力检查在调用前，失败与取消只结算一次，定价用提交快照，精确额度不能靠边缘限流。 |
| 日志与产物 | `packages/shared/src/log.ts`；日志/审计/错误不含 token、密码、Authorization、signed URL、完整 env/schema；客户端 bundle/HTML/OG、source map、录制夹具、缓存和 release bundle 不携带私密配置。核对 `.gitignore`、env example 与构建公开变量，只有键名/占位符进入模板。 |

上述短路径 `workspace-context.ts` 相对 `apps/web/src/server/`，`features/admin/` 相对 `apps/web/src/`。新增目标能力也核对 `scripts/check-deps.rules.json`，不扩大平台例外绕过业务边界。

对存在的 `apps/web/dist`、`apps/web/.output`、`apps/jobs/dist` 核对扫描结果和生成来源；未生成的产物写明未覆盖。selfhost release bundle 依照 `docs/runbooks/selfhost-release.md` 的白名单/脱敏约定审查用户指定的本地目录，扫描代码的 artifact_roots 按实际目录追加；本技能不生成发布或读取远端 bundle。

完成标准：每个受影响边界得到 diff/上下文证据，问题按实际可利用性排序，范围外或缺环境的检查保留限制。

## 4. 交付与故障

交付基准 SHA/比较范围、工程检查命令与退出码、候选分类、问题定位/影响/修复建议，以及未覆盖历史、忽略的 secret 文件、外部服务、未生成产物。命令通过和零候选均不能表述为「无漏洞」。有待核验候选时保持待核验，不隐去问题使检查显绿。

- 工程检查失败：保存脱敏原因，定位当前变更或既有问题；用户授权修复后修改，再只重跑相关检查。
- 误报：本地确认测试数据/占位符并记录依据，不为单次误报删掉规则或全目录忽略。
- 构建未生成或缺数据库/凭据：明确未覆盖项目；已完成的只读审查仍可交付，不请求或修改线上 secret 来补齐本地扫描。
