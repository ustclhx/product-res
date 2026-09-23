import { FormEvent, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, command } from "../../app/client";
import { useWorkspace } from "../../app/workspace";
import { memberLabel, membersForRole } from "../../app/members";
import { useWorkItems } from "../../app/workItems";
import type { Channel, Criteria, Project, ProjectTemplate } from "./types";
import "./projects.css";

const channelLabels: Record<Channel, string> = { AMAZON: "Amazon", EBAY: "eBay", DTC: "独立站" };
const emptyForm = { name: "", channel: "AMAZON" as Channel, market: "", direction: "", goal: "", constraints: "", analyst_id: "analyst", decision_owner_id: "owner" };

export default function ProjectsPage() {
  const { mode, actor, session, members, refresh } = useWorkspace();
  const navigate = useNavigate();
  const analysts = mode === "pilot" ? membersForRole(members, "analyst") : [];
  const decisionOwners = mode === "pilot" ? membersForRole(members, "decision", "owner") : [];
  const defaults = { analyst_id: mode === "pilot" ? analysts.find((item) => item.id === actor)?.id ?? analysts[0]?.id ?? "" : "analyst", decision_owner_id: mode === "pilot" ? decisionOwners.find((item) => item.id === actor)?.id ?? decisionOwners[0]?.id ?? "" : "owner" };
  const [searchParams, setSearchParams] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [form, setForm] = useState<typeof emptyForm>(() => {
    const selected = searchParams.get("channel");
    return { ...emptyForm, ...defaults, market: mode === "pilot" ? "US" : "", channel: selected === "EBAY" || selected === "DTC" ? selected : "AMAZON" };
  });
  const [open, setOpen] = useState(searchParams.get("new") === "1" || Boolean(searchParams.get("source_feedback_id")));
  const [error, setError] = useState("");
  const query = useQuery({ queryKey: ["project-templates"], queryFn: () => api<{ items: ProjectTemplate[] }>("/project-templates"), retry: false });
  const workQuery = useWorkItems();
  const projects = workQuery.data?.projects ?? [];
  const templates = query.data?.items ?? [];
  const template = templates.find((item) => item.channel === form.channel);

  function closeForm() {
    setOpen(false); setStep(1); setError("");
    const next = new URLSearchParams(searchParams); next.delete("new"); setSearchParams(next, { replace: true });
  }
  function continueToOwners(event: FormEvent) {
    event.preventDefault(); setError("");
    if (!form.name.trim() || !form.market.trim() || !form.direction.trim() || !form.goal.trim()) { setError("请补齐项目名称、目标市场、研究方向和项目目标。"); return; }
    setStep(2);
  }
  async function create(event: FormEvent) {
    event.preventDefault(); setError("");
    setBusy(true);
    try {
      const result = await command<{ project: Project; criteria: Criteria | null }>("/projects", { ...form, analyst_id: form.analyst_id || null, decision_owner_id: form.decision_owner_id || null, expected_version: null, constraints: form.constraints.split("\n").map((item) => item.trim()).filter(Boolean), source_feedback_id: searchParams.get("source_feedback_id") });
      refresh();
      void navigate(`/projects/${result.project.id}?${result.criteria ? "intake=1" : "view=criteria"}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "创建失败，请稍后重试"); }
    finally { setBusy(false); }
  }

  return <div className="feature-page projects-page">
    <div className="page-heading"><div><h1>选品项目</h1><p>从业务方向建立项目，再确认材料范围并开始收集候选。</p><p className="muted">当前成员：{mode === "pilot" ? session?.user.display_name ?? session?.user.name ?? session?.user.username ?? "工作区成员" : actor === "owner" ? "决策负责人" : actor === "contributor" ? "补证成员" : "分析负责人"}</p></div><button className="primary" type="button" onClick={() => { setOpen(true); setStep(1); }}>新建项目</button></div>
    {searchParams.get("source_feedback_id") && <p className="notice">新项目将继承已确认的复盘标准；创建后可直接开始收集候选。</p>}
    {error && <div className="error" role="alert">{error}</div>}
    {open && <section className="panel project-create" aria-labelledby="project-create-title">
      <div className="panel-heading"><div><h2 id="project-create-title">新建选品项目</h2><p className="muted">第 {step} 步，共 2 步</p></div><button type="button" className="secondary" onClick={closeForm}>关闭</button></div>
      <ol className="create-steps" aria-label="创建进度"><li className={step === 1 ? "active" : "complete"}>1 业务方向</li><li className={step === 2 ? "active" : ""}>2 负责人和材料</li></ol>
      {step === 1 ? <form className="form-grid project-form" onSubmit={continueToOwners}>
        <label className="field field-wide">项目名称<input autoFocus required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：2026 春季家居收纳" /></label>
        <label className="field">渠道<select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value as Channel })}>{Object.entries(channelLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><small>{template?.description ?? "选择渠道后套用对应材料模板"}</small></label>
        <label className="field">目标市场{mode === "pilot" ? <select value="US" disabled><option value="US">美国（US）</option></select> : <input required value={form.market} onChange={(e) => setForm({ ...form, market: e.target.value })} placeholder="例如：美国" />}</label>
        <label className="field field-wide">研究方向<input required value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })} placeholder="例如：户外露营收纳" /></label>
        <label className="field field-wide">项目目标<textarea required value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} placeholder="希望验证什么，什么结果才值得继续？" /></label>
        <label className="field field-wide">限制条件<textarea value={form.constraints} onChange={(e) => setForm({ ...form, constraints: e.target.value })} placeholder="每行一条，例如预算、履约或合规边界" /></label>
        <div className="form-actions"><button className="primary" type="submit">下一步：安排负责人</button></div>
      </form> : <form className="project-form" onSubmit={(event) => void create(event)}>
        <div className="form-grid">
          <label className="field">分析负责人<select value={form.analyst_id} onChange={(e) => setForm({ ...form, analyst_id: e.target.value })}><option value="">暂不指定</option>{mode === "demo" ? <option value="analyst">林晓 · 选品分析</option> : analysts.map((member) => <option value={member.id} key={member.id}>{memberLabel(member)}</option>)}</select><small>协调候选和材料收集</small></label>
          <label className="field">决策负责人<select value={form.decision_owner_id} onChange={(e) => setForm({ ...form, decision_owner_id: e.target.value })}><option value="">暂不指定</option>{mode === "demo" ? <option value="owner">陈越 · 决策负责人</option> : decisionOwners.map((member) => <option value={member.id} key={member.id}>{memberLabel(member)}</option>)}</select><small>确认标准并做人工决策</small></label>
        </div>
        <div className="materials-preview"><h3>首次确认前建议核对的材料</h3><p className="muted">创建只保存项目草稿，不会自动确认标准，也不会发起外部查询。</p><ul>{(template?.required_evidence ?? []).map((key) => <li key={key}>{template?.fields?.find((item) => item.key === key)?.label ?? key}</li>)}</ul></div>
        <div className="form-actions"><button className="secondary" type="button" onClick={() => { setStep(1); setError(""); }}>返回修改</button><button className="primary" type="submit" disabled={busy}>{busy ? "正在保存…" : searchParams.get("source_feedback_id") ? "创建并收集候选" : "保存草稿并确认标准"}</button></div>
      </form>}
    </section>}
    <section aria-label="项目列表">{workQuery.isPending ? <p role="status">正在加载项目…</p> : workQuery.isError ? <div className="error" role="alert">{workQuery.error.message} <button type="button" onClick={() => void workQuery.refetch()}>重试</button></div> : projects.length === 0 ? <div className="empty"><strong>还没有选品项目</strong><p>先建立业务方向和负责人，再确认标准、收集候选。</p><button className="primary" type="button" onClick={() => setOpen(true)}>新建第一个项目</button></div> : <div className="project-list table-scroll"><table><thead><tr><th>项目</th><th>负责人</th><th>当前下一步</th><th></th></tr></thead><tbody>{projects.map((project) => <tr key={project.id}><td><Link to={`/projects/${project.id}`}>{project.name}</Link><p className="muted">{channelLabels[project.channel as Channel] ?? project.channel} · {project.market || "市场待补充"} · {project.direction || "方向待填写"}</p><p className="muted">{project.candidate_count} 个候选 · {project.open_item_count} 个待办</p></td><td>{project.analyst_id ? displayMember(project.analyst_id, members, mode) : "待指定分析负责人"}</td><td>{project.next_action}</td><td><Link className="secondary" to={project.href}>继续</Link></td></tr>)}</tbody></table></div>}</section>
  </div>;
}

function displayMember(id: string, members: ReturnType<typeof useWorkspace>["members"], mode: "demo" | "pilot") {
  if (mode === "demo") return id === "owner" ? "陈越" : id === "analyst" ? "林晓" : "项目成员";
  const member = members.find((item) => item.id === id); return member ? memberLabel(member) : "工作区成员";
}
