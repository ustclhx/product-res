import {
  getConversationSubject,
  registerConversationSubject,
} from '../../src/features/ai/subjects.ts'

// 嵌入式对话 e2e（add-ai-chat-components 5.2）专用：替换项目自有的 subject-providers.ts，登记一个不查库的对象类型。
// 只在 e2e/subject-chat/vite.ts 的 dev 服务器中生效。
if (!getConversationSubject('e2e-note'))
  registerConversationSubject('e2e-note', {
    label: (locale) => (locale === 'zh' ? '季度报告' : 'Quarterly report'),
    async resolve(ctx) {
      return {
        title: ctx.locale === 'zh' ? '就这份报告提问' : 'Ask about this report',
        suggestions:
          ctx.locale === 'zh'
            ? ['这份报告的核心结论是什么？', '列出三个主要风险']
            : ['What is the main conclusion?', 'List the three main risks'],
        context: async () => ({ version: 'e2e-v1', text: 'Revenue grew 6%; model costs rose.' }),
      }
    },
  })
