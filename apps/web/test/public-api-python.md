# Python SDK 复核

Node SDK 测试 `public-api.test.ts` 使用真实 Better Auth Key、隔离 Postgres、AI SDK 模拟模型和 OpenAI 官方 SDK；验证 JSON / SSE、按次 / token 积分扣费、定价快照、撤销、限流及断流结算。CI 自动执行该测试，不需要真实供应商凭据。

Python SDK 的复核脚本为 `public-api-python.py`。在已开启 `features.publicApi`、套餐允许 public API 且模型工厂已接入的环境，从空间 owner / admin 的 API Keys 页创建 Key，然后执行：

```sh
python3 -m venv /tmp/public-api-sdk
/tmp/public-api-sdk/bin/pip install openai
export OPENAI_BASE_URL=http://localhost:3000/api/v1
export OPENAI_MODEL=站点模型注册表中的key
read -s OPENAI_API_KEY
export OPENAI_API_KEY
/tmp/public-api-sdk/bin/python apps/web/test/public-api-python.py
unset OPENAI_API_KEY
```

脚本验证非流式响应、SSE 文本、结束原因与 usage 汇总；运行两次调用后可在空间用量页核对积分。该脚本会调用真实模型并扣费，选择有足够积分的测试空间。

本分支本地还通过临时 Node HTTP 桥接调用同一个 `handleCompletions`，注入与 Node 测试一致的模拟模型，并用 Python 官方 SDK 实际请求 HTTP：输入 200 / 输出 1180 token，单次扣 12 积分，两次扣 24，余额 1000 → 976，held=0。桥接使用本 worktree 隔离库并清理测试数据，无真实 AI Gateway 或供应商调用。当前 CI 未安装 Python SDK；自动 CI 覆盖 Node，Python 脚本供配置好模型后复核。
