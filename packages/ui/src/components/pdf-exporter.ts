// 服务端生成 PDF 的扩展点（openspec add-ui-design-system tasks 8.4，design D11）。
// 零依赖的模块级注册表：应用或衍生项目在启动时注册实现，阅读器据此决定是否显示「服务端导出」选项；
// 未注册时阅读器只提供浏览器打印。注册表与组件分开，注册方不必加载阅读器本身。
import { useSyncExternalStore } from 'react'

export interface PdfExportDocument {
  /** 阅读器的标题，通常用作文件名 */
  readonly title: string
  /** 阅读器正在显示的 Markdown 源文 */
  readonly markdown: string
  /** 阅读器 `exportContext` 属性原样传入（如报告 id），供实现取服务端数据 */
  readonly exportContext?: unknown
}

/** 服务端导出实现：生成并触发下载；抛出的错误交给阅读器的 `onPdfExportError` */
export type PdfExporter = (document: PdfExportDocument) => void | Promise<void>

let current: PdfExporter | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

/**
 * 注册服务端 PDF 导出实现，返回注销函数。只保留最后一次注册；注销时只有当前实现仍是本次注册的才清空。
 */
export function registerPdfExporter(exporter: PdfExporter): () => void {
  current = exporter
  emit()
  return () => {
    if (current !== exporter) return
    current = null
    emit()
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 当前注册的实现；服务端渲染始终视为未注册，避免水合前后按钮形态不一致 */
export function usePdfExporter(): PdfExporter | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  )
}
