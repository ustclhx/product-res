// 对话组件预览的回复 Markdown 示例（openspec add-ai-chat-components design D8），与设计稿
// docs/design-system/prototypes/chat-components/Main.dc.html、Mobile.dc.html、States.dc.html 的示例一致；数值为占位。
// 与 sample-reader.ts 一样放在 TS 中：示例含代码（花括号）与多行 Markdown，不适合消息格式的 JSON 文案。

type Locale = 'zh' | 'en'

const BASIC: Record<Locale, string> = {
  zh: `### 回访邮件的结构

回访邮件可以分三段：

1. 先感谢上次的合作；
2. 再说明新版本解决了对方提过的**导出卡顿**；
3. 最后约一个演示时间。

> 开场用具体的改进点，比泛泛的问候更容易得到回复。

- 主题行控制在 20 字以内；
- 正文不超过 5 句话，附上 \`/export\` 的更新说明。

原始数据见 [报告 §3.2](https://product.ezarouter.cc/reports/q3#section-3-2)。`,
  en: `### Structure of the follow-up email

The follow-up email can have three parts:

1. Thank them for the last project;
2. Explain that the new release fixes the **slow exports** they raised;
3. Propose a time for a demo.

> Opening with a concrete improvement gets more replies than a generic greeting.

- Keep the subject line under 8 words;
- Keep the body to 5 sentences and link the \`/export\` release notes.

The raw data is in [report §3.2](https://product.ezarouter.cc/reports/q3#section-3-2).`,
}

const TABLE_AND_CODE: Record<Locale, string> = {
  zh: `按报告第 3 章的数据，三个渠道上季度的获客成本如下：

| 渠道 | 新客 | 投放（元） | CAC（元） | 环比 |
| --- | ---: | ---: | ---: | ---: |
| 搜索广告 | 1,240 | 186,000 | 150 | −8% |
| 内容合作 | 860 | 98,900 | 115 | +3% |
| 线下活动 * | 310 | 74,400 | 240 | +21% |

\\* 线下活动含一次性场地费，剔除后 CAC 约 168 元。计算方法见下面的代码，\`spend\` 与 \`new_users\` 都按渠道汇总：

\`\`\`python
def cac(spend: dict[str, float], new_users: dict[str, int]) -> dict[str, float]:
    # 新客为 0 的渠道不计算，避免除零
    return {ch: round(spend[ch] / n, 1) for ch, n in new_users.items() if n > 0}
\`\`\`

- 内容合作的 CAC 最低，且仍在小幅上升，适合加量；
- 线下活动波动最大，建议按场次单独核算。`,
  en: `Based on chapter 3 of the report, last quarter's acquisition cost by channel was:

| Channel | New users | Spend | CAC | QoQ |
| --- | ---: | ---: | ---: | ---: |
| Search ads | 1,240 | 186,000 | 150 | −8% |
| Content partners | 860 | 98,900 | 115 | +3% |
| Offline events * | 310 | 74,400 | 240 | +21% |

\\* Offline events include a one-off venue fee; without it CAC is about 168. The calculation is below; \`spend\` and \`new_users\` are both summed per channel:

\`\`\`python
def cac(spend: dict[str, float], new_users: dict[str, int]) -> dict[str, float]:
    # Skip channels with no new users to avoid dividing by zero
    return {ch: round(spend[ch] / n, 1) for ch, n in new_users.items() if n > 0}
\`\`\`

- Content partners have the lowest CAC and are still rising slightly, so they can take more budget;
- Offline events vary the most; account for them per event.`,
}

// 危险输入：外部图片、javascript: / data: 链接与原始 HTML 都不应产生对应元素（ChatMarkdown 的安全处理）
const SAFETY: Record<Locale, string> = {
  zh: `趋势见下图：

![渠道趋势图](https://product.ezarouter.cc/chart.png)

![](https://product.ezarouter.cc/no-alt.png)

[点我查看](javascript:alert(1)) 与 [下载数据](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==) 显示为普通文字。

<script>alert(1)</script><img src="x" onerror="alert(1)"><iframe src="https://product.ezarouter.cc"></iframe>

原始 HTML 已丢弃。`,
  en: `The trend is in the chart below:

![Channel trend chart](https://product.ezarouter.cc/chart.png)

![](https://product.ezarouter.cc/no-alt.png)

[Click here](javascript:alert(1)) and [download the data](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==) show as plain text.

<script>alert(1)</script><img src="x" onerror="alert(1)"><iframe src="https://product.ezarouter.cc"></iframe>

Raw HTML is dropped.`,
}

const pick = (samples: Record<Locale, string>, locale: string) =>
  locale === 'zh' ? samples.zh : samples.en

export const chatBasicSample = (locale: string) => pick(BASIC, locale)
export const chatTableSample = (locale: string) => pick(TABLE_AND_CODE, locale)
export const chatSafetySample = (locale: string) => pick(SAFETY, locale)
/** 流式模拟的全文：结构示例 + 表格与代码块，覆盖未闭合代码块、只有表头的表格等中间态 */
export const chatStreamSample = (locale: string) =>
  `${pick(BASIC, locale)}\n\n${pick(TABLE_AND_CODE, locale)}`
