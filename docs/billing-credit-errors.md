# 余额不足合同与聊天接线

`@product-res/shared` 导出 `INSUFFICIENT_CREDITS`、`InsufficientCreditsDetails`、
`insufficientCreditsError(estimatedCredits, availableCredits)` 和
`parseInsufficientCredits(value)`。构造器返回 HTTP 402 的 `AppError`，公共响应为：

```json
{"error":{"code":"INSUFFICIENT_CREDITS","message":"Insufficient credits","details":{"estimatedCredits":8,"availableCredits":2}}}
```

两个数值必须是非负安全整数，构造器和解析器均验证；该构造器只将这两个字段
放入 `publicDetails`。通用 `AppError.toJSON()` 只公开调用方显式指定的 `publicDetails`，
内部 `details` 与 `cause` 不外发。`toErrorResponse` 对状态 >=500 的错误统一返回
`INTERNAL_ERROR`，隐藏原始 code、message 与所有详情；保留原始 HTTP 状态。解析器是浏览器可用纯函数，支持公共响应对象、
AppError、JSON 字符串以及聊天 SDK 将响应正文包装后的 `Error.message`；不完整或
非法数值、其他 code 返回 `undefined`。

通用 `hold` 在空间锁内读取全部仍可用的积分后抛出 `CreditsError`，该类型继承
`AppError`，保留现有 `instanceof CreditsError` 与 code 判断。`estimatedCredits`
是请求预扣额，`availableCredits` 是竞争结束后锁内的实际余额。媒体接口保留这份详情。
聊天预算的预计消耗是请求输入与最小输出对应的成本（按次模型为固定成本），
并发预扣失败则采用 hold 的最新数值。`CreditsError` 对余额不足与独立欠费
`CREDIT_DEBT` 均返回 HTTP 402（没有数值详情也保持 402）；其他积分错误为内部 500，
在 Web 入口记录并由观测层上报。

对话输入区（`features/ai/chat-composer.tsx` 的 `ChatComposer`，对话页与嵌入式 SubjectChat 共用）解析 SDK 错误，
在输入框上方显示错误原因；余额不足时附预计消耗与可用余额，并弹出余额不足弹窗，入口为
`/app/$slug/billing#credit-packs` 和 `/app/$slug/billing#subscriptions`（add-ai-chat-components）。
