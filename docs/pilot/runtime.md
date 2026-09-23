# Pilot 运行指南

本文针对已实现的 `pilot` 模式，供部署者在独立数据目录中创建两个空工作区并配置来源。`demo` 与 pilot 使用不同进程配置和数据目录；pilot 不读取、初始化或重置 demo 样例。

## 1. 设置运行环境

在 product-res 根目录执行。下面的路径只是示例，替换为实际的受保护目录；不要把口令或 API key 写入 shell 历史、镜像或仓库。

```sh
export PRODUCT_RES_MODE=pilot
export PRODUCT_RES_DATA_DIR=/srv/product-res/data
export PRODUCT_RES_PUBLIC_URL=https://pilot.example.invalid
export PRODUCT_RES_PROVIDERS_FILE=/srv/product-res/deploy/providers.json
mkdir -p "$PRODUCT_RES_DATA_DIR" /srv/product-res/secrets
chmod 700 "$PRODUCT_RES_DATA_DIR" /srv/product-res/secrets
```

`PRODUCT_RES_PUBLIC_URL` 必须是没有路径、查询参数或凭据的 HTTP(S) origin。HTTP 仅允许 loopback；当前正式入口为 https://product.ezarouter.cc，PUBLIC_URL 与该 HTTPS origin 一致；团队无需 SSH 隧道。默认会话 TTL 为 12 小时，可用 `PRODUCT_RES_SESSION_TTL_SECONDS` 调整；登录窗口默认 15 分钟、最多连续失败 5 次，可用对应 `PRODUCT_RES_LOGIN_WINDOW_SECONDS` 和 `PRODUCT_RES_LOGIN_MAX_FAILURES` 调整。

pilot 自动使用 `$PRODUCT_RES_DATA_DIR/control.sqlite3` 和 `$PRODUCT_RES_DATA_DIR/workspaces/`。不要设置 `PRODUCT_RES_DB`；pilot 会拒绝手工指定单一业务库。

## 2. 创建两个空工作区和成员

首次初始化前保持 `PRODUCT_RES_MODE=pilot` 和 `PRODUCT_RES_DATA_DIR` 已设置：

```sh
uv run --frozen python -m app.pilot.cli init-workspace --slug partner-team --name '合作团队'
uv run --frozen python -m app.pilot.cli init-workspace --slug internal-dtc --name '内部自建站团队'
uv run --frozen python -m app.pilot.cli create-user --username partner-lead --display-name '合作团队负责人'
uv run --frozen python -m app.pilot.cli create-user --username internal-lead --display-name '内部团队负责人'
uv run --frozen python -m app.pilot.cli create-user --username partner-analyst --display-name '合作团队分析负责人'
uv run --frozen python -m app.pilot.cli create-user --username internal-analyst --display-name '内部团队分析负责人'
uv run --frozen python -m app.pilot.cli add-member --workspace partner-team --username partner-analyst --role analyst
uv run --frozen python -m app.pilot.cli add-member --workspace internal-dtc --username internal-analyst --role analyst
uv run --frozen python -m app.pilot.cli add-member --workspace partner-team --username partner-lead --role decision
uv run --frozen python -m app.pilot.cli add-member --workspace internal-dtc --username internal-lead --role decision
```

每条 `init-workspace` 命令返回服务端生成的 workspace UUID。把两个 UUID 记录到非敏感的 provider 配置中。`create-user` 未指定 `--password-file` 时安全地交互输入两次口令；口令至少 12 个字符，不存在默认管理员或默认密码。若使用文件，文件必须仅属当前用户可读（例如 `chmod 600 /path/to/password`），使用后从受保护目录移除。

成员角色只有 `analyst`、`decision`、`contributor`。成员关系在控制库中，业务数据在对应工作区库中；同一用户可被加入两个工作区，登录后切换工作区。

## 3. 配置来源和 secret 权限

`PRODUCT_RES_PROVIDERS_FILE` 指向非敏感 JSON；Compose 会以只读方式挂载它。每个 workspace UUID 下可配置 `dataforseo`、`serpapi` 和 `newapi`。凭据内容单独放在服务端 secret 文件中，权限为 `0600`，API 和 worker 以只读方式挂载。不要把真实 key、token、ECS IP 或外部 secret 写进本文或提交到仓库。

```json
{
  "workspaces": {
    "<partner-workspace-uuid>": {
      "dataforseo": {
        "secret_file": "/run/secrets/dataforseo",
        "licensed": false,
        "request_limit": 20,
        "retention_days": 7
      },
      "serpapi": {
        "secret_file": "/run/secrets/serpapi",
        "licensed": false,
        "request_limit": 20,
        "retention_days": 7
      },
      "newapi": {
        "secret_file": "/run/secrets/newapi",
        "base_url": "http://host.docker.internal:3000/v1",
        "trusted_hosts": ["host.docker.internal"],
        "model": "<operator-approved-model>",
        "thinking_mode": "disabled",
        "prompt_version": "newapi-prompt-v2-deepseek-nonthinking",
        "request_limit": 50,
        "timeout_seconds": 120,
        "max_output_tokens": 18000,
        "max_total_tokens": 200000
      }
    },
    "<internal-workspace-uuid>": {
      "dataforseo": {"secret_file": "/run/secrets/dataforseo", "licensed": false, "request_limit": 20, "retention_days": 7},
      "serpapi": {"secret_file": "/run/secrets/serpapi", "licensed": false, "request_limit": 20, "retention_days": 7},
      "newapi": {"secret_file": "/run/secrets/newapi", "base_url": "http://host.docker.internal:3000/v1", "trusted_hosts": ["host.docker.internal"], "model": "<operator-approved-model>", "thinking_mode": "disabled", "request_limit": 50, "timeout_seconds": 120, "max_output_tokens": 18000, "max_total_tokens": 200000}
    }
  }
}
```

DataForSEO secret 文件为 `login:password` 单行文本，SerpApi 为 API key，NewAPI 为 product-res 服务端 token；具体格式以已授权账号约定为准。`licensed` 在确认来源条款、团队使用和留存范围前必须保持 `false`，因此来源状态不会进入 READY。`request_limit` 是每个工作区的任务预留上限：已创建的发现或模型任务会累计占用，不按月自动 reset，也不会因失败自动返还或自动充值。市场来源必须设置 1–365 天的 `retention_days`；source material 到期后只保留允许保留的摘要/元数据。NewAPI 不使用市场来源的留存字段。

NewAPI 的 `base_url`、`trusted_hosts`、`model` 和 token 由服务端配置注入。模型名不会照搬 d2market 的 global 白名单；上线前由操作员检查目标 `/models` 或等价能力，并运行一次有界结构化 smoke。超时上限 120 秒、输出和总 token 上限由配置约束，不能把共享 NewAPI 的无限额度当成 product-res 预算。

2026-09-21 测试阶段：按用户要求将两团队输出上限从 1800 提高十倍至 18000；总 token 预算从 20000 放宽至 200000、累计模型任务额度从 5 提高至 50、超时从 60 调至 120 秒。输出上限不是每次预付消耗，实际用量看节点 usage / NewAPI 调用日志。当前发送前以 UTF-8 字节保守估算输入，故 max_total_tokens 也影响预检；它不是模型上下文能力声明。

## 4. 启动和检查

以上环境变量与 CLI 初始化适用于直接在 Python 环境运行。使用以下两个独立进程（须使用 Python 3.12）：

```sh
uv run --frozen uvicorn app.main:app --host 127.0.0.1 --port 8000
# 另开同样环境变量的终端
uv run --frozen python -m app.pilot.worker
curl --fail http://127.0.0.1:8000/api/v1/health
```

Compose 部署请使用 [部署指南](deployment.md) 的 `.env`、命名数据卷和容器内 CLI，不会读取上面宿主机 `/srv` 目录中的库。修改 providers 配置后重启本项目 API 与 worker，使两者使用同一份配置。

健康检查只证明进程可用，不证明来源授权、NewAPI 模型可用或团队闭环完成。登录后可查看 `/api/v1/pilot/sources`；未配置、未授权、额度耗尽和凭据缺失会分别显示。两种市场适配器每次最多取前 10 条，默认手动触发；人工/CSV 结果仍可在来源不可用时继续使用。

任务 worker 在短事务中领取和落库，外部网络调用在事务外执行。401/403、模型不可用和配置错误需要修配置；已发出但无权威响应的网络断开、超时或不确定 5xx 进入 `OUTCOME_UNKNOWN`，不会自动重试，以免重复计费或重复写入。只有能够证明尚未发送的失败才允许有限重试；需要重试时由用户明确发起新任务。

## 5. 当前验收边界

管理员能力使用独立的服务端 `is_admin` 标识，管理页为 `/admin/accounts`。管理员可维护账号及工作区角色，但不能自动绕过项目审批规则；普通成员调用管理 API 会被拒绝。初始化、随机口令交付和 v2 控制库回滚方式见 [账号管理](account-administration.md)。

代码、离线契约和受控假服务可以验证隔离、任务恢复、来源适配和结果映射。2026-09-21 两个市场来源均已取得真实查询回执（见 [DataForSEO](dataforseo-verification-2026-09-21.md)及 [SerpApi](live-market-verification-2026-09-21.md)）；ECS 状态以 [现场验收记录](ecs-readiness-2026-09-20.md) 为准；独立 HTTPS 域名和两个团队各自的真实闭环也尚未完成。真实结果必须标为 REAL，测试联调标为 TEST，样例只能标为 DEMO，三者不混计。

DeepSeek 官方渠道本轮使用 `thinking_mode=disabled`，避免资料整理节点的思考输出耗尽小额 token 上限；其他模型未配置该字段时不发送 `thinking` 参数。`finish_reason=length` 明确报截断，不接受残缺输出。提示词版本随运行回执记录；更换思考配置时也应更新 `prompt_version`，使历史运行可区分。

## 市场查询等待时限与已完成任务恢复

`dataforseo`、`serpapi` 配置可选 `timeout_seconds`，默认 30，必须是 1–120 的有限数值；例如 DataForSEO Live 可设置 90。worker 租约保持 180 秒，每个采集任务仍最多外发一次。延长等待不增加自动重试或采集次数。

若查询已经外发而应用未收到结果，先保留 OUTCOME_UNKNOWN；使用供应商免费任务记录核对原任务，不因超时盲目重发。对于 DataForSEO，运营人员可以核对 ID List 的任务 ID、查询、地区、语言、时间、原费用，再用 Task GET 取得原结果。仅在原工作区、分析负责人权限、当前项目输入版本等校验通过后调用受限恢复逻辑；原超时 attempt 与审计必须保留。免费 Task GET 返回 cost=0 表示恢复请求免费，不能据此覆盖原市场查询费用。

恢复入口为 `app.pilot.reconcile.reconcile_discovery(tx, actor, job_id, task_document, audit_entry, expected_version)`，仅供已认证的运营脚本使用，没有公共 HTTP 入口。必须使用原任务工作区和 actor 的 `bind_request`，在同一个工作区事务内调用。`task_document` 为官方 Task GET JSON，`audit_entry` 为匹配 ID List 行；接口不会外发请求，也不会替调用者获取或推断供应商任务。返回 `reused=True` 表示已恢复过同一任务，直接复用原批次。不同任务、过期输入、取消任务、非 UNKNOWN 状态或不一致参数均拒绝。
