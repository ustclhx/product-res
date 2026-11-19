// 项目自有：模板只创建本文件，之后不再修改（template-release 检查），template-sync 不会在这里冲突。
// 在 registerProjectToolRenderers 里为项目的工具登记对话中的显示名与详情（openspec add-ai-chat-components design D5），
// 未登记的工具只显示通用的「工具」与状态，不显示内部名称、参数与结果。例如：
//
//   import { m } from '../../paraglide/messages.js'
//   import { registerToolRenderer } from './tool-renderers.ts'
//
//   registerToolRenderer('search_reports', {
//     label: m.reports_tool_search,
//     // 可选：可折叠的详情；只显示对用户有意义的字段，不要原样输出参数与结果（常含内部 ID 与提示词片段）
//     render: ({ state, output }) =>
//       state === 'done' ? <span>{m.reports_tool_found({ count: countOf(output) })}</span> : null,
//   })
//
// 卡片外观与对话组件一样按 docs/design-system.md §9.2 的顺序定制。
export function registerProjectToolRenderers() {}
