import { expect, test, type Page } from "@playwright/test";

const FRONTEND = "http://127.0.0.1:5175";
const ANALYST_PASSWORD = "pilot-e2e-analyst-password";
const WORKSPACE = "Partner E2E Workspace";
test.use({timezoneId: "Asia/Shanghai"});

type Json = Record<string, unknown>;
type Workspace = Json & { id: string; name: string; slug: string };
type User = Json & { id: string; username: string };
type Member = Json & { id: string; role: string };
type Session = Json & {
  user: User;
  workspace: Workspace;
  workspaces: Workspace[];
  members: Member[];
  csrf_token: string;
};
type Project = Json & { id: string; version: number; name: string };
type Candidate = Json & { id: string; version: number; title: string };
type LoginBody = Json & { details?: Json & { workspaces?: Workspace[] } };
type SourcingRecord = Json & {
  id: string;
  kind: "QUOTE" | "FITMENT" | "PRICE";
  payload: Json;
  source_locator: string;
  observed_at: string;
  valid_until?: string | null;
  verification: string;
};
type SourcingAggregate = Json & { records: SourcingRecord[] };
type Evidence = Json & { field: string; value?: string | null; unit?: string | null; sourcing_record_id?: string };
type CandidateAggregate = Json & { candidate: Candidate; evidence: Evidence[] };

let requestNumber = 0;

async function apiGet<T extends Json>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`${FRONTEND}/api/v1${path}`);
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return (await response.json()) as T;
}

async function command<T extends Json>(page: Page, csrf: string, path: string, payload: Json): Promise<T> {
  requestNumber += 1;
  const response = await page.request.post(`${FRONTEND}/api/v1${path}`, {
    data: payload,
    headers: {
      Origin: FRONTEND,
      "X-CSRF-Token": csrf,
      "Idempotency-Key": `pilot-e2e-sourcing-${Date.now()}-${requestNumber}`,
    },
  });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return (await response.json()) as T;
}

async function submitLogin(page: Page): Promise<{ status: number; body: LoginBody }> {
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/v1/auth/login") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /登录|进入所选工作区/ }).click();
  const response = await responsePromise;
  return { status: response.status(), body: (await response.json()) as LoginBody };
}

async function login(page: Page): Promise<{ session: Session; csrf: string }> {
  await page.goto("/");
  await page.getByLabel("账号").fill("analyst");
  await page.getByLabel("口令").fill(ANALYST_PASSWORD);
  let result = await submitLogin(page);
  if (result.status === 409) {
    const choice = result.body.details?.workspaces?.find((item) => item.name === WORKSPACE);
    expect(choice, `missing workspace choice ${WORKSPACE}`).toBeTruthy();
    if (!choice) throw new Error(`missing workspace choice ${WORKSPACE}`);
    await page.getByLabel("工作区").selectOption(choice.id);
    result = await submitLogin(page);
  }
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const session = result.body as Session;
  return { session, csrf: session.csrf_token };
}

async function createProjectAndCandidate(page: Page, session: Session, csrf: string): Promise<Candidate> {
  const templates = await apiGet<{ items: Array<Json & { id: string; version: string; channel: string }> }>(page, "/project-templates");
  const template = templates.items.find((item) => item.channel === "AMAZON");
  expect(template, "pilot E2E seed is missing the Amazon template").toBeTruthy();
  const owner = session.members.find((member) => member.role === "decision");
  expect(owner, "pilot E2E seed is missing a decision owner").toBeTruthy();
  if (!template || !owner) throw new Error("pilot E2E seed is missing the Amazon template or decision owner");

  const createdProject = await command<{ project: Project }>(page, csrf, "/projects", {
    actor_id: session.user.id,
    expected_version: null,
    name: `Pilot sourcing ${Date.now()}`,
    channel: "AMAZON",
    market: "US",
    direction: "汽车用品 OEM 研究",
    goal: "验证离线供应商报价材料工作台",
    constraints: ["仅使用受控测试资料"],
    analyst_id: session.user.id,
    decision_owner_id: owner.id,
  });
  const project = createdProject.project;
  const createdCandidate = await command<{ candidate: Candidate }>(page, csrf, `/projects/${project.id}/candidates`, {
    actor_id: session.user.id,
    expected_version: project.version,
    title: "Pilot OEM vehicle organizer",
    external_id: `PILOT-SOURCING-${Date.now()}`,
    source_url: "https://pilot-e2e.example/items/vehicle-organizer",
    sku: "PILOT-OEM-001",
  });
  return createdCandidate.candidate;
}

function sourcingPanel(page: Page) {
  return page.locator('section[aria-labelledby="sourcing-title"]');
}

function requirement(panel: ReturnType<typeof sourcingPanel>, text: RegExp | string) {
  return panel.locator(".sourcing-gap").filter({ hasText: text }).first();
}

function formFor(panel: ReturnType<typeof sourcingPanel>, heading: string) {
  return panel.locator("form.sourcing-form").filter({ hasText: heading });
}

async function openRequirement(page: Page, label: RegExp | string): Promise<void> {
  const gap = requirement(sourcingPanel(page), label);
  await expect(gap).toBeVisible();
  await gap.getByRole("button", { name: /去补齐|新增记录/ }).click();
}

async function saveRecord(page: Page, formHeading: string): Promise<void> {
  const panel = sourcingPanel(page);
  const form = formFor(panel, formHeading);
  await expect(form).toBeVisible();
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes("/api/v1/candidates/")
      && response.url().endsWith("/sourcing-records")
      && response.request().method() === "POST",
  );
  await form.getByRole("button", { name: "保存材料" }).click();
  const response = await responsePromise;
  expect(response.ok(), `${response.url()}: ${await response.text()}`).toBeTruthy();
}

test("OEM research sourcing records preserve quote, estimate, and desk-fit boundaries", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({width:1280,height:900});
  const { session, csrf } = await login(page);
  const candidate = await createProjectAndCandidate(page, session, csrf);
  await page.goto(`/candidates/${candidate.id}`);
  await expect(page.getByRole("heading", { name: candidate.title })).toBeVisible();

  const panel = sourcingPanel(page);
  await expect(panel.getByRole("heading", { name: "采购材料准备" })).toBeVisible();
  await panel.getByRole("button", { name: "设置 OEM 与阶段" }).click();
  const profileForm = panel.locator("form.sourcing-form").filter({ hasText: "候选准备设置" });
  await profileForm.getByLabel("商品类型").selectOption("OEM");
  await profileForm.getByLabel("准备阶段").selectOption("RESEARCH");
  await profileForm.getByLabel("品牌").fill("Pilot Motors");
  await profileForm.getByLabel("车型 / 型号").fill("Organizer X");
  await profileForm.getByLabel("年份").fill("2025");
  await profileForm.getByLabel("配置 / 座型").fill("SUV / 5座");
  await profileForm.getByLabel("座椅类型").fill("5座织物");
  const profileResponsePromise = page.waitForResponse((response) =>
    response.url().includes("/api/v1/candidates/")
      && response.url().endsWith("/sourcing-profile")
      && response.request().method() === "POST",
  );
  await profileForm.getByRole("button", { name: "保存设置" }).click();
  const profileResponse = await profileResponsePromise;
  expect(profileResponse.ok(), `${profileResponse.url()}: ${await profileResponse.text()}`).toBeTruthy();
  await expect(panel.getByText("OEM / 未上架 · 研究准备", { exact: true })).toBeVisible();

  await openRequirement(page, "供应参考价");
  const quoteForm = formFor(panel, "录入供应商报价");
  await quoteForm.getByLabel("供应商名称").fill("Pilot Offline Supplier");
  await quoteForm.getByLabel("供应商渠道").selectOption("OFFLINE");
  await quoteForm.getByLabel("价格基准").selectOption("SUPPLIER_CONFIRMED");
  await quoteForm.getByLabel("金额").fill("128.50");
  await quoteForm.getByLabel("币种").fill("CNY");
  await quoteForm.locator('select[name="price_unit"]').selectOption("piece");
  await quoteForm.getByLabel("MOQ", {exact:true}).fill("50");
  await quoteForm.getByLabel("MOQ单位").selectOption("piece");
  await quoteForm.getByLabel("来源定位").fill("pilot-e2e:offline-supplier-quote-2026-09-21");
  await quoteForm.getByLabel("观察时间").fill("2026-09-20T08:00");
  await quoteForm.getByLabel("有效至").fill("2026-10-20T08:00");
  await quoteForm.getByLabel("核验状态").selectOption("VERIFIED");
  await quoteForm.getByLabel("备注 / 核验依据").fill("Supplier confirmed the per-piece price and MOQ on the offline quote sheet.");
  await quoteForm.getByText("补充细节（选填）").click();
  await quoteForm.getByLabel("样品 MOQ").fill("2");
  await quoteForm.getByLabel("现货 MOQ").fill("20");
  await quoteForm.getByLabel("定制 MOQ").fill("100");
  await quoteForm.getByLabel("起始数量").nth(0).fill("50");
  await quoteForm.getByLabel("结束数量").nth(0).fill("99");
  await quoteForm.getByLabel("单价").nth(0).fill("118.00");
  await quoteForm.locator('select[name="tier_price_unit_0"]').selectOption("piece");
  await quoteForm.getByRole("button", { name: "增加一档" }).click();
  await quoteForm.getByLabel("起始数量").nth(1).fill("100");
  await quoteForm.getByLabel("结束数量").nth(1).fill("200");
  await quoteForm.getByLabel("单价").nth(1).fill("105.00");
  await quoteForm.locator('select[name="tier_price_unit_1"]').selectOption("piece");
  await quoteForm.getByLabel("材料说明").fill("Pilot E2E supplier quote");
  await quoteForm.getByLabel("HTTP(S) 共享链接").fill("https://pilot-e2e.example/quote.pdf");

  await page.screenshot({ path: "/private/tmp/product-res-sourcing-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/private/tmp/product-res-sourcing-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await saveRecord(page, "录入供应商报价");

  await expect.poll(async () => (await apiGet<SourcingAggregate>(page, `/candidates/${candidate.id}/sourcing`)).records.length).toBe(1);
  let source = await apiGet<SourcingAggregate>(page, `/candidates/${candidate.id}/sourcing`);
  const quote = source.records[0];
  expect(quote.kind).toBe("QUOTE");
  expect(quote.source_locator).toBe("pilot-e2e:offline-supplier-quote-2026-09-21");
  expect(new Date(String(quote.observed_at)).getTime()).toBe(Date.parse("2026-09-20T08:00:00+08:00"));
  expect(new Date(String(quote.valid_until)).getTime()).toBe(Date.parse("2026-10-20T08:00:00+08:00"));
  expect(quote.verification).toBe("VERIFIED");
  expect(quote.payload.supplier_name).toBe("Pilot Offline Supplier");
  expect(quote.payload.supplier_channel).toBe("OFFLINE");
  expect(quote.payload.quote_basis).toBe("SUPPLIER_CONFIRMED");
  expect(quote.payload.amount).toBe("128.50");
  expect(quote.payload.currency).toBe("CNY");
  expect(quote.payload.price_unit).toBe("piece");
  expect(quote.payload.moq).toBe(50);
  expect(quote.payload.moq_unit).toBe("piece");
  expect(quote.payload.sample_moq).toEqual({ amount: 2, unit: "piece" });
  expect(quote.payload.stock_moq).toEqual({ amount: 20, unit: "piece" });
  expect(quote.payload.custom_moq).toEqual({ amount: 100, unit: "piece" });
  expect(quote.payload.price_tiers).toEqual([
    { min_quantity: 50, max_quantity: 99, quantity_unit: "piece", amount: "118.00", price_unit: "piece" },
    { min_quantity: 100, max_quantity: 200, quantity_unit: "piece", amount: "105.00", price_unit: "piece" },
  ]);
  expect(quote.payload.shared_materials).toEqual([{ label: "Pilot E2E supplier quote", url: "https://pilot-e2e.example/quote.pdf" }]);
  expect(quote.verification_note).toContain("Supplier confirmed");
  const afterQuote = await apiGet<CandidateAggregate>(page, `/candidates/${candidate.id}`);
  const quoteEvidence = Object.fromEntries(afterQuote.evidence.filter((item) => item.sourcing_record_id === quote.id).map((item) => [item.field, item]));
  expect(quoteEvidence.procurement_cost?.value).toBe("128.50");
  expect(quoteEvidence.procurement_cost?.unit).toBe("per_item");
  expect(quoteEvidence.moq?.value).toBe("50");
  expect(quoteEvidence.moq?.unit).toBe("piece");

  await panel.locator("details.sourcing-history").getByText(/已录材料/).click();
  await expect(panel.getByText("供应商报价", { exact: true })).toBeVisible();

  await openRequirement(page, "目标售价");
  const priceForm = formFor(panel, "录入售价口径");
  await priceForm.getByLabel("价格口径").selectOption("TARGET_ESTIMATE");
  await priceForm.getByLabel("金额").fill("199.99");
  await priceForm.getByLabel("币种").fill("CNY");
  await priceForm.getByLabel("计价单位").selectOption("piece");
  await priceForm.getByLabel("来源定位").fill("pilot-e2e:target-estimate");
  await priceForm.getByLabel("观察时间").fill("2026-09-20T08:00");
  await priceForm.getByLabel("有效至").fill("2026-10-20T08:00");
  await saveRecord(page, "录入售价口径");

  await openRequirement(page, "桌面适配检查");
  const fitmentForm = formFor(panel, "录入车型适配");
  await fitmentForm.getByLabel("品牌").fill("Pilot Motors");
  await fitmentForm.getByLabel("车型 / 型号").fill("Organizer X");
  await fitmentForm.getByLabel("年份").fill("2025");
  await fitmentForm.getByLabel("配置 / 座型").fill("SUV / 5座");
  await fitmentForm.getByLabel("座椅类型").fill("5座织物");
  await fitmentForm.getByLabel("核验方式").selectOption("DESK_REVIEW");
  await fitmentForm.getByLabel("结果").selectOption("PASS");
  await fitmentForm.getByLabel("检查内容").fill("Desk review checked the published dimensions and SUV / 5-seat configuration.");
  await fitmentForm.getByLabel("来源定位").fill("pilot-e2e:desk-fitment-review");
  await fitmentForm.getByLabel("观察时间").fill("2026-09-20T08:00");
  await fitmentForm.getByLabel("有效至").fill("2026-10-20T08:00");
  await fitmentForm.getByLabel("核验状态").selectOption("VERIFIED");
  await fitmentForm.getByLabel("备注 / 核验依据").fill("Desk review only; no physical vehicle or sample was tested.");
  await saveRecord(page, "录入车型适配");

  await panel.locator("details.sourcing-history").getByText(/已录材料与历史/).click();
  await openRequirement(page, "桌面适配检查");
  const physicalForm = formFor(panel, "录入车型适配");
  await physicalForm.getByLabel("核验方式").selectOption("PHYSICAL_TEST");
  await physicalForm.locator('select[name="result"]').selectOption("PASS");
  await physicalForm.getByLabel("样品编号").fill("PILOT-SAMPLE-001");
  await physicalForm.getByLabel("样品版本与上述目标车型一致").check();
  await physicalForm.locator(".sourcing-seat-check").nth(0).getByLabel("检查明细").fill("Driver seat installed and secured.");
  await physicalForm.locator(".sourcing-seat-check").nth(1).getByLabel("检查明细").fill("Passenger seat installed and secured.");
  await physicalForm.getByLabel("检查内容").fill("Physical fitment was checked in the target vehicle.");
  await physicalForm.getByLabel("来源定位").fill("pilot-e2e:physical-fitment-incomplete");
  await physicalForm.getByLabel("核验状态").selectOption("VERIFIED");
  await physicalForm.getByLabel("备注 / 核验依据").fill("Pilot E2E physical check; intentionally leaves right-seat result untested first.");
  const rejectedPhysical = page.waitForResponse((response) =>
    response.url().includes("/api/v1/candidates/")
      && response.url().endsWith("/sourcing-records")
      && response.request().method() === "POST",
  );
  await physicalForm.getByRole("button", { name: "保存材料" }).click();
  const rejectedResponse = await rejectedPhysical;
  expect(rejectedResponse.status(), await rejectedResponse.text()).toBe(422);
  await expect(page.getByRole("alert")).toBeVisible();

  await physicalForm.locator(".sourcing-seat-check").nth(0).getByLabel("检查结果").selectOption("PASS");
  await physicalForm.locator(".sourcing-seat-check").nth(1).getByLabel("检查结果").selectOption("PASS");
  await physicalForm.locator(".sourcing-seat-check").nth(0).getByLabel("检查明细").fill("Driver seat installed, locked, adjusted, and checked for airbag interference.");
  await physicalForm.locator(".sourcing-seat-check").nth(1).getByLabel("检查明细").fill("Passenger seat installed, locked, adjusted, and checked for airbag interference.");
  await saveRecord(page, "录入车型适配");

  source = await apiGet<SourcingAggregate>(page, `/candidates/${candidate.id}/sourcing`);
  expect(source.records).toHaveLength(4);
  const price = source.records.find((record) => record.kind === "PRICE");
  const fitment = source.records.find((record) => record.kind === "FITMENT");
  expect(price?.payload.price_basis).toBe("TARGET_ESTIMATE");
  expect(fitment?.payload.method).toBe("DESK_REVIEW");
  const finalCandidate = await apiGet<CandidateAggregate>(page, `/candidates/${candidate.id}`);
  const finalEvidence = finalCandidate.evidence;
  const targetEvidence = finalEvidence.find((item) => item.field === "target_price");
  expect(targetEvidence?.value).toBe("199.99");
  expect(finalEvidence.some((item) => item.field === "price")).toBeFalsy();
  expect(finalEvidence.some((item) => item.field === "fitment_desk_review" && item.sourcing_record_id === fitment?.id)).toBeTruthy();
  expect(finalEvidence.some((item) => item.field === "vehicle_fitment" && item.sourcing_record_id === source.records.find((record) => record.source_locator === "pilot-e2e:physical-fitment-incomplete")?.id)).toBeTruthy();
});
