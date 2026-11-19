# 示例评测套件：产品简介撰写

模板自带的中性示例，演示 `pnpm eval:prompts` 的完整用法（说明见 `docs/06-ai.md`「提示词版本与评测」）。
项目自己的套件放在根目录 `evals/<suite>/`，模板不在该目录交付文件。

| 文件 | 内容 |
|---|---|
| `prompts.ts` | 两个提示词版本 `product-intro@v1`（两个章节）与 `@v2`（三个章节、更严格的事实要求） |
| `samples.json` | 中英文样本各 3 个，全部为虚构的合成数据；`zh-planner` 故意把长度上限设为 120 字并标为警告级，演示警告只进报告、不影响退出码 |
| `suite.ts` | 模型与单价、评分标准 `r1`、套件级检查（覆盖全部内置检查） |
| `prompts.lock.json` | 版本锁：每个版本对每个样本的输入与渲染摘要，评测运行时自动追加，已有条目不得修改 |
| `recordings/<promptVersion>/<modelKey>/` | 回放录制：`<sampleId>.json` 为生成结果，`<sampleId>.judge.<judgeKey>.json` 为评委结果 |

## 录制来源

录制按 `source` 字段区分，沿用媒体夹具（`packages/ai/src/media/fixtures/README.md`）的约定：

- `constructed`：按录制格式手写，用于让回放离线可跑、覆盖检查与评委逻辑；不代表真实模型的输出质量。
  `usage` 为按字数估算的示意值，不来自 Provider。
- `recorded`：用 `--record --budget-usd <美元>` 调用真实模型写入。重新录制后在下表记录日期、模型、
  预算与报告中的实际估算费用。录制只保存提示词版本、渲染摘要、模型键与 ID、输出、结束原因、用量、
  时间与来源，不含请求头、端点或密钥。

| 日期 | 来源 | 生成 / 评委模型 | 预算 | 估算费用 |
|---|---|---|---|---|
| 2026-11-14 | constructed（全部 24 个文件） | — | — | $0 |
| 2026-11-14 | recorded（全部 24 个文件，替换上一行） | deepseek-chat（thinking 关闭）/ deepseek-chat | 每个版本 $0.25 | v1 $0.0061，v2 $0.0054 |

## 常用命令

```sh
pnpm eval:prompts --suite example                                # 回放 v2，离线、零费用
pnpm eval:prompts --suite example --baseline product-intro@v1    # 同次回放 v1 作基线并对比
pnpm eval:prompts --suite example --no-judge --tag zh            # 只跑中文样本的确定性检查
```
