/** C 的对象存储 adapter 接口；不暴露目标 SDK 的对象与元数据。 */
export interface Storage {
  head(key: string): Promise<{ readonly size: number; readonly mime: string | null } | null>
  delete(key: string): Promise<void>
  presignUpload(
    key: string,
    mime: string,
  ): Promise<{
    readonly uploadUrl: string
    readonly headers: Readonly<Record<string, string>>
    readonly expiresIn: number
  }>
  presignDownload(key: string, attachment?: boolean): Promise<string>
}
