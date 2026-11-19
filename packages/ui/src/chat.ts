// `@product-res/ui/chat` 子路径入口（openspec add-ai-chat-components design D3、D8）：对话组件只在对话路由与嵌入了
// SubjectChat 的页面使用，回复 Markdown 依赖 react-markdown 等较重的库，不放进 `@product-res/ui` 主入口，首页包不受影响。
// 全部为纯展示组件：文案由应用传入，不依赖 `ai` 包；AI SDK 的消息结构由 apps/web 的适配层映射到这些组件。

export {
  ChatMarkdown,
  type ChatMarkdownLabels,
  type ChatMarkdownProps,
} from './components/chat-markdown.tsx'
export {
  ChatMessage,
  type ChatMessageEndStatus,
  type ChatMessageProps,
  type ChatMessageRole,
  type ChatMessageStatus,
} from './components/chat-message.tsx'
export {
  InputMessage,
  type InputMessageLabels,
  type InputMessageProps,
} from './components/input-message.tsx'
export {
  ThinkingIndicator,
  type ThinkingIndicatorProps,
} from './components/thinking-indicator.tsx'
export {
  type StepStatus,
  ThinkingStep,
  type ThinkingStepProps,
  ThinkingSteps,
  ThinkingStepsContent,
  type ThinkingStepsContentProps,
  ThinkingStepsHeader,
  type ThinkingStepsHeaderProps,
  type ThinkingStepsProps,
} from './components/thinking-steps.tsx'
export {
  ToolCall,
  type ToolCallLabels,
  type ToolCallProps,
  type ToolCallState,
} from './components/tool-call.tsx'
