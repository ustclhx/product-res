import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const FRONTEND = "http://127.0.0.1:5175";
const ANALYST_PASSWORD = "pilot-e2e-analyst-password";
const OWNER_PASSWORD = "pilot-e2e-owner-password";
const WORKSPACE = "Partner E2E Workspace";
type Json = Record<string, unknown>;
type Workspace = Json & { id: string; name: string; slug: string };
type Member = Json & { id: string; role: string };
type Session = Json & { user: { id: string; username: string }; workspace: Workspace; members: Member[]; csrf_token: string };
type Project = Json & { id: string; name: string; version: number; source_feedback_id?: string | null; current_criteria_id?: string };
type Candidate = Json & { id: string; title: string; version: number; business_status: string; approval_id?: string | null };
type LoginBody = Json & { details?: Json & { workspaces?: Workspace[] } };

let requestNumber = 0;

async function command<T extends Json>(page: Page, csrf: string, path: string, payload: Json): Promise<T> {
  requestNumber += 1;
  const response = await page.request.post(`${FRONTEND}/api/v1${path}`, {
    data: payload,
    headers: { Origin: FRONTEND, "X-CSRF-Token": csrf, "Idempotency-Key": `pilot-e2e-research-${Date.now()}-${requestNumber}` },
  });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return await response.json() as T;
}

async function login(page: Page, username: "analyst" | "owner"): Promise<Session> {
  await page.goto("/observations");
  await page.getByLabel("账号").fill(username);
  await page.getByLabel("口令").fill(username === "analyst" ? ANALYST_PASSWORD : OWNER_PASSWORD);
  const submit = async () => {
    const pending = page.waitForResponse(response => response.url().endsWith("/api/v1/auth/login") && response.request().method() === "POST");
    await page.getByRole("button", { name: /登录|进入所选工作区/ }).click();
    const response = await pending;
    return { status: response.status(), body: await response.json() as LoginBody };
  };
  let result = await submit();
  if (result.status === 409) {
    const workspace = result.body.details?.workspaces?.find(item => item.name === WORKSPACE);
    expect(workspace, `missing workspace ${WORKSPACE}`).toBeTruthy();
    if (!workspace) throw new Error(`missing workspace ${WORKSPACE}`);
    await page.getByLabel("工作区").selectOption(workspace.id);
    result = await submit();
  }
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body as Session;
}

async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "退出" }).click();
  await expect(page.getByRole("heading", { name: "登录选品工作台" })).toBeVisible();
}

async function createEmptyRulesResearchCandidate(page: Page, request: APIRequestContext, analyst: Session): Promise<{ project: Project; candidate: Candidate; csrf: string }> {
  const csrf = analyst.csrf_token;
  const templatesResponse = await page.request.get(`${FRONTEND}/api/v1/project-templates`);
  expect(templatesResponse.ok(), await templatesResponse.text()).toBeTruthy();
  const templates = await templatesResponse.json() as { items: Array<Json & { id: string; version: string; channel: string }> };
  const template = templates.items.find(item => item.channel === "AMAZON");
  const owner = analyst.members.find(member => member.role === "decision");
  expect(template, "Amazon template missing from isolated pilot seed").toBeTruthy();
  expect(owner, "decision owner missing from isolated pilot seed").toBeTruthy();
  if (!template || !owner) throw new Error("pilot E2E setup is missing a template or decision owner");

  const projectResult = await command<{ project: Project }>(page, csrf, "/projects", {
    actor_id: analyst.user.id, expected_version: null,
    name: `Research closure ${Date.now()}`, channel: "AMAZON", market: "US",
    direction: "OEM 后备箱收纳", goal: "仅验证研究结论和学习回流", constraints: ["离线 E2E 测试资料"],
    analyst_id: analyst.user.id, decision_owner_id: owner.id,
  });
  const project = projectResult.project;
  const ownerLoginResponse = await request.post(`${FRONTEND}/api/v1/auth/login`, {
    data: { username: "owner", password: OWNER_PASSWORD, workspace_id: analyst.workspace.id }, headers: { Origin: FRONTEND },
  });
  expect(ownerLoginResponse.ok(), await ownerLoginResponse.text()).toBeTruthy();
  const ownerSession = await ownerLoginResponse.json() as Session;
  requestNumber += 1;
  const criteriaResponse = await request.post(`${FRONTEND}/api/v1/projects/${project.id}/criteria-revisions`, {
    data: {
      actor_id: ownerSession.user.id, expected_version: project.version, template_id: template.id,
      template_version: template.version, parent_revision_id: null, rules: [], required_evidence: ["supplier_quote_reference"],
    },
    headers: { Origin: FRONTEND, "X-CSRF-Token": ownerSession.csrf_token, "Idempotency-Key": `pilot-e2e-research-${Date.now()}-${requestNumber}` },
  });
  expect(criteriaResponse.ok(), await criteriaResponse.text()).toBeTruthy();
  const candidateResult = await command<{ candidate: Candidate }>(page, csrf, `/projects/${project.id}/candidates`, {
    actor_id: analyst.user.id, expected_version: project.version + 1, title: "Pilot traceable OEM research candidate",
    external_id: `PILOT-RESEARCH-${Date.now()}`, source_url: "https://pilot-e2e.example/oem/organizer", sku: "PILOT-RESEARCH-001",
  });
  const candidate = candidateResult.candidate;
  await command(page, csrf, `/candidates/${candidate.id}/evidence`, {
    expected_version: candidate.version, field: "supplier_quote_reference", value: "offline supplier quote received",
    unit: "document", currency: null, window: null, source_locator: "pilot-e2e:research-supplier-quote",
    observed_at: "2026-09-20T08:00:00Z", valid_until: "2099-09-20T08:00:00Z", epistemic_kind: "FACT",
    verification: "VERIFIED", verification_note: "Controlled test evidence attached for research flow only.",
  });
  return { project, candidate, csrf };
}

test("empty-rule OEM candidate completes a research feedback cycle without commercial approval", async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const analyst = await login(page, "analyst");
  const { candidate } = await createEmptyRulesResearchCandidate(page, request, analyst);
  const aggregateResponse = await page.request.get(`${FRONTEND}/api/v1/candidates/${candidate.id}`);
  expect(aggregateResponse.ok(), await aggregateResponse.text()).toBeTruthy();
  const before = await aggregateResponse.json() as { candidate: Candidate; criteria: { rules: Json[]; required_evidence: string[] } | null; sources: Array<Json & { source_url?: string }> };
  expect(before.criteria?.rules).toEqual([]);
  expect(before.criteria?.required_evidence).toEqual(["supplier_quote_reference"]);
  expect(before.sources.some(source => source.source_url === "https://pilot-e2e.example/oem/organizer")).toBeTruthy();

  await page.getByRole("button", { name: /退出/ }).click();
  await login(page, "owner");
  await page.goto(`/candidates/${candidate.id}?stage=research`);
  await expect(page.getByRole("button", { name: /2\. 评估与决策/ })).toHaveAttribute("aria-current", "step");
  await expect(page.locator("details[open]").filter({ has: page.getByText("观察、停止与研究反馈", { exact: true }) })).toBeVisible();
  const panel = page.locator("section.research-panel");
  await expect(panel.getByRole("heading", { name: "研究处置" })).toBeVisible();
  await expect(panel.getByText("0 条规则 · 1 项必需材料")).toBeVisible();
  await panel.getByText("记录停止或暂缓结论").click();
  const conclusionForm = panel.locator("form.research-form");
  await conclusionForm.getByLabel("研究处置").selectOption("HOLD");
  await conclusionForm.getByLabel("资料类型").selectOption("TEST");
  await conclusionForm.getByLabel("来源定位").fill("pilot-e2e:offline-supplier-quote");
  await conclusionForm.getByLabel("判断原因").fill("Supplier conditions are incomplete for a responsible sample decision.");
  await conclusionForm.getByLabel("下一轮启示").fill("Collect a sample MOQ and a target-vehicle sample before resuming.");
  await conclusionForm.locator('input[name="evidence_ids"]').check();
  await conclusionForm.locator('input[name="source_ids"]').check();
  await page.screenshot({ path: "/private/tmp/product-res-research-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/private/tmp/product-res-research-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  const conclusionResponsePromise = page.waitForResponse(response => response.url().endsWith(`/api/v1/candidates/${candidate.id}/research-conclusions`) && response.request().method() === "POST");
  await conclusionForm.getByRole("button", { name: "保存研究结论" }).click();
  const conclusionResponse = await conclusionResponsePromise;
  expect(conclusionResponse.ok(), await conclusionResponse.text()).toBeTruthy();
  await expect(panel.getByText("研究结论已记录。候选商业状态、批准和经营结果均未改变。")).toBeVisible();
  await expect(panel.getByText(/暂缓.*Supplier conditions are incomplete/)).toBeVisible();
  await expect(panel.getByText(/来源 pilot-e2e:offline-supplier-quote · TEST · 冻结证据 1 项/)).toBeVisible();
  const afterConclusionResponse = await page.request.get(`${FRONTEND}/api/v1/candidates/${candidate.id}`);
  const afterConclusion = await afterConclusionResponse.json() as { candidate: Candidate; decisions: Json[]; outcomes: Json[] };
  expect(afterConclusion.candidate.business_status).toBe(before.candidate.business_status);
  expect(afterConclusion.candidate.approval_id ?? null).toBeNull();
  expect(afterConclusion.decisions ?? []).toEqual([]);
  expect(afterConclusion.outcomes ?? []).toEqual([]);

  await logout(page);
  await login(page, "analyst");
  await page.goto(`/candidates/${candidate.id}?stage=research`);
  const analystPanel = page.locator("section.research-panel");
  await analystPanel.getByText("提出下一项目反馈").click();
  const feedbackForm = analystPanel.locator(".research-history form");
  await feedbackForm.getByLabel("必需材料（每行一项）").fill("sample_moq\ntarget_vehicle_sample");
  await feedbackForm.getByLabel("可继承的研究启示").fill("Collect a sample MOQ and a target-vehicle sample before resuming.");
  await feedbackForm.getByLabel("调整依据").fill("Add sample requirements while preserving the research learning.");
  const feedbackResponsePromise = page.waitForResponse(response => response.url().includes("/feedback-proposals") && response.request().method() === "POST");
  await feedbackForm.getByRole("button", { name: "提交回流建议" }).click();
  const feedbackResponse = await feedbackResponsePromise;
  expect(feedbackResponse.ok(), await feedbackResponse.text()).toBeTruthy();
  const feedbackCard = analystPanel.locator(".feedback-card");
  await expect(feedbackCard.getByText("待确认")).toBeVisible();
  await expect(feedbackCard).toContainText("sample_moq");
  await expect(feedbackCard).toContainText("target_vehicle_sample");
  await logout(page);
  await login(page, "owner");
  await page.goto(`/candidates/${candidate.id}?stage=research`);
  const ownerPanel = page.locator("section.research-panel");
  const ownerFeedbackCard = ownerPanel.locator(".feedback-card");
  await expect(ownerFeedbackCard.getByText("待确认")).toBeVisible();
  await ownerFeedbackCard.getByRole("button", { name: "确认建议" }).click();
  await expect(ownerFeedbackCard.getByText("已确认")).toBeVisible();
  const researchResponse = await page.request.get(`${FRONTEND}/api/v1/candidates/${candidate.id}/research`);
  const research = await researchResponse.json() as { conclusions: Array<{ id: string }>; feedback: Array<{ id: string; status: string; after_required_evidence: string[] }> };
  expect(research.conclusions).toHaveLength(1);
  const accepted = research.feedback[0];
  expect(accepted.status).toBe("CONFIRMED");
  expect(accepted.after_required_evidence).toEqual(["sample_moq", "target_vehicle_sample"]);

  const adoptionLink = ownerPanel.getByRole("link", { name: "基于这条反馈创建新项目" });
  await expect(adoptionLink).toBeVisible();
  await adoptionLink.click();
  const projectForm = page.locator("form.project-form");
  await expect(page.getByText("新项目将继承已确认的复盘标准；创建后可直接开始收集候选。")).toBeVisible();
  await projectForm.getByLabel("项目名称").fill("Pilot E2E adopted research learning");
  await projectForm.getByLabel("研究方向").fill("OEM 后备箱收纳");
  await projectForm.getByLabel("项目目标").fill("采用研究反馈验证样品条件");
  await projectForm.getByRole("button", { name: "下一步：安排负责人" }).click();
  const ownerStep = page.locator("form.project-form");
  const adoptedProjectResponsePromise = page.waitForResponse(response => response.url().endsWith("/api/v1/projects") && response.request().method() === "POST");
  await ownerStep.getByRole("button", { name: "创建并收集候选" }).click();
  const adoptedProjectResponse = await adoptedProjectResponsePromise;
  expect(adoptedProjectResponse.ok(), await adoptedProjectResponse.text()).toBeTruthy();
  const adoptedProjectBody = await adoptedProjectResponse.json() as { project: Project };
  expect(adoptedProjectBody.project.source_feedback_id).toBe(accepted.id);
  await expect(page.getByRole("heading", { name: "Pilot E2E adopted research learning" })).toBeVisible();

  const adoptedDetailsResponse = await page.request.get(`${FRONTEND}/api/v1/projects/${adoptedProjectBody.project.id}`);
  expect(adoptedDetailsResponse.ok(), await adoptedDetailsResponse.text()).toBeTruthy();
  const adoptedDetails = await adoptedDetailsResponse.json() as { project: Project; criteria_versions: Array<{ id: string; rules: Json[]; required_evidence: string[]; research_learning?: string }> };
  const adoptedCriteria = adoptedDetails.criteria_versions.find(item => item.id === adoptedDetails.project.current_criteria_id);
  expect(adoptedDetails.project.source_feedback_id).toBe(accepted.id);
  expect(adoptedCriteria?.rules).toEqual([]);
  expect(adoptedCriteria?.required_evidence).toEqual(["sample_moq", "target_vehicle_sample"]);

  await page.goto("/observations");
  await expect(page.getByText("经营闭环 0 条 · 研究回流 0 条")).toBeVisible();
  const progressRow = page.locator(".progress-list li").filter({ hasText: candidate.title });
  await expect(progressRow).toContainText("经营闭环还缺");
  await expect(progressRow).toContainText("研究回流：待研究结论");
  const closureResponse = await page.request.get(`${FRONTEND}/api/v1/candidates/${candidate.id}/research`);
  const closure = await closureResponse.json() as { closure: { adopted_feedback_count: number } };
  expect(closure.closure.adopted_feedback_count).toBe(1);
  await expect(progressRow).not.toContainText("经营闭环材料齐全");
});
