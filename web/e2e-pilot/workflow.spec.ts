import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

type Json = Record<string, unknown>;
type User = Json & { id: string; username: string };
type Workspace = Json & { id: string; name: string; slug: string; role?: string };
type Member = Json & { id: string; role: string };
type Session = Json & { user: User; workspace: Workspace; workspaces: Workspace[]; members: Member[]; csrf_token: string };
type Rule = Json & { field: string; operator: string; threshold: string; unit: string; currency?: string | null };
type Template = Json & { id: string; version: string; channel: string; rules: Rule[]; required_evidence: string[] };
type Project = Json & { id: string; version: number; name: string };
type Candidate = Json & { id: string };
type LoginResult = { status: number; body: Json & { details?: Json & { workspaces?: Workspace[] } } };

const FRONTEND = "http://127.0.0.1:5175";
const ANALYST_PASSWORD = "pilot-e2e-analyst-password";
const OWNER_PASSWORD = "pilot-e2e-owner-password";
let requestNumber = 0;

async function apiGet<T extends Json = Json>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`${FRONTEND}/api/v1${path}`);
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return (await response.json()) as T;
}

async function command<T extends Json = Json>(page: Page, csrf: string, path: string, payload: Json): Promise<T> {
  requestNumber += 1;
  const response = await page.request.post(`${FRONTEND}/api/v1${path}`, {
    data: payload,
    headers: {
      Origin: FRONTEND,
      "X-CSRF-Token": csrf,
      "Idempotency-Key": `pilot-e2e-${Date.now()}-${requestNumber}`,
    },
  });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return (await response.json()) as T;
}

async function submitLogin(page: Page): Promise<LoginResult> {
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/v1/auth/login"));
  await page.getByRole("button", { name: /登录|进入所选工作区/ }).click();
  const response = await responsePromise;
  return { status: response.status(), body: (await response.json()) as LoginResult["body"] };
}

async function login(page: Page, username: "analyst" | "owner", workspace: string): Promise<{ session: Session; csrf: string }> {
  await page.goto("/");
  await page.getByLabel("账号").fill(username);
  await page.getByLabel("口令").fill(username === "analyst" ? ANALYST_PASSWORD : OWNER_PASSWORD);
  let result = await submitLogin(page);
  if (result.status === 409) {
    const choices = result.body.details?.workspaces ?? [];
    const chosen = choices.find((item) => item.name === workspace);
    expect(chosen, `missing workspace choice ${workspace}`).toBeTruthy();
    if (!chosen) throw new Error(`missing workspace choice ${workspace}`);
    await page.getByLabel("工作区").selectOption(chosen.id);
    result = await submitLogin(page);
  }
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const body = result.body as Session;
  return { session: body, csrf: body.csrf_token };
}

async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "退出" }).click();
  await expect(page.getByRole("heading", { name: "登录选品工作台" })).toBeVisible();
}

async function candidateStage(page: Page, stage: "evidence" | "evaluation" | "review"): Promise<void> {
  if (stage === "evidence") {
    await page.getByRole("button", { name: /1\. 收集资料/ }).click();
    return;
  }
  await page.getByRole("button", { name: /2\. 评估与决策/ }).click();
  await page.getByRole("button", { name: stage === "evaluation" ? "评估整理" : "提交与决策" }).click();
}

async function createProject(page: Page, request: APIRequestContext, csrf: string, session: Session): Promise<{ project: Project; csrf: string }> {
  const templates = await apiGet<{ items: Template[] }>(page, "/project-templates");
  const template = templates.items.find((item) => item.channel === "AMAZON");
  expect(template).toBeTruthy();
  const owner = session.members.find((member) => member.role === "decision");
  expect(owner).toBeTruthy();
  if (!template || !owner) throw new Error("pilot E2E seed is missing the Amazon template or decision owner");
  const created = await command<{ project: Project }>(page, csrf, "/projects", {
    actor_id: session.user.id,
    expected_version: null,
    name: `Pilot E2E ${Date.now()}`,
    channel: "AMAZON",
    market: "US",
    direction: "户外露营",
    goal: "离线可控 provider 的真实试点闭环",
    constraints: ["仅使用受控测试来源"],
    analyst_id: session.user.id,
    decision_owner_id: owner.id,
  });
  const project = created.project;
  // Criteria confirmation is a decision-owner action.  Keep its API session
  // in the isolated request fixture so the browser remains the analyst.
  const ownerLoginResponse = await request.post(`${FRONTEND}/api/v1/auth/login`, {
    data: { username: "owner", password: OWNER_PASSWORD, workspace_id: session.workspace.id },
    headers: { Origin: FRONTEND },
  });
  expect(ownerLoginResponse.ok(), await ownerLoginResponse.text()).toBeTruthy();
  const ownerLogin = await ownerLoginResponse.json() as Session;
  const ownerCriteriaResponse = await request.post(`${FRONTEND}/api/v1/projects/${project.id}/criteria-revisions`, {
    data: {
    actor_id: ownerLogin.user.id,
    expected_version: project.version,
    template_id: template?.id,
    template_version: template?.version,
    parent_revision_id: null,
    rules: template.rules.map((rule) => ({ field: rule.field, operator: rule.operator, threshold: rule.threshold, unit: rule.unit, currency: rule.currency ?? null })),
    required_evidence: template.required_evidence,
    },
    headers: { Origin: FRONTEND, "X-CSRF-Token": ownerLogin.csrf_token, "Idempotency-Key": `pilot-e2e-criteria-${Date.now()}` },
  });
  expect(ownerCriteriaResponse.ok(), await ownerCriteriaResponse.text()).toBeTruthy();
  const confirmed = await ownerCriteriaResponse.json() as { project: Project };
  return { project: confirmed.project, csrf };
}

async function addVerifiedEvidence(page: Page, field: string, value: string): Promise<void> {
  const evidenceDetails = page.locator("#legacy-evidence-form");
  const summary = evidenceDetails.locator("summary");
  if (!(await evidenceDetails.locator("input").first().isVisible())) await summary.click();
  const evidenceType = evidenceDetails.getByRole("combobox", { name: "资料类型", exact: true });
  await expect(evidenceType).toBeVisible();
  await evidenceType.selectOption(field);
  await evidenceDetails.getByLabel("值", { exact: true }).fill(value);
  await evidenceDetails.getByLabel("单位", { exact: true }).fill(field === "moq" ? "unit" : "item");
  await evidenceDetails.getByLabel("币种", { exact: true }).fill(field === "procurement_cost" ? "USD" : "");
  await evidenceDetails.getByLabel("来源定位", { exact: true }).fill(`pilot-e2e:${field}`);
  await evidenceDetails.getByLabel("观察时间", { exact: true }).fill("2026-09-20T08:00");
  await evidenceDetails.getByLabel("有效至", { exact: true }).fill("2099-09-20T08:00");
  await evidenceDetails.locator("label.field", { hasText: "核验状态" }).locator("select").selectOption("VERIFIED");
  await evidenceDetails.locator("textarea").fill(`Pilot E2E owner checked ${field} against supplier quote.`);
  const saveResponse = page.waitForResponse((response) => response.url().includes("/api/v1/candidates/") && response.url().endsWith("/evidence") && response.request().method() === "POST");
  await evidenceDetails.getByRole("button", { name: "保存证据版本" }).click();
  const response = await saveResponse;
  expect(response.ok(), `${response.url()}: ${await response.text()}`).toBeTruthy();
  await candidateStage(page, "evidence");
  const rawEvidence = page.locator("#raw-evidence");
  if (await rawEvidence.getAttribute("open") === null) await rawEvidence.locator(":scope > summary").click();
  await expect(page.getByRole("cell", { name: `pilot-e2e:${field}`, exact: true })).toBeVisible();
  await expect(evidenceDetails.getByRole("button", { name: "保存证据版本" })).toBeEnabled();
}

test.describe.serial("pilot browser workflow", () => {
  test("login → discovery → evidence → model draft → approval → validation → result → next criteria", async ({ page, request }) => {
    test.setTimeout(240_000);
    const loggedIn = await login(page, "analyst", "Partner E2E Workspace");
    const csrf = loggedIn.csrf;
    const session = loggedIn.session;
    const { project } = await createProject(page, request, csrf, session);

    await page.goto(`/projects/${project.id}`);
    await expect(page.getByRole("heading", { name: project.name })).toBeVisible();
    await page.getByRole("link", { name: "添加候选" }).first().click();
    await page.getByRole("tab", { name: "按方向发现" }).click();
    await page.getByLabel("研究方向", { exact: true }).fill("户外露营");

    // Drive discovery through the same browser action as a user. The UI stores
    // the queued job and polls it before rendering the controlled result.
    const discoveryResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/projects/${project.id}/discovery`)
      && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: /刷新：发起新的外部查询/ }).click();
    const discoveryResponse = await discoveryResponsePromise;
    expect(discoveryResponse.ok(), `${discoveryResponse.url()}: ${await discoveryResponse.text()}`).toBeTruthy();
    await expect(page.getByText("Pilot E2E camping lamp", { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.locator('input[type="checkbox"]').first().check();
    await page.getByRole("button", { name: /纳入已选择候选/ }).click();
    await expect(page.getByText(/已纳入 1 个候选/)).toBeVisible();
    const detail = await apiGet<{ candidates: Candidate[] }>(page, `/projects/${project.id}`);
    const candidate = detail.candidates[0];
    expect(candidate).toBeTruthy();
    await page.goto(`/candidates/${candidate.id}`);

    await addVerifiedEvidence(page, "moq", "100");
    await addVerifiedEvidence(page, "procurement_cost", "20");
    await candidateStage(page, "evidence");
    await page.getByRole("button", { name: "按当前证据重新初筛" }).click();
    await page.getByText("查看正式初筛结果与规则", {exact:true}).click();
    await expect(page.getByText(/缺口：无/)).toBeVisible();

    await candidateStage(page, "evaluation");
    await page.getByRole("button", { name: "整理评估草稿" }).click();
    await expect(page.getByText("Pilot offline model draft; review before adoption.")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "复制到人工修订草稿" }).click();
    await page.getByText(/人工修订并保存新版本|检查并保存评估快照/, { exact: true }).click();
    await page.getByRole("button", { name: "保存人工评估版本" }).click();
    await expect(page.getByText(/已保存(新的人工修订版本|第一版评估快照)/)).toBeVisible();

    await candidateStage(page, "review");
    await page.getByRole("button", { name: "提交当前评估" }).click();
    await expect(page.getByText(/当前评估已提交给决策负责人/)).toBeVisible();

    await logout(page);
    await login(page, "owner", "Partner E2E Workspace");
    await page.goto(`/candidates/${candidate.id}?stage=review`);
    await candidateStage(page, "review");
    await page.getByRole("radio", { name: /批准进入验证/ }).check();
    await page.getByLabel("决定理由", { exact: true }).fill("Pilot E2E evidence reviewed; continue to validation.");
    await page.getByRole("button", { name: /确认批准进入验证/ }).click();
    await expect(page.getByText(/验证中/).first()).toBeVisible();

    await page.goto(`/tasks?candidate_id=${candidate.id}`);
    await page.getByRole("button", { name: "新建任务" }).click();
    await page.locator("label.field", { hasText: "任务类型" }).locator("select").selectOption("EVIDENCE");
    await page.locator("label.field", { hasText: "需要补充的证据" }).locator("select").selectOption("moq");
    await page.getByLabel("验证问题", { exact: true }).fill("确认供应商 MOQ 仍适用于本批次。");
    await page.getByLabel("截止日期", { exact: true }).fill("2099-12-31T00:00");
    await page.getByLabel("完成条件", { exact: true }).fill("保留当前已核验的 MOQ 证据。");
    await page.getByRole("button", { name: "创建任务" }).click();
    const evidenceItem = page.locator("li[data-work-id]").filter({ hasText: "确认供应商 MOQ 仍适用于本批次。" });
    await expect(evidenceItem).toBeVisible();
    await evidenceItem.locator('a[href^="/tasks?"][href*="task_id="]').click();
    const transition = page.locator('section[aria-labelledby="transition-task-title"]');
    await transition.locator("select").selectOption("IN_PROGRESS");
    await transition.getByRole("button", { name: "保存" }).click();
    await expect(transition).toHaveCount(0);
    await expect(evidenceItem).toContainText("进行中");
    await evidenceItem.locator('a[href^="/tasks?"][href*="task_id="]').click();
    await transition.locator("select").selectOption("DONE");
    await transition.locator('textarea[name="result"]').fill("Supplier confirmed MOQ 100 units.");
    await transition.locator('input[name="evidence_ids"]').first().check();
    await transition.locator('select[name="target_met"]').selectOption("true");
    await transition.getByRole("button", { name: "保存" }).click();
    await expect(page.locator("li[data-work-id]").filter({ hasText: "确认供应商 MOQ 仍适用于本批次。" })).toHaveCount(0);

    await page.getByRole("button", { name: "记录验证结论" }).click();
    const conclusion = page.locator('section[aria-labelledby="conclusion-title"]');
    await conclusion.locator('select[name="action"]').selectOption("FOLLOW_UP");
    await conclusion.locator('textarea[name="reason"]').fill("验证任务完成，进入结果跟进。");
    const conclusionSaved = page.waitForResponse(response => response.url().endsWith("/validation-conclusions") && response.request().method() === "POST");
    await conclusion.getByRole("button", { name: "提交结论" }).click();
    expect((await conclusionSaved).ok()).toBeTruthy();
    await expect(page.getByText(/待回填结果|结果跟进/).first()).toBeVisible();

    await page.goto(`/candidates/${candidate.id}/outcomes`);
    await page.getByLabel("该商品未上市", { exact: true }).check();
    await page.getByLabel("未上市原因", { exact: true }).fill("Pilot E2E listing was not launched during the observation window.");
    await page.getByLabel("数据来源定位", { exact: true }).fill("pilot-e2e:listing-status");
    await page.getByRole("button", { name: "保存结果" }).click();
    await expect(page.getByText("未上市", { exact: true }).first()).toBeVisible();

    await page.getByRole("tab", { name: "比较与复盘" }).click();
    await page.getByRole("button", { name: "提出调整" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("阈值", { exact: true }).first().fill("80");
    await dialog.getByLabel("调整依据", { exact: true }).fill("未上市反馈：降低首轮 MOQ 门槛。");
    await dialog.getByRole("button", { name: "提交建议" }).click();
    await expect(page.getByText("未上市反馈：降低首轮 MOQ 门槛。", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "确认建议" }).click();
    await expect(page.getByText(/调整建议已确认/)).toBeVisible();
    await page.getByRole("link", { name: "基于这条反馈创建新项目" }).click();
    const projectForm = page.locator("form.project-form");
    const projectName = projectForm.getByLabel("项目名称", { exact: true });
    for (let attempt = 0; attempt < 2 && !(await projectName.isVisible()); attempt += 1) {
      await page.getByRole("button", { name: "新建项目" }).click();
    }
    await expect(projectName).toBeVisible();
    await projectName.fill("Pilot E2E next criteria project");
    await expect(projectForm.locator("label.field", { hasText: "目标市场" }).locator("select")).toHaveValue("US");
    await projectForm.getByLabel("研究方向", { exact: true }).fill("户外露营");
    await projectForm.getByLabel("项目目标", { exact: true }).fill("采用反馈后的新标准");
    await projectForm.getByRole("button", { name: "下一步：安排负责人" }).click();
    await page.locator("form.project-form").getByRole("button", { name: "创建并收集候选" }).click();
    await expect(page.getByRole("heading", { name: "Pilot E2E next criteria project" })).toBeVisible();
    await page.goto("/observations");
    await expect(page.getByText("经营闭环 1 条 · 研究回流 0 条", { exact: true })).toBeVisible();
    await page.screenshot({ path: "/private/tmp/product-res-pilot-e2e.png", fullPage: true });
  });

  test("workspace switching, logout, and missing provider state stay isolated", async ({ page }) => {
    const loggedIn = await login(page, "analyst", "Partner E2E Workspace");
    const partnerProjectNames = (await apiGet<{ items: Project[] }>(page, "/projects")).items.map((item) => item.name);
    expect(partnerProjectNames.length).toBeGreaterThan(0);
    const internal = loggedIn.session.workspaces.find((item) => item.slug === "internal-e2e");
    expect(internal).toBeTruthy();
    if (!internal) throw new Error("pilot E2E seed is missing the internal workspace");
    const switchResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/auth/switch-workspace"));
    await page.getByRole("combobox", { name: "工作区", exact: true }).selectOption(internal.id);
    const switched = await (await switchResponse).json() as Session;
    await expect.poll(async () => (await apiGet<{ items: Json[] }>(page, "/projects")).items.length).toBe(0);
    const sources = await apiGet<{ items: Json[] }>(page, "/pilot/sources");
    expect(sources.items.filter((item) => item.id !== "newapi").every((item) => item.status === "NOT_CONFIGURED")).toBeTruthy();
    expect(switched.workspace.slug).toBe("internal-e2e");
    for (const name of partnerProjectNames) await expect(page.getByText(name, { exact: true })).toHaveCount(0);
    await logout(page);
    await expect(page.getByText("团队试点")).toBeVisible();
  });
});
