// Cloudflare Vite 插件把 `.bin` 作为 Data 模块打包，导入值为 ArrayBuffer。
declare module '*.woff.bin' {
  const data: ArrayBuffer
  export default data
}
