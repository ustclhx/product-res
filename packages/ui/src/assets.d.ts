// Vite 的 `?url` 导入返回构建后的资源地址（字体预加载用）
declare module '*?url' {
  const src: string
  export default src
}
