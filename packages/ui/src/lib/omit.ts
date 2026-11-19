// 来源：fluid-functionalism omit（2026-11，https://www.fluidfunctionalism.com/r/omit.json，MIT）
// 适配：radix-ui 统一包导入、包内相对路径、去掉 "use client"；其余改动见 packages/ui/UPSTREAM.md
/**
 * A shallow copy of `object` without `keys`: the same own properties a
 * `{ key: _key, ...rest }` destructure keeps, without the unused binding.
 * Components use it to drop props before spreading the rest onto an
 * element (framer-motion's own onDrag/onAnimation* handlers, a primitive's
 * style, a prop the other flavor reads).
 */
export function omit<T extends object, K extends keyof T>(
  object: T,
  keys: readonly K[],
): Omit<T, K> {
  const rest = { ...object }
  for (const key of keys) delete rest[key]
  return rest
}
