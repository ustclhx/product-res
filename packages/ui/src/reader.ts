// `@product-res/ui/reader` 子路径入口（tasks 8.4）：长文阅读器依赖 react-markdown 等较重的库，不放进 `@product-res/ui` 主入口，
// 页面用 `lazy(() => import('@product-res/ui/reader'))` 按需加载，构建时形成独立分包。
// 服务端 PDF 扩展点 `registerPdfExporter` 零依赖，仍从主入口导出，注册方不必加载阅读器。
export {
  Reader,
  type ReaderController,
  ReaderEmpty,
  type ReaderEmptyProps,
  ReaderError,
  type ReaderErrorProps,
  ReaderExportButton,
  type ReaderExportButtonProps,
  type ReaderExportLabels,
  type ReaderImagePolicy,
  type ReaderLabels,
  ReaderProgress,
  type ReaderProgressProps,
  type ReaderProps,
  type ReaderStatus,
  useReaderController,
} from './components/reader.tsx'
