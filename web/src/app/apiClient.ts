export type HealthResponse = { status: "ok"; service: "product-res"; mode: "demo" | "pilot" };

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch("/api/v1/health", { signal });
  if (!response.ok) throw new Error(`健康检查失败（HTTP ${response.status}）`);
  const payload = (await response.json()) as Partial<HealthResponse>;
  if (payload.status !== "ok" || payload.service !== "product-res" || !["demo", "pilot"].includes(payload.mode ?? "")) {
    throw new Error("健康检查返回内容不符合预期");
  }
  return payload as HealthResponse;
}
