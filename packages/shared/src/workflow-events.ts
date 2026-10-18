/**
 * Workflow 事件类型：web 通过 `instance.sendEvent` 发送、jobs 通过 `step.waitForEvent` 等待，
 * 两边共用同一常量，避免拼写不一致而静默超时（docs/06-ai.md §4）。
 * 事件类型只能含字母、数字、- 与 _，不能含 `.`。
 */

/** 外部服务商的媒体生成结果已到达（回调入口落库后发送） */
export const MEDIA_DONE_EVENT = 'media-done'
