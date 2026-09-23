import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api, command } from "../../app/client";
import { useWorkspace } from "../../app/workspace";
import { JobStatus } from '../pilot/JobStatus';
import { useDurableJob, type PilotJob } from '../pilot/jobs';
import "./outcomes.css";

type Rule = { field: string; operator: "lte" | "gte" | "eq"; threshold: string; unit?: string | null; currency?: string | null };
type Outcome = { id: string; version: number; approval_id: string; status: "RECORDED" | "NOT_LAUNCHED"; window_start?: string | null; window_end?: string | null; currency?: string | null; units?: string | null; revenue_basis?: "GROSS" | "NET" | null; metrics?: Record<string, string | null>; source_locator?: string; source_revision?: string | null; data_origin?: "REAL" | "TEST" | "DEMO"; sku?: string | null; listing_id?: string | null; test_id?: string | null; reason?: string | null; created_at?: string };
type Feedback = { id: string; version: number; outcome_id: string; before_rules: Rule[]; after_rules: Rule[]; before_required_evidence?: string[]; after_required_evidence?: string[]; research_learning?: string | null; reason: string; status: "PROPOSED" | "CONFIRMED" | "REJECTED"; new_criteria_id?: string | null };
type Aggregate = {
  candidate: { id: string; title: string; approval_id?: string | null; business_status?: string; version: number };
  project: { id: string; name: string; channel: string };
  criteria_versions?: Array<{ id: string; version: number; rules?: Rule[]; required_evidence?: string[] }>;
  outcomes?: Outcome[];
  feedback?: Feedback[];
  decisions?: Array<{ id: string; action: string; reason: string; criteria_id?: string | null; evaluation_id?: string | null }>;
};
type ComparisonField = { forecast?: string | number | null; actual?: string | null; variance?: string | null; comparable: boolean; reasons?: string[] };
type Comparison = { fields: Record<string, ComparisonField>; comparable: boolean; basis_comparable: boolean; contribution_comparable: boolean; reasons: string[]; forecast_contribution_per_unit: string | null; actual_contribution_per_unit: string | null; contribution_variance_per_unit: string | null; profit_label: string };
type RowMapping = { candidate_id: string; approval_id: string };
type PreviewRow = { row: number; mapping: RowMapping | null; errors: string[]; duplicate_outcome_id: string | null; valid: boolean };
type CSVPreview = { content_hash: string; rows: PreviewRow[]; row_count: number };
type Mappings = Record<string, Partial<RowMapping>>;
type PreviewState = CSVPreview & { mappings: Mappings };

const metricNames = ["revenue", "refunds", "procurement", "platform", "fulfillment", "advertising", "other"] as const;
const fieldLabels: Record<string, string> = { units: "销量", revenue: "收入", refunds: "退款", procurement: "采购成本", platform: "平台费用", fulfillment: "履约费用", advertising: "广告费用", other: "其他费用" };
const reasonLabels: Record<string, string> = { NOT_LAUNCHED: "商品未上市", WINDOW_START_MISMATCH: "开始日期与预测不同", WINDOW_END_MISMATCH: "结束日期与预测不同", CURRENCY_MISMATCH: "币种与预测不同", REVENUE_BASIS_MISMATCH: "收入口径与预测不同", FORECAST_MISSING: "批准预测缺失", ACTUAL_MISSING: "实际结果缺失", FORECAST_ZERO_UNITS: "预测销量为零", ZERO_UNITS: "实际销量为零" };

function value(form: FormData, name: string): string { const item = form.get(name); return typeof item === "string" ? item.trim() : ""; }
function message(error: unknown): string { return error instanceof Error ? error.message : "操作未完成，请检查输入后重试"; }
function utcDate(date: string): string { return `${date}T00:00:00Z`; }
function describeReason(reason: string): string {
  if (reason.startsWith("FORECAST_MISSING:")) return `批准预测缺少：${reason.slice(17).split(",").map((item) => fieldLabels[item] ?? item).join("、")}`;
  if (reason.startsWith("ACTUAL_MISSING:")) return `实际结果缺少：${reason.slice(15).split(",").map((item) => fieldLabels[item] ?? item).join("、")}`;
  return reasonLabels[reason] ?? reason;
}
function cleanMappings(mappings: Mappings): Mappings {
  return Object.fromEntries(Object.entries(mappings).flatMap(([row, mapping]) => {
    const cleaned = Object.fromEntries(Object.entries(mapping).filter((entry): entry is [keyof RowMapping, string] => Boolean(entry[1]?.trim())).map(([field, item]) => [field, item.trim()]));
    return Object.keys(cleaned).length > 0 ? [[row, cleaned]] : [];
  }));
}

export default function OutcomePage() {
  const { mode, refreshToken, refresh: refreshWorkspace } = useWorkspace();
  const { id = "" } = useParams();
  const [tab, setTab] = useState<"input" | "review">("input");
  const [manual, setManual] = useState(true);
  const [selectedOutcomeId, setSelectedOutcomeId] = useState<string>();
  const [csv, setCsv] = useState("");
  const [draftMappings, setDraftMappings] = useState<Mappings>({});
  const [csvPreview, setCsvPreview] = useState<PreviewState>();
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [showProposal, setShowProposal] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const aggregateQuery = useQuery({ queryKey: ["candidate-outcomes", id, refreshToken], queryFn: () => id ? api<Aggregate>(`/candidates/${id}`) : Promise.reject(new Error("候选标识缺失。")), retry: false });
  const data = aggregateQuery.data;
  const outcomes = data?.outcomes ?? [];
  const latestOutcome = outcomes[outcomes.length - 1];
  const outcome = outcomes.find((item) => item.id === selectedOutcomeId) ?? latestOutcome;
  const comparisonQuery = useQuery({ queryKey: ["outcome-comparison", outcome?.id], queryFn: () => api<Comparison>(`/outcomes/${outcome?.id ?? ""}/comparison`), enabled: Boolean(outcome), retry: false });
  const approvalId = outcome?.approval_id ?? data?.candidate.approval_id;
  const approval = data?.decisions?.find((item) => item.id === approvalId && item.action === "APPROVE");
  const approvedCriteria = data?.criteria_versions?.find((item) => item.id === approval?.criteria_id);
  const approvedRules = approvedCriteria?.rules ?? [];
  const approvedEvidence = approvedCriteria?.required_evidence ?? [];
  const feedback = (data?.feedback ?? []).filter((item) => item.outcome_id === outcome?.id);
  const queryError = aggregateQuery.error ?? comparisonQuery.error;

  async function refresh(options?: { selectLatest?: boolean }): Promise<void> {
    refreshWorkspace();
    if (options?.selectLatest) setSelectedOutcomeId(undefined);
    await aggregateQuery.refetch();
    if (!options?.selectLatest && outcome) await comparisonQuery.refetch();
  }
  async function previewCSV(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault(); setError(""); setNotice("");
    const mappings = cleanMappings(draftMappings);
    try {
      const result = await command<CSVPreview>("/outcome-imports/preview", { csv_text: csv, mappings });
      const effectiveMappings = Object.fromEntries(result.rows.flatMap((row) => {
        const mapping = { ...(row.mapping ?? {}), ...mappings[String(row.row)] };
        return Object.keys(mapping).length > 0 ? [[String(row.row), mapping]] : [];
      }));
      setCsvPreview({ ...result, mappings: effectiveMappings }); setSelectedRows([]);
      setDraftMappings(effectiveMappings);
      setNotice(`已检查 ${result.row_count} 行，请逐行选择要写入的记录。`);
    } catch (caught) { setError(message(caught)); }
  }
  async function confirmCSV(): Promise<void> {
    if (!csvPreview || selectedRows.length === 0) return;
    setError("");
    try {
      await command("/outcome-imports/confirm", { csv_text: csv, content_hash: csvPreview.content_hash, selected_rows: selectedRows, mappings: csvPreview.mappings });
      setCsvPreview(undefined); setSelectedRows([]); setDraftMappings({}); setCsv(""); setNotice("所选 CSV 行已写入。若刚新增多条结果，当前显示最新一条。");
      await refresh({ selectLatest: true });
    } catch (caught) { setError(message(caught)); }
  }
  async function finalize(): Promise<void> {
    if (!data) return;
    setError("");
    try { await command(`/candidates/${id}/finalize-review`, { expected_version: data.candidate.version }); setNotice("结果复盘已完成。"); await refresh(); }
    catch (caught) { setError(message(caught)); }
  }
  if (!data) return <div className="feature-page outcomes-page">{aggregateQuery.isPending ? <p role="status">正在加载结果资料…</p> : <div className="error" role="alert"><strong>无法打开结果资料</strong><p>{message(aggregateQuery.error)}</p><button type="button" onClick={() => void aggregateQuery.refetch()}>重试</button></div>}</div>;

  return <div className="feature-page outcomes-page">
    <header className="page-heading"><div><nav aria-label="面包屑"><Link to={`/projects/${data.project.id}`}>{data.project.name}</Link> / 结果复盘</nav><h1>{data.candidate.title}</h1><p>回填真实经营结果，并与当时批准所依据的预测和标准比较。</p></div><span className="badge">{data.candidate.business_status === "REVIEWED" ? "已复盘" : "待复盘"}</span></header>
    {(error || queryError) && <div className="error" role="alert">{error || message(queryError)} <button type="button" onClick={() => void refresh()}>刷新资料</button></div>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <section className="panel approval-summary">
      <div className="outcome-section-heading"><div><h2>批准时的依据</h2><p className="muted">批准记录和标准版本保持原样，不随项目当前标准变化。</p></div><code>{approvalId ?? "无批准记录"}</code></div>
      {approval ? <blockquote><p>{approval.reason}</p><small>评估 {approval.evaluation_id ?? "未记录"} · 标准 {approval.criteria_id ?? "未记录"}</small></blockquote> : <p className="empty">未找到与该结果关联的批准记录。</p>}
      {approvedCriteria ? <RuleList title="批准标准快照" rules={approvedRules} /> : <p className="muted">批准标准快照不可用，暂不能提交标准调整建议。</p>}
    </section>
    <section className="panel">
      <div className="tabs" role="tablist" aria-label="结果处理"><button type="button" role="tab" aria-selected={tab === "input"} onClick={() => setTab("input")}>录入结果</button><button type="button" role="tab" aria-selected={tab === "review"} disabled={!outcome} onClick={() => setTab("review")}>比较与复盘</button></div>
      {tab === "input" ? <><div className="toolbar"><button type="button" className={manual ? "primary" : "secondary"} onClick={() => setManual(true)}>手工录入</button><button type="button" className={!manual ? "primary" : "secondary"} onClick={() => setManual(false)}>CSV 导入</button></div>
        {manual ? <ManualOutcome mode={mode} candidate={data.candidate} approvalId={data.candidate.approval_id} onDone={async () => { setNotice("结果已保存，当前显示最新一条。"); await refresh({ selectLatest: true }); }} onError={setError} /> : <form onSubmit={(event) => void previewCSV(event)}><label className="field">CSV 内容<textarea value={csv} onChange={(event) => { setCsv(event.target.value); setCsvPreview(undefined); setSelectedRows([]); }} required placeholder="粘贴带表头的 UTF-8 CSV；候选、批准、REAL/TEST 来源和 SKU/Listing/测试标识均按列提供。" /></label><p className="muted">试点 CSV 必须明确 REAL 或 TEST。无法唯一映射到候选及批准轮次的行不会写入。</p><button className="primary">检查 CSV</button>{csvPreview && <CSVRows preview={csvPreview} mappings={draftMappings} selectedRows={selectedRows} onMappingChange={(row, field, next) => setDraftMappings((current) => ({ ...current, [row]: { ...current[row], [field]: next } }))} onSelectionChange={(row, selected) => setSelectedRows((current) => selected ? [...current, row] : current.filter((item) => item !== row))} onConfirm={() => void confirmCSV()} />}</form>}
      </> : outcome ? <Review candidate={data.candidate} outcome={outcome} comparison={comparisonQuery.data} comparisonPending={comparisonQuery.isPending} feedback={feedback} channel={data.project.channel} onReload={refresh} onError={setError} onNotice={setNotice} onPropose={() => setShowProposal(true)} /> : null}
    </section>
    {outcomes.length > 0 && <section className="panel outcome-history"><div className="outcome-section-heading"><div><h2>结果记录</h2><p className="muted">默认显示最新结果，也可切换历史记录复核。</p></div><label>当前记录<select value={outcome?.id ?? ""} onChange={(event) => setSelectedOutcomeId(event.target.value)}>{[...outcomes].reverse().map((item, index) => <option key={item.id} value={item.id}>{index === 0 ? "最新 · " : ""}{item.status === "RECORDED" ? "已记录" : "未上市"} · {item.data_origin === 'REAL' ? '真实' : item.data_origin === 'TEST' ? '测试' : '样例'} · {item.created_at ? new Date(item.created_at).toLocaleString("zh-CN", { hour12: false }) : item.id}</option>)}</select></label></div>{outcome && <dl className="outcome-facts"><div><dt>状态</dt><dd>{outcome.status === "RECORDED" ? "已记录经营结果" : "未上市"}</dd></div><div><dt>数据类型</dt><dd><span className={`badge ${outcome.data_origin === 'TEST' ? 'warning' : ''}`}>{outcome.data_origin === 'REAL' ? '真实经营' : outcome.data_origin === 'TEST' ? '联调测试，不计入真实统计' : '样例数据'}</span></dd></div><div><dt>数据来源</dt><dd>{outcome.source_locator ?? "未记录"}{outcome.source_revision ? ` · 修订 ${outcome.source_revision}` : ''}</dd></div><div><dt>业务映射</dt><dd>{[['SKU',outcome.sku],['Listing',outcome.listing_id],['测试标识',outcome.test_id]].filter(([,value]) => value).map(([label,value]) => `${label} ${value}`).join(' · ') || '未记录外部业务标识'}</dd></div><div><dt>统计窗口</dt><dd>{outcome.window_start && outcome.window_end ? `${outcome.window_start} 至 ${outcome.window_end}` : "不适用"}</dd></div>{outcome.reason && <div><dt>原因</dt><dd>{outcome.reason}</dd></div>}</dl>}</section>}
    {showProposal && outcome && approvedCriteria && <FeedbackProposal outcome={outcome} before={approvedRules} beforeEvidence={approvedEvidence} onClose={() => setShowProposal(false)} onDone={async () => { setShowProposal(false); setNotice("标准调整建议已提交，等待决策负责人处理。"); await refresh(); }} onError={setError} />}
    {outcome && data.candidate.business_status === "OUTCOME_PENDING" && <div className="finalize"><div><strong>完成最新结果的复盘</strong><p className="muted">后端会核对最新结果是否已有复盘，以及所有反馈建议是否均已处理。</p></div><button type="button" className="primary" onClick={() => void finalize()}>完成复盘</button></div>}
  </div>;
}

function RuleList({ title, rules }: { title: string; rules: Rule[] }) {
  return <div className="rule-list"><h3>{title}</h3>{rules.length === 0 ? <p className="muted">本版标准没有硬性规则。</p> : <ul>{rules.map((rule, index) => <li key={`${rule.field}-${index}`}><strong>{fieldLabels[rule.field] ?? rule.field}</strong><span>{rule.operator === "lte" ? "不高于" : rule.operator === "gte" ? "不低于" : "等于"} {rule.threshold} {rule.currency ? `${rule.currency} ` : ""}{rule.unit ?? ""}</span></li>)}</ul>}</div>;
}

function ManualOutcome({ mode, candidate, approvalId, onDone, onError }: { mode: 'demo' | 'pilot'; candidate: Aggregate["candidate"]; approvalId?: string | null; onDone: () => Promise<void>; onError: (error: string) => void }) {
  const [notLaunched, setNotLaunched] = useState(false); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault(); onError(""); setBusy(true); const formElement = event.currentTarget; const form = new FormData(formElement);
    const dataOrigin = mode === 'pilot' ? value(form, 'data_origin') : 'DEMO';
    const common = { expected_version: candidate.version, approval_id: approvalId ?? null, source_locator: value(form, "source"), source_revision: value(form, 'source_revision') || null, data_origin: dataOrigin, is_demo: dataOrigin === 'DEMO', sku: value(form, 'sku') || null, listing_id: value(form, 'listing_id') || null, test_id: value(form, 'test_id') || null };
    const payload = notLaunched ? { ...common, status: "NOT_LAUNCHED", reason: value(form, "reason") } : { ...common, status: "RECORDED", window_start: utcDate(value(form, "start")), window_end: utcDate(value(form, "end")), currency: value(form, "currency").toUpperCase(), units: value(form, "units"), revenue_basis: value(form, "basis"), metrics: Object.fromEntries(metricNames.map((name) => [name, value(form, name) || null])), reason: value(form, "reason") || null };
    try { await command(`/candidates/${candidate.id}/outcomes`, payload); formElement.reset(); setNotLaunched(false); await onDone(); }
    catch (caught) { onError(message(caught)); } finally { setBusy(false); }
  }
  return <form onSubmit={(event) => void submit(event)}><div className="form-grid">{mode === 'pilot' ? <label className="field">数据类型<select name="data_origin" defaultValue="REAL"><option value="REAL">真实经营结果</option><option value="TEST">联调测试数据</option></select><small>测试数据不会计入真实经营统计。</small></label> : <label className="check-field"><input name="demo" type="checkbox" />这是示例数据</label>}<label className="check-field"><input type="checkbox" checked={notLaunched} onChange={(event) => setNotLaunched(event.target.checked)} />该商品未上市</label><label className="field">SKU<input name="sku" placeholder="团队 SKU（如有）" /></label><label className="field">Listing 标识<input name="listing_id" placeholder="渠道 Listing（如有）" /></label><label className="field">测试标识<input name="test_id" placeholder="仅测试批次填写" /></label></div>{notLaunched ? <label className="field">未上市原因<textarea name="reason" required /></label> : <><div className="form-grid"><label className="field">统计开始日期<input name="start" type="date" required /></label><label className="field">统计结束日期<input name="end" type="date" required /></label><label className="field">币种<input name="currency" required maxLength={3} placeholder="USD" /></label><label className="field">销量<input name="units" inputMode="decimal" required /></label><label className="field">收入口径<select name="basis" defaultValue="GROSS"><option value="GROSS">含退款前收入（GROSS）</option><option value="NET">退款后净收入（NET）</option></select></label></div><fieldset><legend>经营指标</legend><p className="muted">没有取得的数据请留空，系统会明确标为缺失，不会按零计算。</p><div className="metric-grid">{metricNames.map((name) => <label className="field" key={name}>{fieldLabels[name]}<input name={name} inputMode="decimal" placeholder="未知请留空" /></label>)}</div></fieldset></>}<div className="form-grid"><label className="field wide">数据来源定位<input name="source" required placeholder="报表链接、文件名或人工记录编号" /></label><label className="field">来源修订<input name="source_revision" placeholder="例如 2026-09 修订 2" /></label></div><button className="primary" disabled={busy}>{busy ? "正在保存…" : "保存结果"}</button></form>;
}

function CSVRows({ preview: result, mappings, selectedRows, onMappingChange, onSelectionChange, onConfirm }: { preview: PreviewState; mappings: Mappings; selectedRows: number[]; onMappingChange: (row: string, field: keyof RowMapping, value: string) => void; onSelectionChange: (row: number, selected: boolean) => void; onConfirm: () => void }) {
  const mappingChanged = JSON.stringify(cleanMappings(mappings)) !== JSON.stringify(result.mappings);
  return <div className="csv-preview"><div className="outcome-section-heading"><div><h3>逐行检查</h3><p className="muted">只有无错误的行可选择；无法自动定位时填写候选 ID，批准 ID 可用于进一步核对。</p></div><span className="badge">共 {result.row_count} 行</span></div><div className="table-scroll"><table><thead><tr><th>写入</th><th>CSV 行</th><th>状态</th><th>候选映射</th><th>批准映射</th></tr></thead><tbody>{result.rows.map((row) => { const selectable = row.errors.length === 0; const status = row.errors.length > 0 ? `错误：${row.errors.join("、")}` : row.duplicate_outcome_id ? "已有相同结果，可选择后由服务端跳过" : "可写入"; return <tr key={row.row}><td><input type="checkbox" aria-label={`选择 CSV 第 ${row.row} 行`} checked={selectedRows.includes(row.row)} disabled={!selectable} onChange={(event) => onSelectionChange(row.row, event.target.checked)} /></td><td>{row.row}</td><td><span className={row.errors.length > 0 ? "attention" : "muted"}>{status}</span>{row.duplicate_outcome_id && <small><code>{row.duplicate_outcome_id}</code></small>}</td><td><label className="sr-only" htmlFor={`candidate-${row.row}`}>第 {row.row} 行候选 ID</label><input id={`candidate-${row.row}`} value={mappings[String(row.row)]?.candidate_id ?? row.mapping?.candidate_id ?? ""} onChange={(event) => onMappingChange(String(row.row), "candidate_id", event.target.value)} placeholder="candidate_id" /></td><td><label className="sr-only" htmlFor={`approval-${row.row}`}>第 {row.row} 行批准 ID</label><input id={`approval-${row.row}`} value={mappings[String(row.row)]?.approval_id ?? row.mapping?.approval_id ?? ""} onChange={(event) => onMappingChange(String(row.row), "approval_id", event.target.value)} placeholder="approval_id（可选）" /></td></tr>; })}</tbody></table></div>{mappingChanged && <p className="notice">映射已修改。请先再次点击“检查 CSV”，确认新映射有效后再写入。</p>}<button type="button" className="primary" disabled={selectedRows.length === 0 || mappingChanged} onClick={onConfirm}>写入所选 {selectedRows.length} 行</button></div>;
}

function Review({ candidate, outcome, comparison, comparisonPending, feedback, channel, onReload, onError, onNotice, onPropose }: { candidate: Aggregate['candidate']; outcome: Outcome; comparison?: Comparison; comparisonPending: boolean; feedback: Feedback[]; channel: string; onReload: () => Promise<void>; onError: (error: string) => void; onNotice: (notice: string) => void; onPropose: () => void }) {
  const { mode } = useWorkspace();
  const reviewJob = useDurableJob<{node_run?:{id?:string};output?:Record<string,unknown>}>(`outcome-review:${candidate.id}:${outcome.id}`);
  async function submitReview(event: FormEvent<HTMLFormElement>): Promise<void> { event.preventDefault(); onError(""); const form = new FormData(event.currentTarget); try { await command(`/outcomes/${outcome.id}/reviews`, { expected_version: outcome.version, deviation_reasons: value(form, "reasons").split(/[\n,，]/).map((item) => item.trim()).filter(Boolean), notes: value(form, "notes") }); onNotice("经营结果复盘已保存。"); await onReload(); } catch (caught) { onError(message(caught)); } }
  return <div>{comparisonPending ? <p role="status">正在计算预测与实际差异…</p> : comparison && <ComparisonView comparison={comparison} />}{mode === 'pilot' && <section className="panel stack"><div className="toolbar"><div><h3>整理复盘草稿</h3><p className="muted">固定使用本次批准依据、所选结果版本和确定性比较。</p></div><button type="button" className="secondary" disabled={['QUEUED','RUNNING'].includes(reviewJob.job?.state ?? '')} onClick={() => void command<{job:PilotJob<{node_run?:{id?:string};output?:Record<string,unknown>}>}>(`/candidates/${candidate.id}/assistant-runs`, {expected_version:candidate.version,node_kind:'OUTCOME_REVIEW',outcome_id:outcome.id}).then(response => reviewJob.remember(response.job)).catch(reason => onError(message(reason)))}>整理复盘草稿</button></div><JobStatus job={reviewJob.job} error={reviewJob.error} title="复盘草稿整理">{result => <div><p>{typeof result.output?.summary === 'string' ? result.output.summary : '草稿已生成，请结合下方确定性比较人工复核。'}</p><p className="muted">模型草稿不会自动修改复盘、反馈或标准。</p></div>}</JobStatus></section>}{outcome.status === "RECORDED" ? <form className="review-form" onSubmit={(event) => void submitReview(event)}><h3>记录复盘判断</h3><label className="field">偏差原因<textarea name="reasons" required placeholder="每行填写一个原因，例如：广告费用缺失" /></label><label className="field">复盘说明<textarea name="notes" required /></label><button className="primary">保存复盘</button></form> : <div className="notice"><strong>未上市原因</strong><span>{outcome.reason ?? "未提供"}</span></div>}<div className="feedback-heading"><div><h3>标准调整建议</h3><p className="muted">建议只影响未来新项目，不改写本次批准快照。</p></div><button type="button" className="secondary" onClick={onPropose}>提出调整</button></div>{feedback.length === 0 ? <p className="muted">暂无与这条结果关联的建议。</p> : feedback.map((item) => <FeedbackCard key={item.id} feedback={item} channel={channel} onReload={onReload} onError={onError} onNotice={onNotice} />)}</div>;
}

function ComparisonView({ comparison }: { comparison: Comparison }) {
  return <section className="comparison" aria-labelledby="comparison-title"><div className="outcome-section-heading"><div><h3 id="comparison-title">预测与实际</h3><p className="muted">只有统计窗口、币种和收入口径一致时才计算数值差异。</p></div><span className={`badge ${comparison.comparable ? "" : "warning"}`}>{comparison.comparable ? "比较口径一致" : "比较口径不一致"}</span></div><div className="table-scroll"><table><thead><tr><th>指标</th><th>批准预测</th><th>实际结果</th><th>差异 / 说明</th></tr></thead><tbody>{Object.entries(comparison.fields).map(([name, field]) => <tr key={name}><td>{fieldLabels[name] ?? name}</td><td>{field.forecast ?? <span className="missing">缺失</span>}</td><td>{field.actual ?? <span className="missing">缺失</span>}</td><td>{field.comparable ? field.variance ?? "无差异" : (field.reasons ?? []).map(describeReason).join("；")}</td></tr>)}</tbody></table></div><div className="profit-comparison"><h3>单位贡献利润</h3><dl><div><dt>批准预测</dt><dd>{comparison.forecast_contribution_per_unit ?? <span className="missing">无法计算</span>}</dd></div><div><dt>实际结果</dt><dd>{comparison.actual_contribution_per_unit ?? <span className="missing">无法计算</span>}</dd></div><div><dt>差异</dt><dd>{comparison.contribution_comparable ? comparison.contribution_variance_per_unit ?? "0" : <span className="missing">不可直接比较</span>}</dd></div></dl>{!comparison.contribution_comparable && <p className="muted">{comparison.reasons.map(describeReason).join("；") || "计算所需字段不完整。"} 缺失值不会按零计入利润。</p>}</div></section>;
}

function FeedbackCard({ feedback, channel, onReload, onError, onNotice }: { feedback: Feedback; channel: string; onReload: () => Promise<void>; onError: (error: string) => void; onNotice: (notice: string) => void }) {
  const [rejecting, setRejecting] = useState(false); const [busy, setBusy] = useState(false);
  async function confirm(): Promise<void> { setBusy(true); onError(""); try { await command(`/feedback-proposals/${feedback.id}/confirm`, { expected_version: feedback.version }); onNotice("调整建议已确认，并生成了供未来项目使用的新标准版本。"); await onReload(); } catch (caught) { onError(message(caught)); } finally { setBusy(false); } }
  async function reject(event: FormEvent<HTMLFormElement>): Promise<void> { event.preventDefault(); setBusy(true); onError(""); const form = new FormData(event.currentTarget); try { await command(`/feedback-proposals/${feedback.id}/reject`, { expected_version: feedback.version, reason: value(form, "rejection_reason") }); onNotice("调整建议已拒绝，并记录了原因。"); await onReload(); } catch (caught) { onError(message(caught)); } finally { setBusy(false); } }
  return <article className="feedback-card"><div className="outcome-section-heading"><strong>{feedback.reason}</strong><span className="badge">{feedback.status === "PROPOSED" ? "待处理" : feedback.status === "CONFIRMED" ? "已确认" : "已拒绝"}</span></div><div className="feedback-rules"><RuleList title="调整前" rules={feedback.before_rules} /><RuleList title="建议调整后" rules={feedback.after_rules} /></div>{feedback.status === "PROPOSED" && <div className="feedback-actions"><button type="button" className="primary" disabled={busy} onClick={() => void confirm()}>确认建议</button><button type="button" className="secondary" disabled={busy} onClick={() => setRejecting((current) => !current)}>拒绝建议</button></div>}{rejecting && feedback.status === "PROPOSED" && <form className="reject-form" onSubmit={(event) => void reject(event)}><label className="field">拒绝原因<textarea name="rejection_reason" required /></label><button className="primary" disabled={busy}>提交拒绝</button></form>}{feedback.status === "CONFIRMED" && <Link to={`/projects?source_feedback_id=${encodeURIComponent(feedback.id)}&channel=${encodeURIComponent(channel)}`}>基于这条反馈创建新项目</Link>}</article>;
}

function FeedbackProposal({ outcome, before, beforeEvidence, onClose, onDone, onError }: { outcome: Outcome; before: Rule[]; beforeEvidence: string[]; onClose: () => void; onDone: () => Promise<void>; onError: (error: string) => void }) {
  const [rules, setRules] = useState(before.map((rule) => ({ ...rule }))); const [busy, setBusy] = useState(false);
  function updateRule(index: number, patch: Partial<Rule>): void { setRules((current) => current.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...patch } : rule)); }
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> { event.preventDefault(); setBusy(true); onError(""); const form = new FormData(event.currentTarget); try { await command(`/outcomes/${outcome.id}/feedback-proposals`, { expected_version: outcome.version, before_rules: before, after_rules: rules.map((rule) => ({ ...rule, currency: rule.currency?.trim() || null, unit: rule.unit?.trim() || "" })), before_required_evidence: beforeEvidence, after_required_evidence: value(form, "required_evidence").split(/[\n,，]/).map((item) => item.trim()).filter(Boolean), research_learning: value(form, "research_learning") || null, reason: value(form, "reason") }); await onDone(); } catch (caught) { onError(message(caught)); } finally { setBusy(false); } }
  return <div className="modal-backdrop" role="presentation"><section className="panel modal" role="dialog" aria-modal="true" aria-labelledby="feedback-proposal-title"><div className="outcome-section-heading"><div><h2 id="feedback-proposal-title">提出标准调整</h2><p className="muted">规则、必需材料或启示任一变化都可形成建议。</p></div><button type="button" onClick={onClose}>关闭</button></div><RuleList title="本次批准快照" rules={before} /><form onSubmit={(event) => void submit(event)}><div className="rule-editors">{rules.map((rule, index) => <fieldset key={`${rule.field}-${index}`}><legend>规则 {index + 1}</legend><div className="form-grid"><label className="field">业务字段<input value={rule.field} onChange={(event) => updateRule(index, { field: event.target.value })} required /></label><label className="field">比较方式<select value={rule.operator} onChange={(event) => updateRule(index, { operator: event.target.value as Rule["operator"] })}><option value="lte">不高于</option><option value="gte">不低于</option><option value="eq">等于</option></select></label><label className="field">阈值<input value={rule.threshold} onChange={(event) => updateRule(index, { threshold: event.target.value })} required /></label><label className="field">单位<input value={rule.unit ?? ""} onChange={(event) => updateRule(index, { unit: event.target.value })} required /></label><label className="field">币种（如适用）<input value={rule.currency ?? ""} onChange={(event) => updateRule(index, { currency: event.target.value })} maxLength={3} /></label><button type="button" className="secondary" onClick={() => setRules((current) => current.filter((_, ruleIndex) => ruleIndex !== index))}>移除规则</button></div></fieldset>)}</div><button type="button" className="secondary" onClick={() => setRules((current) => [...current, { field: "", operator: "lte", threshold: "", unit: "" }])}>新增规则</button><label className="field">下一版必需材料（每行一项）<textarea name="required_evidence" defaultValue={beforeEvidence.join("\n")} /></label><label className="field">可继承的研究启示<textarea name="research_learning" /></label><label className="field">调整依据<textarea name="reason" required /></label><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? "正在提交…" : "提交建议"}</button></div></form></section></div>;
}
