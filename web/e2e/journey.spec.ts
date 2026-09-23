import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

type Json = Record<string, unknown>;
type Project = Json & { id: string; version: number };
type Candidate = Json & { id: string; version: number };
let commandNumber = 0;

async function apiGet<T extends Json>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`/api/v1${path}`);
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return (await response.json()) as T;
}

async function command<T extends Json>(request: APIRequestContext, path: string, actorId: string, expectedVersion: number | null, payload: Json): Promise<T> {
  commandNumber += 1;
  const response = await request.post(`/api/v1${path}`, {
    data: { actor_id: actorId, expected_version: expectedVersion, ...payload },
    headers: { "Idempotency-Key": `journey-e2e-${Date.now()}-${commandNumber}` },
  });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return (await response.json()) as T;
}

async function actor(page: Page, value: "analyst" | "owner"): Promise<void> {
  await page.evaluate((next) => localStorage.setItem("product-res-actor", next), value);
  await page.reload();
}

test("guided project creation saves a draft, opens criteria, and respects the decision role", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const name = `Journey E2E ${Date.now()}`;
  await page.goto("/projects?new=1");
  await expect(page.getByRole("heading", { name: "新建选品项目" })).toBeVisible();
  await expect(page.getByText("第 1 步，共 2 步")).toBeVisible();

  await page.getByLabel("项目名称", { exact: true }).fill(name);
  await page.getByLabel("目标市场", { exact: true }).fill("US");
  await page.getByLabel("研究方向", { exact: true }).fill("户外收纳");
  await page.getByLabel("项目目标", { exact: true }).fill("核实适合小批量验证的商品方向。");
  await page.getByLabel("限制条件", { exact: true }).fill("只保存可追溯材料");
  await page.getByRole("button", { name: "下一步：安排负责人" }).click();

  await expect(page.getByText("第 2 步，共 2 步")).toBeVisible();
  await expect(page.getByText("首次确认前建议核对的材料")).toBeVisible();
  await expect(page.getByText(/不会自动确认标准，也不会发起外部查询/)).toBeVisible();
  await page.getByRole("button", { name: "返回修改" }).click();
  await expect(page.getByLabel("项目名称", { exact: true })).toHaveValue(name);
  await page.getByRole("button", { name: "下一步：安排负责人" }).click();
  await page.getByRole("button", { name: "保存草稿并确认标准" }).click();

  await expect(page).toHaveURL(/\/projects\/[^/?]+\?view=criteria$/);
  const projectId = new URL(page.url()).pathname.split("/").at(-1)!;
  await expect(page.getByRole("heading", { name })).toBeVisible();
  const detail = await apiGet<Json & { project: Json & { current_criteria_id?: string | null } }>(request, `/projects/${projectId}`);
  expect(detail.project.current_criteria_id).toBeFalsy();

  const beginConfirmation = page.getByRole("button", { name: "开始确认" });
  await expect(beginConfirmation).toBeDisabled();
  await expect(page.getByText(/等待决策负责人/)).toBeVisible();
  await actor(page, "owner");
  await page.getByRole("button", { name: "开始确认" }).click();
  await expect(page.getByRole("button", { name: "确认并保存标准" })).toBeEnabled();
  await page.getByRole("button", { name: "确认并保存标准" }).click();
  await expect(page.getByText(/标准已确认。现在/)).toBeVisible();
  await page.goto(`/projects/${projectId}?intake=1`);
  await expect(page.getByRole("heading", { name: "候选清单" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "把机会纳入候选池" })).toBeVisible();
});

test("one assigned field task keeps one identity across work surfaces and quote deep links open the quote form", async ({ page, request }) => {
  const templates = await apiGet<{ items: Array<Json & { id: string; version: string; channel: string }> }>(request, "/project-templates");
  const template = templates.items.find((item) => item.channel === "AMAZON");
  expect(template).toBeTruthy();
  if (!template) throw new Error("Amazon template is missing");

  const created = await command<{ project: Project }>(request, "/projects", "analyst", null, {
    name: `Journey work items ${Date.now()}`, channel: "AMAZON", market: "US", direction: "户外收纳",
    goal: "核验报价与 MOQ", constraints: [], analyst_id: "analyst", decision_owner_id: "owner",
  });
  const confirmed = await command<{ project: Project }>(request, `/projects/${created.project.id}/criteria-revisions`, "owner", created.project.version, {
    template_id: template.id, template_version: template.version, parent_revision_id: null, rules: [], required_evidence: ["procurement_cost", "moq"],
  });
  const added = await command<{ candidate: Candidate }>(request, `/projects/${created.project.id}/candidates`, "analyst", confirmed.project.version, {
    title: "Journey E2E supplier quote candidate", external_id: `JOURNEY-${Date.now()}`,
    source_url: "https://example.invalid/journey/quote", sku: "JOURNEY-QUOTE-01",
  });
  const question = "Journey E2E collect supplier quote";
  const task = await command<{ item: Json & { id: string } }>(request, `/candidates/${added.candidate.id}/tasks`, "analyst", added.candidate.version, {
    type: "EVIDENCE", field: "procurement_cost", question, owner_id: "analyst",
    due_at: "2099-12-31T00:00:00Z", completion_criteria: "保留可追溯供应商报价和核验结果。", expected_metrics: {},
  });

  const items = await apiGet<{ items: Array<Json & { id: string; candidate_id: string | null; task_id: string | null; field: string | null }> }>(request, "/work-items");
  const matching = items.items.filter((item) => item.candidate_id === added.candidate.id && item.field === "procurement_cost");
  expect(matching).toHaveLength(1);
  expect(matching[0]?.task_id).toBe(task.item.id);
  const workId = String(matching[0]?.id);

  await page.goto("/");
  const homeItem = page.locator("li[data-work-id]").filter({ hasText: question });
  await expect(homeItem).toHaveAttribute("data-work-id", workId);
  await page.screenshot({path:"/private/tmp/product-res-journey-home-desktop.png", fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:"/private/tmp/product-res-journey-home-mobile.png", fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(`/projects/${created.project.id}?view=tasks`);
  const projectItem = page.locator("li[data-work-id]").filter({ hasText: question });
  await expect(projectItem).toHaveAttribute("data-work-id", workId);
  await page.goto("/tasks");
  const allItemsEntry = page.locator("li[data-work-id]").filter({ hasText: question });
  await expect(allItemsEntry).toHaveAttribute("data-work-id", workId);
  await allItemsEntry.locator("a.action-link").click();
  await expect(page).toHaveURL(new RegExp(`/candidates/${added.candidate.id}.*field=procurement_cost.*task_id=${task.item.id}`));
  await expect(page.getByRole("heading", { name: "录入供应商报价" })).toBeVisible();
  await page.getByRole("link", {name:"更新事项进度"}).click();
  await expect(page.getByRole("heading", { name: question })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: question })).toBeVisible();

  await page.goto(`/candidates/${added.candidate.id}?stage=evidence&field=moq`);
  await expect(page.getByRole("heading", { name: "录入供应商报价" })).toBeVisible();
  await expect(page.getByLabel("供应商名称")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "录入供应商报价" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: question })).toBeVisible();
});
