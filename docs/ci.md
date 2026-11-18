# CI 规范

目标：PR 检查约 5 分钟内出结果，合并到 staging 约 3 分钟。改 workflow 前先读本文。
衍生项目同步模板时沿用同一套规则；项目自己新增的 workflow 也按本文写。

## 1. 合并前必须通过的检查

- **必须通过**：`CI` workflow 的全部 job（含 `tested-tree <tree>`）与 `Template release checks`。
- **触发时必须通过**：`Selfhost images`、`Selfhost disabled features`、`Selfhost deployment gates`。
  它们按路径触发，没有触发不阻塞合并；main 上总会全量运行。
- 仓库不设分支保护，协调者按上述规则判断「全绿」后合并，不等未触发或与本 PR 无关的检查。

## 2. 三种 CI 模式（`scripts/ci/plan.mjs`）

`ci.yml` 的第一个 job `changes` 决定本次模式，判断不了一律回退 `full`：

| 模式 | 条件 | 运行内容 |
| --- | --- | --- |
| `docs` | 变更全部是 `docs/**`、`openspec/**`、根目录 `*.md`、`.agents/.claude/.omp` 下的 `.md` | 只跑 `lint`（`pnpm check` 会读取文档与技能文件） |
| `reuse` | main 上的 push，提交树与其 PR 最近一次成功 CI 测过的合并树完全相同 | 跳过全部重任务，直接成功并触发 staging |
| `full` | 其他情况 | 全部任务 |

- `apps/`、`packages/`、`scripts/`、`deploy/` 下的 `.md/.mdx` 不算文档（内容集合与测试夹具会读取）。
- `reuse` 的条件全部满足才成立：提交恰好是一个本仓库 PR 的合并提交；该 PR head 最近一次 CI 已完成且成功；
  该次运行恰好有一个成功的 `tested-tree <T>` job；`T` 等于本次提交树。PR 合并后 main 有其他提交时自然回退 `full`。
- 手动运行 `ci.yml` 并填 `probe_sha` 可只打印某个提交的复用判断（本次运行仍为 `full`，不部署）。
- 被跳过的 job 不影响 workflow 结论；`deploy-staging` 只看 CI 是否成功。

## 3. 任务拆分与缓存

- `ci.yml` 拆为 `lint`、`build`、`test-packages`、`test-web`、`node-web`、`node-jobs`、`node-build`、`e2e-smoke` 并行，
  共用 `.github/actions/setup-workspace`（安装约 20–30 秒）。新增检查放进已有 job，确有并行收益再拆新 job。
- `build` 与 `test-packages` 用 Turbo 本地缓存（actions/cache，键含 OS、job、lockfile 与 sha）。
  缓存只在任务输入声明完整时安全：
  - 包内源码按字面相对路径引用包外文件时，必须进入该任务的 `inputs` 或根 `globalDependencies`；
    `scripts/check-turbo-inputs.mjs`（`pnpm check` 内）会检查，动态拼出的路径仍需评审留意；
  - 影响行为的环境变量写进 `env`/`passThroughEnv`；
  - 依赖数据库的测试（db、auth、jobs、web 等）不缓存。
- Playwright 浏览器统一用 `.github/actions/install-chromium`（只装 shell，缓存浏览器，apt 带超时），不直接 `playwright install --with-deps`。

## 4. 并发

- 每个 PR 触发的 workflow 都设 `concurrency`，PR 上 `cancel-in-progress: true`。
- main push 与发布调用不得被取消：按 SHA 或 `run_id` 分组，`cancel-in-progress` 只在 `pull_request` 时为真。
  被取消的 main CI 会让该 SHA 永远不部署、不能发布。

## 5. 自托管镜像

- 只构建与发布 **linux/amd64**（2026-11 起；无异构部署需求）。`init-server.py` 拒绝 arm64 主机；
  本机 Apple Silicon 仍可构建 arm64 镜像做开发测试，但发布只读取 `policy.architectures`。
- PR 上只在影响镜像的路径变更时构建（selfhost 材料、本 workflow、依赖清单、initdb、镜像内的 Node 构建入口），
  main push 与发布调用总是构建。用 runner 自带 dockerd 的默认 driver；实测 `type=gha` 层缓存反而更慢，不要加回。
- PR 与 main 只上传证据 JSON；镜像 tar 只在发布调用时上传。
- `Selfhost disabled features` 在 PR 上只在模板配置、`packages/config`、生成器、该测试自身或 selfhost 材料变更时运行。

## 6. 新增或修改 workflow 的检查清单

- 有 `pull_request` 触发时：需要路径过滤吗？过滤后 main 是否仍全量覆盖？
- 设置了正确的 `concurrency`（PR 取消、main 不取消）。
- 是否引入新的串行长步骤？超过 2 分钟的步骤先考虑并行或缓存。
- 合并后核对 main 的 CI、staging 部署与发布流水线结论。
