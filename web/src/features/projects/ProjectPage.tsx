import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, command } from "../../app/client";
import { useWorkspace } from "../../app/workspace";
import { memberLabel, membersForRole } from "../../app/members";
import { isOpenItem, useWorkItems, workOwnerLabel, type WorkItem } from "../../app/workItems";
import WorkItemList from "../../components/WorkItemList";
import { IntakePanel } from "../candidates/IntakePanel";
import { statusText, evidenceFieldLabel } from "../evidence/types";
import type { Criteria, CriteriaRule, ProjectDetail, ProjectTemplate } from "./types";
import "./projects.css";

const channelLabels = { AMAZON: "Amazon", EBAY: "eBay", DTC: "独立站" } as const;
const fieldLabels: Record<string, string> = {
  moq: "最小起订量", procurement_cost: "采购成本", selling_price: "预计售价", supplier_identity: "供应商身份",
  amazon_fulfillment_cost: "FBA / 自发货成本", amazon_platform_fee: "Amazon 平台费", ebay_platform_fee: "eBay 平台费",
  cross_border_shipping: "跨境物流成本", payment_fee: "支付手续费", customer_acquisition_cost: "获客成本假设",
  fulfillment_cost: "履约成本", vehicle_fitment: "车型适配资料", left_right_sample_photos: "左右件样品照片",
};
type View = "candidates" | "criteria" | "tasks" | "settings" | "history";

function formValue(form: FormData, name: string) { const value = form.get(name); return typeof value === "string" ? value : ""; }
function fieldLabel(key: string, template?: ProjectTemplate) { return template?.fields?.find((item) => item.key === key)?.label ?? fieldLabels[key] ?? evidenceFieldLabel(key); }
function ruleText(rule: CriteriaRule, template?: ProjectTemplate) { return `${fieldLabel(rule.field, template)} ${rule.operator === "lte" ? "不高于" : rule.operator === "gte" ? "不低于" : "等于"} ${rule.threshold}${rule.currency ? ` ${rule.currency}` : ""}${rule.unit ? ` / ${rule.unit}` : ""}`; }

export default function ProjectPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { mode, actor, members, refreshToken, refresh: refreshWorkspace } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [evidenceOnly, setEvidenceOnly] = useState(true);
  const [requiredEvidence, setRequiredEvidence] = useState<string[]>([]);
  const [customEvidence, setCustomEvidence] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const query = useQuery({ queryKey: ["project", id, refreshToken], queryFn: async () => {
    const [detail, templates] = await Promise.all([api<ProjectDetail>(`/projects/${id}`), api<{ items: ProjectTemplate[] }>("/project-templates")]);
    return { ...detail, template: templates.items.find((item) => item.channel === detail.project.channel) };
  }, placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === id ? previous : undefined, retry: false });
  const workQuery = useWorkItems();
  const refresh = async () => { refreshWorkspace(); await Promise.all([query.refetch(), workQuery.refetch()]); };
  const data = query.data;
  if (!data) return <div>{query.isPending ? <p role="status">正在加载项目…</p> : <div className="error" role="alert">{query.error?.message}<button onClick={() => void refresh()}>重试</button></div>}</div>;

  const { project, template } = data;
  const criteria = data.criteria_versions?.find((item) => item.id === project.current_criteria_id);
  const projectItems = (workQuery.data?.items ?? []).filter((item) => item.project_id === id);
  const openItems = projectItems.filter(isOpenItem);
  const completedItems = projectItems.filter((item) => !isOpenItem(item));
  const viewParam = searchParams.get("view");
  const view: View = viewParam === "criteria" || viewParam === "tasks" || viewParam === "settings" || viewParam === "history" ? viewParam : "candidates";
  const intakeOpen = searchParams.get("intake") === "1";
  const canConfirm = actor === project.decision_owner_id;
  const confirmOwner = workOwnerLabel(project.decision_owner_id, members);
  const headlineItem = openItems.find((item) => item.candidate_id) ?? openItems[0];

  function beginCriteriaEdit() {
    const initial = criteria?.required_evidence ?? template?.required_evidence ?? [];
    const known = new Set(template?.fields?.map((item) => item.key) ?? []);
    setRequiredEvidence(initial.filter((item) => known.has(item)));
    setCustomEvidence(initial.filter((item) => !known.has(item)).join("\n"));
    setEvidenceOnly(criteria ? !criteria.rules?.length : true);
    setEditing(true); setError("");
  }
  async function saveCriteria(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const form = new FormData(event.currentTarget);
    const sourceRules = evidenceOnly ? [] : (criteria?.rules?.length ? criteria.rules : template?.rules ?? []);
    const custom = customEvidence.split("\n").map((item) => item.trim()).filter(Boolean);
    const evidence = [...new Set([...requiredEvidence, ...custom])];
    if (!evidence.length) { setError("请至少选择一项所需材料。"); setBusy(false); return; }
    try {
      await command(`/projects/${id}/criteria-revisions`, {
        expected_version: project.version,
        template_id: criteria?.template_id ?? template?.id,
        template_version: criteria?.template_version ?? template?.version,
        parent_revision_id: project.current_criteria_id ?? null,
        rules: sourceRules.map((rule, index) => ({ field: rule.field, operator: form.get(`operator-${index}`), threshold: formValue(form, `threshold-${index}`), unit: formValue(form, `unit-${index}`), currency: formValue(form, `currency-${index}`) || null })),
        required_evidence: evidence,
      });
      setEditing(false); setNotice("标准已确认。现在可以收集候选，已有评估记录不会被改写。"); await refresh(); void navigate(`/projects/${id}?intake=1`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "确认失败"); }
    finally { setBusy(false); }
  }
  async function updateOwners(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      await command(`/projects/${id}/updates`, { expected_version: project.version, analyst_id: form.get("analyst_id") || null, decision_owner_id: form.get("decision_owner_id") || null, default_due_days: Number(form.get("default_due_days")) });
      setNotice("项目负责人和默认期限已更新。"); await refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "更新失败"); }
    finally { setBusy(false); }
  }

  return <div className="feature-page project-detail">
    <header className="page-heading"><div><Link to="/projects">选品项目</Link><h1>{project.name}</h1><p>{channelLabels[project.channel]} · {project.market} · {project.direction}</p></div><HeaderAction criteria={criteria} item={headlineItem} projectId={id} /></header>
    <div className="project-summary"><p>{project.goal}</p><p className="muted">分析负责人：{workOwnerLabel(project.analyst_id, members)} · 决策负责人：{confirmOwner} · 默认期限 {project.default_due_days ?? 7} 天</p>{project.constraints?.length ? <p className="muted">限制：{project.constraints.join("；")}</p> : null}</div>
    {error && <div className="error" role="alert">{error} <button onClick={() => void refresh()}>刷新资料</button></div>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {workQuery.isError && <div className="error" role="alert">项目事项加载失败。<button type="button" onClick={() => void workQuery.refetch()}>重试</button></div>}

    <nav className="project-nav" aria-label="项目视图">
      <Link className={view === "candidates" ? "active" : ""} to={`/projects/${id}`}>候选</Link>
      <Link className={view === "criteria" ? "active" : ""} to={`/projects/${id}?view=criteria`}>标准</Link>
      <Link className={view === "tasks" ? "active" : ""} to={`/projects/${id}?view=tasks`}>项目事项{openItems.length ? `（${openItems.length}）` : ""}</Link>
      <Link className={view === "settings" ? "active" : ""} to={`/projects/${id}?view=settings`}>设置</Link>
      <Link className={view === "history" ? "active" : ""} to={`/projects/${id}?view=history`}>历史</Link>
    </nav>

    {view === "candidates" && criteria && intakeOpen && <section aria-label="添加候选"><div className="toolbar"><Link to={`/projects/${id}`}>收起添加候选</Link></div><IntakePanel projectId={id} projectChannel={project.channel} projectDirection={project.direction ?? ""} projectVersion={project.version ?? 1} onChanged={refresh} /></section>}
    {view === "candidates" && <CandidatesView data={data} projectItems={openItems} mode={mode} members={members} />}
    {view === "candidates" && !criteria && <div className="notice"><span>项目标准还未确认，确认后才能纳入候选。</span><Link to={`/projects/${id}?view=criteria`}>去确认标准</Link></div>}

    {view === "criteria" && <section className={`panel criteria-panel ${criteria ? "" : "criteria-panel--pending"}`}>
      <div className="panel-heading"><div><h2>{criteria ? "当前选品标准" : "确认首次选品标准"}</h2><p className="muted">标准只由决策负责人确认；保存项目草稿不会自动确认。</p></div><button className={criteria ? "secondary" : "primary"} type="button" onClick={beginCriteriaEdit} disabled={!canConfirm}>{criteria ? "修订标准" : "开始确认"}</button></div>
      {!canConfirm && <p className="muted">等待决策负责人 {confirmOwner} 确认。{!project.decision_owner_id && <Link to={`/projects/${id}?view=settings`}>分配负责人</Link>}</p>}
      {criteria ? <CriteriaSummary criteria={criteria} template={template} /> : <div className="criteria-preview"><p>{template?.name}。首轮建议先收集并核验材料，不使用模板示例阈值自动排除候选。</p><MaterialList fields={template?.required_evidence ?? []} template={template} /></div>}
      {editing && <form className="criteria-form" onSubmit={(event) => void saveCriteria(event)}>
        <label className="choice-line"><input type="checkbox" checked={evidenceOnly} onChange={(event) => setEvidenceOnly(event.target.checked)} /> 本轮只核验材料，暂不设硬性门槛</label>
        {!evidenceOnly && (criteria?.rules?.length ? criteria.rules : template?.rules ?? []).map((rule, index) => <fieldset key={`${rule.field}-${index}`}><legend>{fieldLabel(rule.field, template)}</legend><div className="form-grid"><label className="field">比较方式<select name={`operator-${index}`} defaultValue={rule.operator}><option value="lte">不高于</option><option value="gte">不低于</option><option value="eq">等于</option></select></label><label className="field">阈值<input name={`threshold-${index}`} defaultValue={rule.threshold} required /></label><label className="field">单位<input name={`unit-${index}`} defaultValue={rule.unit} required /></label><label className="field">币种<input name={`currency-${index}`} defaultValue={rule.currency ?? ""} placeholder="金额字段填写 USD 等" /></label></div></fieldset>)}
        <fieldset><legend>候选必须具备的材料</legend><div className="evidence-checklist">{(template?.fields ?? []).map((item) => <label key={item.key}><input type="checkbox" checked={requiredEvidence.includes(item.key)} onChange={(event) => setRequiredEvidence((current) => event.target.checked ? [...current, item.key] : current.filter((key) => key !== item.key))} /><span>{item.label}<small>{item.group}</small></span></label>)}</div><details><summary>添加自定义高级字段</summary><label className="field">字段键（每行一项）<textarea value={customEvidence} onChange={(event) => setCustomEvidence(event.target.value)} placeholder="例如 supplier_certificate" /></label></details></fieldset>
        <div className="form-actions"><button className="primary" disabled={!canConfirm || busy}>{busy ? "正在保存…" : "确认并保存标准"}</button><button type="button" className="secondary" onClick={() => setEditing(false)}>取消</button>{!canConfirm && <span className="muted">需要由决策负责人 {confirmOwner} 确认。</span>}</div>
      </form>}
    </section>}

    {view === "tasks" && <section className="panel"><div className="panel-heading"><div><h2>项目事项</h2><p className="muted">候选缺口、标准确认和已有任务使用同一状态。</p></div></div>{workQuery.isPending ? <p role="status">正在加载事项…</p> : <WorkItemList items={openItems} emptyText="当前项目没有待处理事项。" />}</section>}
    {view === "settings" && <section className="panel"><h2>项目设置</h2><form onSubmit={(event) => void updateOwners(event)} className="form-grid"><label className="field">分析负责人<select name="analyst_id" defaultValue={project.analyst_id ?? ""}><option value="">未指定</option>{mode === "demo" ? <option value="analyst">林晓 · 选品分析</option> : membersForRole(members, "analyst").map((member) => <option value={member.id} key={member.id}>{memberLabel(member)}</option>)}</select></label><label className="field">决策负责人<select name="decision_owner_id" defaultValue={project.decision_owner_id ?? ""}><option value="">未指定</option>{mode === "demo" ? <option value="owner">陈越 · 决策负责人</option> : membersForRole(members, "decision", "owner").map((member) => <option value={member.id} key={member.id}>{memberLabel(member)}</option>)}</select></label><label className="field">默认期限（天）<input type="number" name="default_due_days" min="1" max="365" defaultValue={project.default_due_days ?? 7} required /></label><div className="form-actions"><button className="primary" disabled={busy}>{busy ? "正在保存…" : "保存项目设置"}</button></div></form></section>}
    {view === "history" && <section className="panel history-view"><h2>项目历史</h2><h3>标准版本</h3>{data.criteria_versions?.length ? <div className="table-scroll"><table><thead><tr><th>版本</th><th>硬规则</th><th>所需材料</th><th>确认时间</th></tr></thead><tbody>{data.criteria_versions.map((item, index) => <tr key={item.id}><td>版本 {index + 1}{item.id === project.current_criteria_id ? " · 当前" : ""}</td><td>{item.rules?.length ? item.rules.map((rule) => <div key={rule.field}>{ruleText(rule, template)}</div>) : "无硬性门槛"}</td><td>{(item.required_evidence ?? []).map((key) => fieldLabel(key, template)).join("、")}</td><td>{item.confirmed_at ? new Date(item.confirmed_at).toLocaleString("zh-CN", { hour12: false }) : "时间未记录"}</td></tr>)}</tbody></table></div> : <p className="muted">尚未确认标准版本。</p>}<h3>已结束事项</h3><WorkItemList items={completedItems} emptyText="还没有已完成或已取消的事项。" /></section>}
  </div>;
}

function HeaderAction({ criteria, item, projectId }: { criteria?: Criteria; item?: WorkItem; projectId: string }) {
  if (!criteria) return <Link className="primary" to={`/projects/${projectId}?view=criteria`}>下一步：确认标准</Link>;
  if (item) return <Link className="primary" to={item.href}>下一步：{item.action_label}</Link>;
  return <Link className="primary" to={`/projects/${projectId}?intake=1`}>添加候选</Link>;
}

function CandidatesView({ data, projectItems, mode, members }: { data: ProjectDetail; projectItems: WorkItem[]; mode: "demo" | "pilot"; members: ReturnType<typeof useWorkspace>["members"] }) {
  return <section className="panel candidate-list"><div className="panel-heading"><div><h2>候选清单</h2><p className="muted">每个候选按自己的资料和决策状态推进。</p></div><div className="toolbar"><span className="muted">{data.candidates?.length ?? 0} 个候选</span>{data.project.current_criteria_id && <Link className="primary action-link" to={`/projects/${data.project.id}?intake=1`}>添加候选</Link>}</div></div>{data.candidates?.length ? <div className="table-scroll"><table><thead><tr><th>候选</th><th>当前状态</th><th>下一步</th><th>负责人</th></tr></thead><tbody>{data.candidates.map((candidate) => { const item = projectItems.find((work) => work.candidate_id === candidate.id); return <tr key={candidate.id}><td><Link to={`/candidates/${candidate.id}`}>{candidate.title}</Link><p className="muted">{candidate.external_id || (candidate.is_demo ? "示例候选" : mode === "pilot" ? "团队录入" : "用户录入")}</p></td><td>{statusText[candidate.business_status ?? ""] ?? candidate.business_status ?? "待开始"}<p className="muted">初筛：{statusText[candidate.screening_status ?? ""] ?? candidate.screening_status ?? "待核验"}</p></td><td>{item ? <Link to={item.href}>{item.action_label}</Link> : <Link to={`/candidates/${candidate.id}`}>查看候选</Link>}<p className="muted">{item?.reason ?? "查看完整资料和历史记录"}</p></td><td>{item ? workOwnerLabel(item.owner_id, members) : "暂时无需处理"}</td></tr>; })}</tbody></table></div> : <div className="empty"><strong>尚未纳入候选</strong><p>可手工添加商品链接、导入 CSV，或按方向查找候选。</p></div>}</section>;
}

function MaterialList({ fields, template }: { fields: string[]; template?: ProjectTemplate }) { return <ul className="material-list">{fields.map((key) => <li key={key}>{fieldLabel(key, template)}</li>)}</ul>; }
function CriteriaSummary({ criteria, template }: { criteria: Criteria; template?: ProjectTemplate }) { return <div className="criteria-summary"><h3>硬性门槛</h3>{criteria.rules?.length ? <ul>{criteria.rules.map((rule) => <li key={rule.field}>{ruleText(rule, template)}</li>)}</ul> : <p>当前没有硬性门槛，先整理并核验材料。</p>}<h3>必须核验的材料</h3><MaterialList fields={criteria.required_evidence ?? []} template={template} />{criteria.research_learning && <p><strong>继承的研究启示：</strong>{criteria.research_learning}</p>}</div>; }
