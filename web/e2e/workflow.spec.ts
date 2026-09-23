import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

type Json = Record<string, unknown>;
type Project = Json & { id: string; version: number; channel: string };
type Candidate = Json & { id: string; version: number; project_id: string };

let requestNo = 0;

async function command<T extends Json = Json>(
  request: APIRequestContext,
  path: string,
  payload: Json = {},
  actor = "analyst",
  expectedVersion: number | null = null,
): Promise<T> {
  requestNo += 1;
  const response = await request.post(`/api/v1${path}`, {
    data: { actor_id: actor, expected_version: expectedVersion, ...payload },
    headers: { "Idempotency-Key": `e2e-${Date.now()}-${requestNo}` },
  });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return (await response.json()) as T;
}

async function getJson<T extends Json = Json>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`/api/v1${path}`);
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return (await response.json()) as T;
}

async function seedProject(request: APIRequestContext, channel: "AMAZON" | "EBAY" | "DTC"): Promise<Project> {
  const templates = await getJson<{ items: Array<Json & { channel: string; id: string; version: string; rules: Json[]; required_evidence: string[] }> }>(request, "/project-templates");
  const template = templates.items.find((item) => item.channel === channel);
  expect(template, `missing ${channel} project template`).toBeTruthy();
  const created = await command<{ project: Project }>(request, "/projects", {
    name: `E2E ${channel} ${Date.now()}-${requestNo}`,
    channel,
    market: "US",
    direction: "户外露营",
    goal: "筛选可进入小批量验证的商品",
    constraints: ["浏览器验收示例"],
    analyst_id: "analyst",
    decision_owner_id: "owner",
  });
  const rules = (template?.rules ?? []).map((rule) => ({
    field: rule.field,
    operator: rule.operator,
    threshold: rule.threshold,
    unit: rule.unit,
    currency: rule.currency ?? null,
  }));
  const confirmed = await command<{ project: Project }>(request, `/projects/${created.project.id}/criteria-revisions`, {
    template_id: template?.id,
    template_version: template?.version,
    rules,
    required_evidence: template?.required_evidence,
    parent_revision_id: null,
  }, "owner", created.project.version);
  return confirmed.project;
}

async function createProjectThroughUi(
  page: Page,
  request: APIRequestContext,
  channel: "AMAZON" | "EBAY" | "DTC",
): Promise<Project> {
  const name = `E2E UI ${channel} ${Date.now()}-${requestNo}`;
  await page.goto("/projects?new=1");
  await actor(page, "analyst");
  await page.getByLabel("项目名称", { exact: true }).fill(name);
  await page.locator("form.project-form select").first().selectOption(channel);
  await page.getByLabel("目标市场", { exact: true }).fill("US");
  await page.getByLabel("研究方向", { exact: true }).fill("户外露营");
  await page.getByLabel("项目目标", { exact: true }).fill("从发现与 CSV 双入口完成选品闭环");
  await page.getByLabel("限制条件", { exact: true }).fill("浏览器验收\n仅使用演示数据");
  await clickButton(page, /下一步：安排负责人/);
  await clickButton(page, /保存草稿并确认标准/);
  await expect(page).toHaveURL(/\/projects\/[^/?]+\?view=criteria$/);
  const createdId = new URL(page.url()).pathname.split("/").at(-1)!;
  const projects = await getJson<{ items: Project[] }>(request, "/projects");
  const created = projects.items.find((item) => item.id === createdId && item.name === name);
  expect(created, `${channel} project should be created through the UI`).toBeTruthy();
  if (!created) throw new Error(`${channel} UI-created project missing from API list`);
  await actor(page, "owner");
  await clickButton(page, /开始确认/);
  await clickButton(page, /确认并保存标准/);
  await expect(page.getByText(/标准已确认。现在/)).toBeVisible();
  const detail = await projectDetail(request, created.id);
  expect(detail.project.current_criteria_id).toBeTruthy();
  return detail.project;
}

async function projectDetail(request: APIRequestContext, projectId: string): Promise<Json & { project: Project; candidates: Candidate[] }> {
  return getJson(request, `/projects/${projectId}`);
}

async function addEvidence(
  request: APIRequestContext,
  candidate: Candidate,
  field: string,
  value: string,
  unit: string,
  currency: string | null,
  supersedesId: string | null = null,
): Promise<{ candidate: Candidate; evidence: Json }> {
  const result = await command<{ candidate: Candidate; evidence: Json }>(request, `/candidates/${candidate.id}/evidence`, {
    field,
    value,
    unit,
    currency,
    window: null,
    source_locator: `e2e:${field}`,
    observed_at: "2026-09-19T08:00:00Z",
    valid_until: "2026-10-20T08:00:00Z",
    epistemic_kind: "FACT",
    verification: "VERIFIED",
    supersedes_id: supersedesId,
    is_demo: true,
  }, "contributor", candidate.version);
  return result;
}

function dimensions(evidenceIds: string[]): Json {
  return Object.fromEntries(["demand", "competition", "differentiation", "supply_cost", "risk"].map((name) => [
    name,
    { summary: `E2E ${name} 判断，仍需人工复核`, evidence_ids: evidenceIds },
  ]));
}

async function makeReady(request: APIRequestContext, candidate: Candidate): Promise<{ candidate: Candidate; evidenceIds: string[] }> {
  const first = await addEvidence(request, candidate, "moq", "100", "unit", null);
  const second = await addEvidence(request, first.candidate, "procurement_cost", "20", "item", "USD");
  const screened = await command<{ candidate: Candidate }>(request, `/candidates/${candidate.id}/screenings`, {}, "analyst", second.candidate.version);
  const moqId = String(first.evidence.id);
  const costId = String(second.evidence.id);
  const evaluated = await command<{ candidate: Candidate }>(request, `/candidates/${candidate.id}/evaluations`, {
    dimensions: dimensions([moqId, costId]),
    evidence_ids: [moqId, costId],
    unknowns: ["竞争样本仍需扩大"],
    counterevidence: [],
    assumptions: ["本次浏览器验收使用示例证据"],
    forecast: {
      currency: "USD",
      window_start: "2026-08-01T00:00:00Z",
      window_end: "2026-09-01T00:00:00Z",
      revenue_basis: "GROSS",
      units: "100",
      metrics: { revenue: "7000", procurement: "2000", platform: "500", fulfillment: "600", advertising: "900", refunds: "100", other: null },
    },
    assistant_versions: {},
    parent_revision_id: null,
  }, "analyst", screened.candidate.version);
  return { candidate: evaluated.candidate, evidenceIds: [moqId, costId] };
}

async function actor(page: Page, value: "analyst" | "owner" | "contributor"): Promise<void> {
  await page.evaluate((next) => localStorage.setItem("product-res-actor", next), value);
  await page.reload();
}

async function clickButton(page: Page, pattern: RegExp): Promise<void> {
  const button = page.getByRole("button", { name: pattern }).first();
  await expect(button).toBeVisible();
  await button.click();
}

async function candidateStage(page: Page, stage: "evidence" | "evaluation" | "review"): Promise<void> {
  if (stage === "evidence") {
    await page.getByRole("button", { name: /1\. 收集资料/ }).click();
    return;
  }
  await page.getByRole("button", { name: /2\. 评估与决策/ }).click();
  await page.getByRole("button", { name: stage === "evaluation" ? "评估整理" : "提交与决策" }).click();
}

async function reviseEvaluationAndApprove(page: Page, candidateId: string): Promise<void> {
  await page.goto(`/candidates/${candidateId}`);
  await actor(page, "analyst");
  await candidateStage(page, "evaluation");
  await page.getByText("人工修订并保存新版本").click();
  await clickButton(page, /保存人工评估版本/);
  await expect(page.getByText(/已保存新的人工修订版本/)).toBeVisible();
  await candidateStage(page, "review");
  await clickButton(page, /提交当前评估/);
  await expect(page.getByText(/当前评估已提交给决策负责人/)).toBeVisible();

  await actor(page, "owner");
  await candidateStage(page, "review");
  await page.getByRole("radio", { name: /批准进入验证/ }).check();
  await page.getByLabel(/决定理由/).fill("证据与评估已核对，进入结果验证。");
  await clickButton(page, /确认批准进入验证/);
  await expect(page.getByText(/验证中/).first()).toBeVisible();
}

async function recordOutcomeAndReview(page: Page, candidateId: string, marker: string): Promise<void> {
  await actor(page, "contributor");
  await page.goto(`/candidates/${candidateId}/outcomes`);
  await page.getByLabel("统计开始日期", { exact: true }).fill("2026-08-01");
  await page.getByLabel("统计结束日期", { exact: true }).fill("2026-09-01");
  await page.getByLabel("币种", { exact: true }).fill("USD");
  await page.getByLabel("销量", { exact: true }).fill("120");
  await page.getByLabel("收入", { exact: true }).fill("7200");
  await page.getByLabel("退款", { exact: true }).fill("360");
  await page.getByLabel("采购成本", { exact: true }).fill("3000");
  await page.getByLabel("平台费用", { exact: true }).fill("1080");
  await page.getByLabel("履约费用", { exact: true }).fill("720");
  await page.getByLabel("广告费用", { exact: true }).fill("600");
  await page.getByLabel("其他费用", { exact: true }).fill("0");
  await page.getByLabel("数据来源定位", { exact: true }).fill(`e2e:${marker}`);
  await page.getByLabel("这是示例数据", { exact: true }).check();
  await clickButton(page, /保存结果/);
  await expect(page.getByText(/结果已保存/)).toBeVisible();
  await page.getByRole("tab", { name: "比较与复盘" }).click();
  await expect(page.getByRole("heading", { name: "预测与实际" })).toBeVisible();
  await page.getByLabel("偏差原因", { exact: true }).fill("浏览器闭环验收：实际销量与预测不同。");
  await page.getByLabel("复盘说明", { exact: true }).fill(`六组合闭环 ${marker}`);
  await clickButton(page, /保存复盘/);
  await expect(page.getByText(/经营结果复盘已保存/)).toBeVisible();
}

test.describe.serial("浏览器验收：三渠道选品闭环", () => {
  test("三渠道均可发现或 CSV 纳入候选，并展示示例标记", async ({ page, request }) => {
    test.setTimeout(480_000);
    const projects = {
      AMAZON: await createProjectThroughUi(page, request, "AMAZON"),
      EBAY: await createProjectThroughUi(page, request, "EBAY"),
      DTC: await createProjectThroughUi(page, request, "DTC"),
    };

    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "选品项目", exact: true })).toBeVisible();
    await expect(page.getByText("Amazon", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("eBay", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("独立站", { exact: false }).first()).toBeVisible();

    await page.goto(`/projects/${projects.AMAZON.id}?intake=1`);
    await expect(page.getByRole("heading", { name: "把机会纳入候选池" })).toBeVisible();
    await page.getByLabel(/当前角色/).selectOption("analyst");
    await page.getByRole("tab", { name: /按方向发现/ }).click();
    await page.getByLabel(/研究方向/).fill("户外露营");
    await clickButton(page, /发现示例候选|发现/);
    await expect(page.getByText(/示例数据|模拟数据|fixture/).first()).toBeVisible();
    const discoveryChoice = page.locator('input[type="checkbox"]').first();
    await expect(discoveryChoice).toBeVisible();
    await discoveryChoice.check();
    await clickButton(page, /纳入已选择候选|纳入候选/);
    await expect(page.getByText(/已纳入 1 个候选/)).toBeVisible();
    const amazonDetail = await projectDetail(request, projects.AMAZON.id);
    expect(amazonDetail.candidates.length).toBeGreaterThan(0);

    const discoveredCandidates: Candidate[] = [amazonDetail.candidates[0]];

    for (const project of [projects.EBAY, projects.DTC]) {
      await page.goto(`/projects/${project.id}?intake=1`);
      await page.getByRole("tab", { name: /按方向发现/ }).click();
      await page.getByLabel(/研究方向/).fill("户外露营");
      await clickButton(page, /发现示例候选|发现/);
      await expect(page.getByText(/示例数据|模拟数据|fixture/).first()).toBeVisible();
      await page.locator('input[type="checkbox"]').first().check();
      await clickButton(page, /纳入已选择候选|纳入候选/);
      await expect(page.getByText(/已纳入 1 个候选/)).toBeVisible();
      const discovered = await projectDetail(request, project.id);
      expect(discovered.candidates.length).toBeGreaterThan(0);
      discoveredCandidates.push(discovered.candidates[0]);
    }

    const csvCandidates: Candidate[] = [];
    for (const project of [projects.AMAZON, projects.EBAY, projects.DTC]) {
      await page.goto(`/projects/${project.id}?intake=1`);
      await page.getByRole("tab", { name: /CSV/ }).click();
      const csv = `title,external_id,source_url,sku\n${project.channel} E2E 候选,${project.channel}-E2E,https://example.invalid/${project.channel.toLowerCase()}/e2e,SKU-${project.channel}`;
      await page.locator("textarea").last().fill(csv);
      await clickButton(page, /生成导入预览|预览/);
      await expect(page.getByText(/有效|VALID/).first()).toBeVisible();
      await clickButton(page, /确认导入所选行/);
      const detail = await projectDetail(request, project.id);
      expect(detail.candidates.length, `${project.channel} should have both discovery and CSV candidates`).toBeGreaterThan(1);
      const imported = detail.candidates.find((item) => item.external_id === `${project.channel}-E2E`);
      expect(imported, `${project.channel} CSV candidate should be persisted`).toBeTruthy();
      csvCandidates.push(imported!);
    }

    for (const candidate of [...discoveredCandidates, ...csvCandidates]) {
      await makeReady(request, candidate);
      await reviseEvaluationAndApprove(page, candidate.id);
      const approved = await getJson<{ candidate: Candidate }>(request, `/candidates/${candidate.id}`);
      const followUp = await command<{ candidate: Candidate }>(request, `/candidates/${candidate.id}/validation-conclusions`, {
        action: "FOLLOW_UP",
        reason: "六组合验收进入结果跟进。",
      }, "owner", approved.candidate.version);
      expect(followUp.candidate.business_status).toBe("OUTCOME_PENDING");
      await recordOutcomeAndReview(page, candidate.id, `${candidate.project_id}-${candidate.id}`);
      const closed = await getJson<Json & { outcomes: Json[] }>(request, `/candidates/${candidate.id}`);
      expect(closed.outcomes.length).toBeGreaterThan(0);
    }
  });

  test("从候选到评估、审批、验证任务和结果反馈，保留退回/恢复记录", async ({ page, request }) => {
    const project = await seedProject(request, "AMAZON");
    const manual = await command<{ candidate: Candidate }>(request, `/projects/${project.id}/candidates`, {
      title: "E2E 闭环候选",
      external_id: `E2E-${Date.now()}`,
      source_url: `https://example.invalid/e2e/${Date.now()}`,
      sku: "E2E-CLOSE-01",
    }, "analyst", project.version);
    const ready = await makeReady(request, manual.candidate);
    const candidateId = ready.candidate.id;

    await page.goto(`/candidates/${candidateId}`);
    await expect(page.getByRole("heading", { name: "E2E 闭环候选" })).toBeVisible();
    await candidateStage(page, "evaluation");
    await expect(page.getByRole("heading", { name: "评估整理" })).toBeVisible();
    await candidateStage(page, "review");
    await clickButton(page, /提交当前评估/);
    await expect(page.getByText(/已提交给决策负责人|待决策/).first()).toBeVisible();

    await actor(page, "owner");
    await candidateStage(page, "review");
    await page.getByRole("radio", { name: /批准进入验证/ }).check();
    await page.getByLabel(/决定理由/).fill("证据与评估已核对，进入小批量验证。");
    await clickButton(page, /确认批准进入验证/);
    await expect(page.getByText(/验证中|VALIDATING/).first()).toBeVisible();

    await actor(page, "contributor");
    await page.goto(`/tasks?candidate_id=${candidateId}`);
    for (const type of ["QUOTE", "SAMPLE", "TEST"]) {
      const question = `E2E ${type} 验证`;
      await clickButton(page, /新建任务/);
      const form = page.locator("section.tasks-editor").filter({ has: page.getByRole("heading", { name: "新建验证任务", exact: true }) });
      await form.getByRole("combobox", { name: "任务类型", exact: true }).selectOption(type);
      await form.getByRole("combobox", { name: /^候选/ }).selectOption(candidateId);
      await form.getByRole("combobox", { name: "负责人", exact: true }).selectOption("contributor");
      await form.getByLabel("验证问题", { exact: true }).fill(question);
      await form.getByLabel("截止日期", { exact: true }).fill("2026-10-01T16:00");
      await form.getByLabel("预期指标", { exact: true }).fill("达到约定指标");
      await form.getByLabel("完成条件", { exact: true }).fill("留下结果和证据");
      await form.getByRole("button", { name: "创建任务", exact: true }).click();
      const workItem = page.locator("li[data-work-id]").filter({ hasText: question });
      await expect(workItem).toBeVisible();
      for (const state of ["IN_PROGRESS", "BLOCKED", "IN_PROGRESS", "DONE"]) {
        if (!(await page.locator("section.tasks-editor").filter({ has: page.getByRole("heading", { name: question, exact: true }) }).isVisible().catch(() => false))) {
          await workItem.locator("a.action-link").click();
        }
        const edit = page.locator("section.tasks-editor").filter({ has: page.getByRole("heading", { name: question, exact: true }) });
        await edit.getByLabel("变更为").selectOption(state);
        if (state === "BLOCKED") await edit.getByLabel("原因", { exact: true }).fill("等待供应商补充回复");
        if (state === "DONE") {
          await edit.getByLabel("实际结果", { exact: true }).fill("已记录实际结果");
          await edit.getByRole("group", { name: "完成依据" }).locator('input[type="checkbox"]').first().check();
          await edit.getByRole("combobox", { name: "目标是否达成" }).selectOption("true");
        }
        await edit.getByRole("button", { name: "保存", exact: true }).click();
        if (state === "DONE") {
          await expect(page.locator("li[data-work-id]").filter({ hasText: question })).toHaveCount(0);
        } else {
          await expect(workItem).toContainText(state === "BLOCKED" ? "受阻" : "进行中");
        }
      }
    }

    await actor(page, "owner");
    await page.goto(`/tasks?candidate_id=${candidateId}`);
    await clickButton(page, /记录验证结论/);
    const conclusion = page.getByRole("region", { name: "记录下一步" });
    await conclusion.getByRole("combobox").selectOption("FOLLOW_UP");
    await conclusion.getByRole("textbox", { name: "判断依据" }).fill("测试记录已完成，进入结果跟进。");
    await conclusion.getByRole("button", { name: /提交结论/ }).click();

    await page.goto(`/candidates/${candidateId}/outcomes`);
    await expect(page.getByRole("heading", { name: /结果闭环|结果回填|E2E 闭环候选/ }).first()).toBeVisible();
    await page.getByLabel("统计开始日期", { exact: true }).fill("2026-08-01");
    await page.getByLabel("统计结束日期", { exact: true }).fill("2026-09-01");
    await page.getByLabel("币种", { exact: true }).fill("USD");
    await page.getByLabel("销量", { exact: true }).fill("120");
    await page.getByLabel("收入", { exact: true }).fill("7200");
    await page.getByLabel("退款", { exact: true }).fill("360");
    await page.getByLabel("采购成本", { exact: true }).fill("3000");
    await page.getByLabel("平台费用", { exact: true }).fill("1080");
    await page.getByLabel("履约费用", { exact: true }).fill("720");
    await page.getByLabel("数据来源定位", { exact: true }).fill("e2e:outcome");
    await page.getByLabel("这是示例数据", { exact: true }).check();
    await clickButton(page, /保存结果/);
    await expect(page.getByRole("tab", { name: "比较与复盘" })).toBeEnabled();
    await page.getByRole("tab", { name: "比较与复盘" }).click();
    await expect(page.getByText(/不可比|实际 7200|实际/).first()).toBeVisible();
    await page.getByLabel("偏差原因").fill("广告费用缺失，其他成本保持可比。");
    await page.getByLabel("复盘说明", { exact: true }).fill("E2E 复盘记录");
    await clickButton(page, /保存复盘/);
    await clickButton(page, /提出调整/);
    await page.locator(".rule-editors fieldset").first().getByLabel("阈值", { exact: true }).fill("180");
    await page.getByLabel("调整依据", { exact: true }).fill("根据结果复盘调整下一轮 MOQ 阈值。");
    await clickButton(page, /提交建议/);
    await expect(page.getByRole("button", { name: "确认建议" })).toBeVisible();
    await page.getByRole("button", { name: "确认建议" }).click();
    const confirmed = await getJson<Json & { feedback: Array<Json> }>(request, `/candidates/${candidateId}`);
    expect(confirmed.feedback.at(-1)?.status).toBe("CONFIRMED");
    const feedback = confirmed.feedback.at(-1)!;
    await page.getByRole("link", { name: "基于这条反馈创建新项目" }).click();
    const nextName = `E2E 下一轮 ${Date.now()}`;
    await page.getByLabel("项目名称", { exact: true }).fill(nextName);
    await page.getByLabel("目标市场", { exact: true }).fill("US");
    await page.getByLabel("研究方向", { exact: true }).fill("户外露营");
    await page.getByLabel("项目目标", { exact: true }).fill("验证反馈后新标准");
    await clickButton(page, /下一步：安排负责人/);
    await clickButton(page, /创建并收集候选/);
    await expect(page).toHaveURL(/\/projects\/[^/?]+\?intake=1$/);
    const allProjects = await getJson<{ items: Project[] }>(request, "/projects");
    const nextProject = allProjects.items.find(item => item.name === nextName)!;
    expect(nextProject.source_feedback_id).toBe(feedback.id);
    const nextDetail = await getJson<{ criteria_versions: Json[] }>(request, `/projects/${nextProject.id}`);
    expect(nextDetail.criteria_versions[0].rules).toEqual(feedback.after_rules);
    const originalDetail = await projectDetail(request, project.id);
    expect(originalDetail.project.current_criteria_id).toBe(project.current_criteria_id);
    const preserved = await getJson<{ decisions: Json[] }>(request, `/candidates/${candidateId}`);
    expect(preserved.decisions.find(item => item.action === "APPROVE")?.criteria_id).toBe(project.current_criteria_id);


    const excluded = await command<{ candidate: Candidate }>(request, `/projects/${project.id}/candidates`, {
      title: "E2E 需要人工恢复",
      external_id: `E2E-EXCLUDED-${Date.now()}`,
      source_url: `https://example.invalid/e2e/excluded/${Date.now()}`,
    }, "analyst", (await projectDetail(request, project.id)).project.version);
    const badEvidence = await addEvidence(request, excluded.candidate, "moq", "500", "unit", null);
    const badCost = await addEvidence(request, badEvidence.candidate, "procurement_cost", "20", "item", "USD");
    const screened = await command<{ candidate: Candidate; screening: Json }>(request, `/candidates/${excluded.candidate.id}/screenings`, {}, "analyst", badCost.candidate.version);
    expect(screened.screening.status).toBe("EXCLUDED");
    await page.goto(`/candidates/${excluded.candidate.id}`);
    await actor(page, "owner");
    await candidateStage(page, "evidence");
    await expect(page.getByText(/排除|不符合/).first()).toBeVisible();
    const override = page.locator("details.panel").filter({ hasText: "记录人工例外恢复" });
    await override.getByText("记录人工例外恢复", { exact: true }).click();
    await override.locator('input[type="checkbox"]').first().check();
    await override.getByLabel("恢复原因").fill("供应商确认可接受首批例外，负责人记录人工判断。");
    await override.getByRole("button", { name: /记录例外恢复/ }).click();
    await expect(page.getByText(/例外恢复|OVERRIDDEN/).first()).toBeVisible();

    // A returned submission exposes its questions, then the analyst can submit a
    // fresh evaluation. The browser performs both role-controlled actions.
    const returned = await command<{ candidate: Candidate }>(request, `/projects/${project.id}/candidates`, {
      title: "E2E 退回后重提候选",
      external_id: `E2E-RETURN-${Date.now()}`,
      source_url: `https://example.invalid/e2e/return/${Date.now()}`,
    }, "analyst", (await projectDetail(request, project.id)).project.version);
    const returnedReady = await makeReady(request, returned.candidate);
    await page.goto(`/candidates/${returnedReady.candidate.id}`);
    await actor(page, "analyst");
    await candidateStage(page, "review");
    await clickButton(page, /提交当前评估/);
    await actor(page, "owner");
    await candidateStage(page, "review");
    await page.getByRole("radio", { name: /退回补充材料/ }).check();
    await page.getByLabel(/决定理由/).fill("需要补充有效期内的供应商报价。");
    await page.getByLabel(/退回问题/).fill("请补充有效期内的 MOQ 报价");
    await clickButton(page, /确认退回补充材料/);
    await expect(page.getByText("请补充有效期内的 MOQ 报价")).toBeVisible();
    const returnedAggregate = await getJson<{ candidate: Candidate; evidence: Array<Json> }>(request, `/candidates/${returnedReady.candidate.id}`);
    const returnedEvidence = returnedAggregate.evidence.find((item) => item.field === "moq");
    await actor(page, "analyst");
    await candidateStage(page, "evidence");
    await page.getByText("补充证据", { exact: true }).click();
    const evidenceForm = page.locator("details.panel").filter({ has: page.getByRole("heading", { name: "追加证据版本" }) });
    await evidenceForm.getByRole("combobox", { name: "资料类型", exact: true }).selectOption("moq");
    await evidenceForm.getByLabel("值", { exact: true }).fill("110");
    await evidenceForm.getByLabel("来源定位", { exact: true }).fill("e2e:replacement-quotation");
    await evidenceForm.getByLabel("观察时间", { exact: true }).fill("2026-09-20T08:00");
    await evidenceForm.getByLabel("有效至", { exact: true }).fill("2026-10-20T08:00");
    await evidenceForm.getByRole("combobox", { name: "明确替代旧版本", exact: true }).selectOption(String(returnedEvidence?.id));
    await evidenceForm.getByRole("combobox", {name:"核验状态",exact:true}).selectOption("VERIFIED");
    await evidenceForm.getByRole("button", { name: "保存证据版本" }).click();
    await page.locator("#raw-evidence > summary").click();
    await expect(page.getByRole("cell", { name: "e2e:replacement-quotation", exact: true })).toBeVisible();
    await clickButton(page, /按当前证据重新初筛/);
    await candidateStage(page, "evaluation");
    await clickButton(page, /运行模拟 AI 整理/);
    await expect(page.getByText(/模拟 AI 已按当前证据完成整理/)).toBeVisible();
    await clickButton(page, /复制到人工修订草稿/);
    await page.getByText("人工修订并保存新版本").click();
    await clickButton(page, /保存人工评估版本/);
    await expect(page.getByText(/已保存新的人工修订版本/)).toBeVisible();
    await candidateStage(page, "review");
    await clickButton(page, /提交当前评估/);
    await expect(page.getByText(/已提交给决策负责人|待决策/).first()).toBeVisible();
    await actor(page, "owner");
    await candidateStage(page, "review");
    await page.getByLabel(/决定理由/).fill("补证和新评估已复核，批准验证。");
    await clickButton(page, /确认批准进入验证/);
    await expect(page.getByText(/验证中/).first()).toBeVisible();
    const reapproved = await getJson<{ decisions: Json[]; evaluations: Json[] }>(request, `/candidates/${returnedReady.candidate.id}`);
    expect(reapproved.decisions.map(item => item.action)).toEqual(["RETURN", "APPROVE"]);
    expect(reapproved.evaluations).toHaveLength(2);

    // WATCH is a separate terminal decision with a visible, reasoned reopen action.
    const watched = await command<{ candidate: Candidate }>(request, `/projects/${project.id}/candidates`, {
      title: "E2E 观察后重新打开候选",
      external_id: `E2E-WATCH-${Date.now()}`,
      source_url: `https://example.invalid/e2e/watch/${Date.now()}`,
    }, "analyst", (await projectDetail(request, project.id)).project.version);
    const watchedReady = await makeReady(request, watched.candidate);
    await page.goto(`/candidates/${watchedReady.candidate.id}`);
    await actor(page, "analyst");
    await candidateStage(page, "review");
    await clickButton(page, /提交当前评估/);
    await actor(page, "owner");
    await candidateStage(page, "review");
    await page.getByRole("radio", { name: /继续观察/ }).check();
    await page.getByLabel(/决定理由/).fill("等待新的市场样本。");
    await clickButton(page, /确认继续观察/);
    await expect(page.getByText(/观察/).first()).toBeVisible();
    await page.getByText("因新证据重新打开候选").click();
    await page.getByLabel("重新打开原因").fill("新的市场样本已到位，重新评估。");
    await clickButton(page, /重新打开/);
    await expect(page.getByText(/准备材料|PREPARING/).first()).toBeVisible();

    // Assert that the task was the persisted item exercised by the browser and not a static row.
    const taskList = await getJson<{ items: Array<Json> }>(request, `/tasks?state=DONE`);
    expect(taskList.items.filter(item => item.candidate_id === candidateId).map(item => item.type).sort()).toEqual(["QUOTE", "SAMPLE", "TEST"]);
  });
});
