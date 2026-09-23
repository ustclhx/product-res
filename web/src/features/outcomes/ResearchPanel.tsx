import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { api, command } from "../../app/client";
import { useWorkspace } from "../../app/workspace";
import "./outcomes.css";

type Rule = { field: string; operator: "lte" | "gte" | "eq"; threshold: string; unit: string; currency?: string | null };
type Criteria = { id: string; rules: Rule[]; required_evidence: string[] };
type Conclusion = { id: string; version: number; disposition: "STOP" | "HOLD"; reason: string; learning: string; source_locator: string; data_origin: "REAL" | "TEST" | "DEMO"; evidence_ids: string[]; source_ids: string[]; criteria_snapshot: { rules: Rule[]; required_evidence: string[] }; decided_at: string };
type Feedback = { id: string; version: number; research_conclusion_id: string; reason: string; status: "PROPOSED" | "CONFIRMED" | "REJECTED"; before_rules: Rule[]; after_rules: Rule[]; before_required_evidence: string[]; after_required_evidence: string[]; research_learning?: string | null };
type Material = { id: string; field?: string; source_ref?: string; source_url?: string; source_locator?: string };
type ResearchData = { candidate: { id: string; title: string; version: number }; project: { id: string; channel: string; analyst_id?: string | null; decision_owner_id?: string | null }; criteria: Criteria | null; conclusions: Conclusion[]; feedback: Feedback[]; evidence: Material[]; sources: Material[]; closure: { research_conclusion_count: number; confirmed_feedback_count: number; adopted_feedback_count: number; commercial_outcome_count: number; commercial_reviewed: boolean } };

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "操作未完成，请检查输入后重试"; }
function lines(value: string): string[] { return value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean); }

export function ResearchPanel({ candidateId }: { candidateId: string }) {
  const { mode, actor, refreshToken, refresh: refreshWorkspace } = useWorkspace();
  const query = useQuery({ queryKey: ["candidate-research", candidateId, refreshToken], queryFn: () => api<ResearchData>(`/candidates/${candidateId}/research`), retry: false });
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const data = query.data;
  const latest = data?.conclusions.at(-1);
  const latestFeedback = (data?.feedback ?? []).filter((item) => item.research_conclusion_id === latest?.id);
  const isDecisionOwner = data?.project.decision_owner_id === actor;
  const isAnalyst = data?.project.analyst_id === actor;

  async function refresh(message: string): Promise<void> { setNotice(message); await query.refetch(); refreshWorkspace(); }
  async function conclude(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault(); if (!data) return;
    setBusy(true); setError(""); setNotice("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await command(`/candidates/${candidateId}/research-conclusions`, {
        expected_version: data.candidate.version,
        disposition: text(form, "disposition"), reason: text(form, "reason"), learning: text(form, "learning"),
        source_locator: text(form, "source_locator"), data_origin: mode === "pilot" ? text(form, "data_origin") : "DEMO",
        evidence_ids: form.getAll("evidence_ids").map(String), source_ids: form.getAll("source_ids").map(String),
      });
      formElement.reset(); await refresh("研究结论已记录。候选商业状态、批准和经营结果均未改变。");
    } catch (caught) { setError(errorMessage(caught)); } finally { setBusy(false); }
  }
  async function propose(event: FormEvent<HTMLFormElement>, afterRules: Rule[]): Promise<void> {
    event.preventDefault(); if (!latest) return;
    setBusy(true); setError(""); setNotice(""); const form = new FormData(event.currentTarget);
    try {
      await command(`/research-conclusions/${latest.id}/feedback-proposals`, {
        expected_version: latest.version, before_rules: latest.criteria_snapshot.rules, after_rules: afterRules,
        before_required_evidence: latest.criteria_snapshot.required_evidence,
        after_required_evidence: lines(text(form, "required_evidence")),
        research_learning: text(form, "research_learning"), reason: text(form, "feedback_reason"),
      });
      await refresh("回流建议已提交，等待项目决策负责人确认。");
    } catch (caught) { setError(errorMessage(caught)); } finally { setBusy(false); }
  }
  async function decide(item: Feedback, confirm: boolean, reason?: string): Promise<void> {
    setBusy(true); setError("");
    try {
      await command(`/feedback-proposals/${item.id}/${confirm ? "confirm" : "reject"}`, { expected_version: item.version, ...(confirm ? {} : { reason }) });
      await refresh(confirm ? "建议已确认，可在新项目中采用。" : "建议已拒绝并保留记录。");
    } catch (caught) { setError(errorMessage(caught)); } finally { setBusy(false); }
  }

  if (!data) return <section className="panel research-panel" aria-labelledby="research-title"><h2 id="research-title">研究处置</h2>{query.isPending ? <p role="status">正在加载研究资料…</p> : <div className="error" role="alert">{errorMessage(query.error)} <button type="button" onClick={() => void query.refetch()}>重试</button></div>}</section>;
  return <section className="panel research-panel" aria-labelledby="research-title">
    <div className="outcome-section-heading"><div><h2 id="research-title">研究处置</h2><p className="muted">停止或暂缓仅记录研究判断，不代表采购批准、经营结果或商业完成。</p></div><span className="badge">研究 {data.closure.research_conclusion_count} · 经营结果 {data.closure.commercial_outcome_count}</span></div>
    {error && <p className="error" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    <dl className="outcome-facts"><div><dt>当前研究标准</dt><dd>{data.criteria ? `${data.criteria.rules.length} 条规则 · ${data.criteria.required_evidence.length} 项必需材料` : "尚未确认"}</dd></div><div><dt>反馈进度</dt><dd>已确认 {data.closure.confirmed_feedback_count} · 已用于新项目 {data.closure.adopted_feedback_count}</dd></div><div><dt>经营闭环</dt><dd>{data.closure.commercial_reviewed ? "已复盘" : "未完成（与研究闭环分开）"}</dd></div></dl>
    {isDecisionOwner ? <details><summary>记录停止或暂缓结论</summary><form className="research-form" onSubmit={(event) => void conclude(event)}><div className="form-grid"><label className="field">研究处置<select name="disposition" defaultValue="HOLD"><option value="HOLD">暂缓，等待更多条件</option><option value="STOP">停止本轮研究</option></select></label>{mode === "pilot" && <label className="field">资料类型<select name="data_origin" defaultValue="REAL"><option value="REAL">真实研究资料</option><option value="TEST">联调测试资料</option></select></label>}<label className="field wide">来源定位<input name="source_locator" required placeholder="供应商报价编号、访谈记录或材料位置" /></label></div><label className="field">判断原因<textarea name="reason" required /></label><label className="field">下一轮启示<textarea name="learning" required /></label><fieldset><legend>本候选证据（至少一项）</legend><div className="research-checks">{data.evidence.map((item) => <label key={item.id}><input type="checkbox" name="evidence_ids" value={item.id} required={data.evidence.length === 1} />{item.field ?? item.source_locator ?? item.id}</label>)}</div>{data.evidence.length === 0 && <p className="empty">请先为候选补充可追溯证据。</p>}</fieldset>{data.sources.length > 0 && <fieldset><legend>候选自身来源</legend><div className="research-checks">{data.sources.map((item) => <label key={item.id}><input type="checkbox" name="source_ids" value={item.id} />{item.source_ref ?? item.source_url ?? item.id}</label>)}</div></fieldset>}<button className="primary" disabled={busy || data.evidence.length === 0 || !data.criteria}>{busy ? "正在保存…" : "保存研究结论"}</button></form></details> : <p className="muted">只有项目决策负责人可以记录停止或暂缓结论。</p>}
    {latest && <div className="research-history"><h3>最近结论</h3><p><span className={`badge ${latest.disposition === "HOLD" ? "warning" : ""}`}>{latest.disposition === "HOLD" ? "暂缓" : "停止"}</span> {latest.reason}</p><p><strong>下一轮启示：</strong>{latest.learning}</p><p className="muted">来源 {latest.source_locator} · {latest.data_origin} · 冻结证据 {latest.evidence_ids.length} 项</p>{isAnalyst && <ResearchFeedbackForm key={latest.id} conclusion={latest} busy={busy} onSubmit={propose} />}</div>}
    {latestFeedback.map((item) => <article className="feedback-card" key={item.id}><div className="outcome-section-heading"><strong>{item.reason}</strong><span className="badge">{item.status === "PROPOSED" ? "待确认" : item.status === "CONFIRMED" ? "已确认" : "已拒绝"}</span></div>{item.research_learning && <p>{item.research_learning}</p>}<p className="muted">必需材料：{item.after_required_evidence.join("、") || "无"}</p>{item.status === "PROPOSED" && isDecisionOwner && <div className="feedback-actions"><button type="button" className="primary" disabled={busy} onClick={() => void decide(item, true)}>确认建议</button><button type="button" className="secondary" disabled={busy} onClick={() => { const reason = window.prompt("请输入拒绝原因"); if (reason?.trim()) void decide(item, false, reason.trim()); }}>拒绝</button></div>}{item.status === "CONFIRMED" && <Link to={`/projects?source_feedback_id=${encodeURIComponent(item.id)}&channel=${encodeURIComponent(data.project.channel)}`}>基于这条反馈创建新项目</Link>}</article>)}
  </section>;
}

function ResearchFeedbackForm({ conclusion, busy, onSubmit }: { conclusion: Conclusion; busy: boolean; onSubmit: (event: FormEvent<HTMLFormElement>, rules: Rule[]) => Promise<void> }) {
  const [rules, setRules] = useState(conclusion.criteria_snapshot.rules.map((rule) => ({ ...rule })));
  function update(index: number, patch: Partial<Rule>): void { setRules((current) => current.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...patch } : rule)); }
  return <details><summary>提出下一项目反馈</summary><form onSubmit={(event) => void onSubmit(event, rules)}><div className="rule-editors">{rules.map((rule, index) => <fieldset key={index}><legend>规则 {index + 1}</legend><div className="form-grid"><label className="field">业务字段<input required value={rule.field} onChange={(event) => update(index, { field: event.target.value })} /></label><label className="field">比较方式<select value={rule.operator} onChange={(event) => update(index, { operator: event.target.value as Rule["operator"] })}><option value="lte">不高于</option><option value="gte">不低于</option><option value="eq">等于</option></select></label><label className="field">阈值<input required value={rule.threshold} onChange={(event) => update(index, { threshold: event.target.value })} /></label><label className="field">单位<input required value={rule.unit} onChange={(event) => update(index, { unit: event.target.value })} /></label><label className="field">币种（可选）<input maxLength={3} value={rule.currency ?? ""} onChange={(event) => update(index, { currency: event.target.value.toUpperCase() || null })} /></label><button type="button" className="secondary" onClick={() => setRules((current) => current.filter((_, ruleIndex) => ruleIndex !== index))}>移除规则</button></div></fieldset>)}</div><button type="button" className="secondary" onClick={() => setRules((current) => [...current, { field: "", operator: "lte", threshold: "", unit: "" }])}>新增规则</button><label className="field">必需材料（每行一项）<textarea name="required_evidence" defaultValue={conclusion.criteria_snapshot.required_evidence.join("\n")} required /></label><label className="field">可继承的研究启示<textarea name="research_learning" defaultValue={conclusion.learning} /></label><label className="field">调整依据<textarea name="feedback_reason" required /></label><button className="primary" disabled={busy}>提交回流建议</button></form></details>;
}

export default ResearchPanel;
