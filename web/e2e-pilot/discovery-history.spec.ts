import { expect, test } from "@playwright/test";

const projectId = "pilot-history-project";
const jobId = "discovery-history-job";

test("restores an existing discovery batch in a fresh browser", async ({ page }) => {
  const discoveryWrites: string[] = [];
  page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/discovery")) discoveryWrites.push(request.url()); });
  await page.route("**/api/v1/auth/session", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      user: { id: "analyst", username: "analyst" },
      workspace: { id: "workspace-one", name: "Pilot workspace", slug: "pilot" },
      workspaces: [], members: [], csrf_token: "csrf",
    }),
  }));
  await page.route(`**/api/v1/projects/${projectId}`, route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      project: { id: projectId, name: "History project", channel: "AMAZON", market: "US", direction: "厨房收纳", goal: "验证批次恢复", version: 1, current_criteria_id: "criteria-1" },
      criteria_versions: [{ id: "criteria-1", rules: [], required_evidence: ["procurement_cost"] }],
      candidates: [],
    }),
  }));
  await page.route("**/api/v1/project-templates", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }));
  await page.route("**/api/v1/pilot/sources", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [
    { id: "dataforseo", label: "DataForSEO", status: "READY", channel: "AMAZON", market: "US", request_limit: 3, requests_reserved: 1, requests_remaining: 2, result_limit: 10, timeout_seconds: 30, query_scope: { channel: "AMAZON", market: "US", location: "United States", language: "en" }, is_demo: false },
  ] }) }));
  await page.route(`**/api/v1/projects/${projectId}/discovery/history?provider=dataforseo`, route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [
      { id: jobId, version: 1, job_kind: "discovery", project_id: projectId, state: "SUCCEEDED", query: "厨房收纳", created_at: "2026-09-21T08:00:00Z", result: {
        coverage: "COVERED", query: "厨房收纳", channel: "AMAZON", market: "US", provider_version: "pilot", batch: { id: "batch-1" },
        items: [{ item_id: "item-1", title: "Fresh market item", external_id: "SKU-1", source_url: "https://example.invalid/item", source_ref: "pilot", channel: "AMAZON", market: "US", is_demo: false }],
      }, batch_metadata: { id: "batch-1", query: "厨房收纳", market: "US", location: "United States", language: "en", collected_at: "2026-09-21T08:00:00Z", item_count: 1 } },
    ] }),
  }));
  await page.route(`**/api/v1/pilot/jobs/${jobId}`, route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ job: {
      id: jobId, version: 1, job_kind: "discovery", state: "SUCCEEDED", query: "厨房收纳",
      result: { coverage: "COVERED", query: "厨房收纳", channel: "AMAZON", market: "US", provider_version: "pilot", batch: { id: "batch-1" }, items: [
        { item_id: "item-1", title: "Fresh market item", external_id: "SKU-1", source_url: "https://example.invalid/item", source_ref: "pilot", channel: "AMAZON", market: "US", is_demo: false },
      ] },
      batch_metadata: { id: "batch-1", query: "厨房收纳", market: "US", location: "United States", language: "en", collected_at: "2026-09-21T08:00:00Z", item_count: 1 }, attempts: [],
    } }),
  }));

  await page.goto(`/projects/${projectId}`);
  await page.getByRole("link", { name: "添加候选" }).first().click();
  await expect(page.getByLabel("已有市场查询批次")).toBeVisible();
  const select = page.getByLabel("已有市场查询批次");
  await expect(select.locator("option")).toHaveCount(2);
  await select.selectOption(jobId);
  await page.getByRole("button", { name: "复用所选历史（不占额度）" }).click();
  await expect(page.getByText("市场查询：已完成")).toBeVisible();
  await expect(page.getByText("Fresh market item")).toBeVisible();
  await expect(page.getByRole("button", { name: /刷新：发起新的外部查询/ })).toBeVisible();
  await expect(page.getByLabel("研究方向", { exact: true })).toHaveValue("厨房收纳");
  expect(discoveryWrites).toEqual([]);
});
