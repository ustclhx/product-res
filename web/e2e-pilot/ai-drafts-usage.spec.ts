import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const FRONTEND = "http://127.0.0.1:5175";
const ANALYST_PASSWORD = "pilot-e2e-analyst-password";
const OWNER_PASSWORD = "pilot-e2e-owner-password";
const WORKSPACE = "Partner E2E Workspace";
type Json = Record<string, unknown>;
type Workspace = Json & { id:string; name:string; slug:string };
type Member = Json & { id:string; role:string };
type Session = Json & { user:{id:string;username:string}; workspace:Workspace; members:Member[]; csrf_token:string };
type Candidate = Json & { id:string; version:number; title:string };
type Project = Json & { id:string; version:number; name:string };
type LoginBody = Json & { details?:Json & {workspaces?:Workspace[]} };

let requestNumber = 0;

async function apiGet<T extends Json>(page:Page,path:string):Promise<T> {
  const response = await page.request.get(`${FRONTEND}/api/v1${path}`);
  expect(response.ok(),`${path}: ${await response.text()}`).toBeTruthy();
  return await response.json() as T;
}

async function command<T extends Json>(page:Page,csrf:string,path:string,payload:Json):Promise<T> {
  requestNumber += 1;
  const response = await page.request.post(`${FRONTEND}/api/v1${path}`,{data:payload,headers:{Origin:FRONTEND,"X-CSRF-Token":csrf,"Idempotency-Key":`pilot-e2e-ai-drafts-${Date.now()}-${requestNumber}`}});
  expect(response.ok(),`${path}: ${await response.text()}`).toBeTruthy();
  return await response.json() as T;
}

async function login(page:Page):Promise<{session:Session;csrf:string}> {
  await page.goto("/");
  await page.getByLabel("账号").fill("analyst");
  await page.getByLabel("口令").fill(ANALYST_PASSWORD);
  const submit = async () => {
    const pending = page.waitForResponse(response => response.url().endsWith("/api/v1/auth/login") && response.request().method()==="POST");
    await page.getByRole("button",{name:/登录|进入所选工作区/}).click();
    const response = await pending;
    return {status:response.status(),body:await response.json() as LoginBody};
  };
  let result = await submit();
  if (result.status === 409) {
    const workspace = result.body.details?.workspaces?.find(item => item.name === WORKSPACE);
    expect(workspace,`missing workspace ${WORKSPACE}`).toBeTruthy();
    if (!workspace) throw new Error(`missing workspace ${WORKSPACE}`);
    await page.getByLabel("工作区").selectOption(workspace.id);
    result = await submit();
  }
  expect(result.status,JSON.stringify(result.body)).toBe(200);
  const session = result.body as Session;
  return {session,csrf:session.csrf_token};
}

async function createCandidate(page:Page,request:APIRequestContext,session:Session,csrf:string):Promise<{candidate:Candidate;project:Project}> {
  const templates = await apiGet<{items:Array<Json & {id:string;version:string;channel:string;rules:Json[];required_evidence:string[]}>}>(page,"/project-templates");
  const template = templates.items.find(item => item.channel === "AMAZON");
  const owner = session.members.find(member => member.role === "decision");
  expect(template,"Amazon template missing").toBeTruthy();
  expect(owner,"decision owner missing").toBeTruthy();
  if (!template || !owner) throw new Error("pilot E2E setup is missing the Amazon template or decision owner");
  const created = await command<{project:Project}>(page,csrf,"/projects",{
    actor_id:session.user.id,expected_version:null,name:`AI draft freshness ${Date.now()}`,channel:"AMAZON",market:"US",direction:"Outdoor",goal:"Check model draft freshness",constraints:["Controlled E2E"],analyst_id:session.user.id,decision_owner_id:owner.id,
  });
  const ownerLogin = await request.post(`${FRONTEND}/api/v1/auth/login`,{data:{username:"owner",password:OWNER_PASSWORD,workspace_id:session.workspace.id},headers:{Origin:FRONTEND}});
  expect(ownerLogin.ok(),await ownerLogin.text()).toBeTruthy();
  const ownerSession = await ownerLogin.json() as Session;
  const criteria = await request.post(`${FRONTEND}/api/v1/projects/${created.project.id}/criteria-revisions`,{
    data:{actor_id:ownerSession.user.id,expected_version:created.project.version,template_id:template.id,template_version:template.version,parent_revision_id:null,rules:template.rules.map(rule=>({field:rule.field,operator:rule.operator,threshold:rule.threshold,unit:rule.unit,currency:rule.currency??null})),required_evidence:template.required_evidence},
    headers:{Origin:FRONTEND,"X-CSRF-Token":ownerSession.csrf_token,"Idempotency-Key":`pilot-e2e-ai-criteria-${Date.now()}`},
  });
  expect(criteria.ok(),await criteria.text()).toBeTruthy();
  const project = (await criteria.json() as {project:Project}).project;
  const added = await command<{candidate:Candidate}>(page,csrf,`/projects/${project.id}/candidates`,{
    actor_id:session.user.id,expected_version:project.version,title:"Pilot AI freshness candidate",external_id:`PILOT-AI-${Date.now()}`,source_url:"https://pilot-e2e.example/ai",sku:"PILOT-AI-001",
  });
  const evidence = await command<{candidate:Candidate}>(page,csrf,`/candidates/${added.candidate.id}/evidence`,{
    expected_version:added.candidate.version,field:"moq",value:"100",unit:"unit",currency:null,window:null,source_locator:"pilot-e2e:initial-moq",observed_at:"2026-09-20T08:00:00Z",valid_until:"2099-09-20T08:00:00Z",epistemic_kind:"FACT",verification:"VERIFIED",verification_note:"受控测试材料已人工核对",
  });
  return {candidate:evidence.candidate,project};
}

test("stale copied AI draft is blocked after an API evidence revision; pilot usage shows unknowns and exports",async({page,request})=>{
  test.setTimeout(180_000);
  await page.setViewportSize({width:1280,height:900});
  const {session,csrf} = await login(page);
  const {candidate} = await createCandidate(page,request,session,csrf);

  await page.route("**/api/v1/pilot/model-usage?**",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({items:[{id:"e2e-usage",attempt_id:"e2e-attempt",job_id:"e2e-job",candidate_id:candidate.id,project_id:"e2e-project",node_kind:"EVALUATION_ORGANIZER",model:"pilot-e2e-model",input_bytes:null,input_tokens:null,output_tokens:null,total_tokens:null,elapsed_ms:10,max_output_tokens:null,max_total_tokens:null,finish_reason:null,request_id:null,cost:null,currency:null,outcome_status:"success",error_code:null,recorded_at:"2026-09-21T08:00:00Z"}],summary:{receipt_count:1,unrecorded_attempt_count:0,usage_known_count:0,usage_partial_count:0,usage_unknown_count:1,input_tokens_known_sum:0,output_tokens_known_sum:0,total_tokens_known_sum:0,cost_by_currency:[]}})}));
  await page.route("**/api/v1/pilot/model-usage/export?**",route=>route.fulfill({status:200,contentType:"text/csv; charset=utf-8",headers:{"Content-Disposition":"attachment; filename=\"model-usage.csv\""},body:"attempt_id,outcome_status,total_tokens\ne2e-attempt,success,\n"}));

  await page.goto(`/candidates/${candidate.id}`);
  await expect(page.getByRole("heading",{name:candidate.title})).toBeVisible();
  const usage = page.getByTestId("model-usage");
  await page.getByText("模型整理与用量", { exact: true }).click();
  await usage.locator(":scope > summary").click();
  await expect(usage.getByText("用量未知 1 次",{exact:true})).toBeVisible();
  await expect(usage.getByRole("cell",{name:"未知",exact:true}).last()).toBeVisible();
  const download = page.waitForEvent("download");
  await usage.getByRole("button",{name:"导出 CSV"}).click();
  expect((await download).suggestedFilename()).toBe(`model-usage-${candidate.id}.csv`);

  await page.getByRole("button",{name:/2\. 评估与决策/}).click();
  await page.getByRole("button",{name:"评估整理"}).click();
  await page.getByRole("button",{name:"整理评估草稿"}).click();
  const copyDraft = page.getByRole("button",{name:"复制到人工修订草稿"});
  await expect(copyDraft).toBeVisible({timeout:30_000});
  await copyDraft.click();
  await page.getByText("检查并保存评估快照").click();
  const firstDimension = page.getByLabel("判断").first();
  await firstDimension.fill("人工复核文本：供应商确认 MOQ 条款仍适用。");

  const aggregate = await apiGet<{candidate:Candidate;evidence:Array<{id:string}>}>(page,`/candidates/${candidate.id}`);
  const evidenceRevision = await page.request.post(`${FRONTEND}/api/v1/candidates/${candidate.id}/evidence`,{
    data:{expected_version:aggregate.candidate.version,field:"procurement_cost",value:"18.50",unit:"per_item",currency:"USD",window:null,source_locator:"pilot-e2e:revised-cost",observed_at:"2026-09-21T08:00:00Z",valid_until:"2099-09-21T08:00:00Z",epistemic_kind:"FACT",verification:"VERIFIED",verification_note:"受控测试材料已人工核对"},
    headers:{Origin:FRONTEND,"X-CSRF-Token":csrf,"Idempotency-Key":`pilot-e2e-evidence-revision-${Date.now()}`},
  });
  expect(evidenceRevision.ok(),await evidenceRevision.text()).toBeTruthy();

  const saveResponse = page.waitForResponse(response=>response.url().endsWith(`/api/v1/candidates/${candidate.id}/evaluations`)&&response.request().method()==="POST");
  await page.getByRole("button",{name:"保存人工评估版本"}).click();
  const rejectedSave = await saveResponse;
  expect(rejectedSave.ok(),"server should reject adoption after the evidence revision").toBeFalsy();
  await expect(page.getByText(/已复制的草稿已过期，保存已暂停/)).toBeVisible();
  await expect(firstDimension).toHaveValue("人工复核文本：供应商确认 MOQ 条款仍适用。");
  await expect(page.getByRole("button",{name:"保存人工评估版本"})).toBeDisabled();
  await expect(page.getByRole("button",{name:"保留输入并转为纯人工草稿"})).toBeVisible();
  const refreshed = await apiGet<{evaluations:unknown[]}>(page,`/candidates/${candidate.id}`);
  expect(refreshed.evaluations).toHaveLength(0);
});
