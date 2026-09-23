import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, command } from "../../app/client";
import { useWorkspace } from "../../app/workspace";
import { memberLabel } from '../../app/members';
import "./tasks.css";
import { isMyWork, isOpenItem, useWorkItems } from "../../app/workItems";
import WorkItemList from "../../components/WorkItemList";

type TaskState = "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE" | "CANCELLED";
type TaskType = "EVIDENCE" | "QUOTE" | "SAMPLE" | "TEST";

type Task = {
  id: string;
  version: number;
  candidate_id: string;
  approval_id?: string;
  type: TaskType;
  question: string;
  owner_id: string;
  due_at: string;
  completion_criteria: string;
  expected_metrics?: Record<string, string>;
  state: TaskState;
  result?: string;
  evidence_ids?: string[];
  target_met?: boolean;
  reason?: string;
  overdue?: boolean;
  field?: string;
};

type Project = {
  id: string;
  name: string;
  analyst_id?: string | null;
  decision_owner_id?: string | null;
  current_criteria_id?: string | null;
};

type Candidate = {
  id: string;
  version: number;
  project_id: string;
  title: string;
  business_status?: string;
  approval_id?: string | null;
};

type Evidence = {
  id: string;
  field: string;
  value?: string | null;
  unit?: string | null;
  currency?: string | null;
  source_locator: string;
  verification: "VERIFIED" | "UNVERIFIED" | "CONFLICT";
  supersedes_id?: string | null;
};

type Criteria = { id: string; rules?: Array<{ field: string }>; required_evidence?: string[] };
type CandidateAggregate = { candidate: Candidate; project: Project; criteria?: Criteria | null; evidence: Evidence[] };
type ProjectDetail = { project: Project; candidates?: Candidate[]; criteria_versions?: Criteria[] };
type CandidateOption = Candidate & { project: Project; evidenceFields: string[] };
type ListResponse = { items: Task[] };
type ProjectListResponse = { items: Project[] };

const states = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"] as const;
const taskTypes = ["EVIDENCE", "QUOTE", "SAMPLE", "TEST"] as const;
type ActorOption = { id: string; label: string };
const demoActors: ActorOption[] = [
  { id: "analyst", label: "林晓 · 选品分析" },
  { id: "owner", label: "陈越 · 决策负责人" },
  { id: "contributor", label: "周宁 · 采购协作" },
] as const;
const transitions: Record<TaskState, TaskState[]> = {
  TODO: ["IN_PROGRESS", "BLOCKED", "CANCELLED"],
  IN_PROGRESS: ["BLOCKED", "DONE", "CANCELLED"],
  BLOCKED: ["IN_PROGRESS", "DONE", "CANCELLED"],
  DONE: [],
  CANCELLED: [],
};
const stateLabel: Record<TaskState, string> = { TODO: "待处理", IN_PROGRESS: "进行中", BLOCKED: "受阻", DONE: "已完成", CANCELLED: "已取消" };
const typeLabel: Record<TaskType, string> = { EVIDENCE: "补充证据", QUOTE: "询价", SAMPLE: "样品", TEST: "验证测试" };
const businessStatusLabel: Record<string, string> = {
  PREPARING: "准备材料", RETURNED: "已退回", IN_REVIEW: "待决策", VALIDATING: "验证中",
  WATCHING: "观察中", REJECTED: "已否决", OUTCOME_PENDING: "待回填结果", REVIEWED: "已复盘",
};
const fieldLabel: Record<string, string> = { moq: "最小起订量", procurement_cost: "采购成本", selling_price: "预计售价" };
const verificationLabel: Record<Evidence["verification"], string> = { VERIFIED: "已核验", UNVERIFIED: "未核验", CONFLICT: "有冲突" };

function errorMessage(error: unknown) { return error instanceof Error ? error.message : "操作未完成，请检查输入后重试"; }
function formValue(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false, dateStyle: "medium", timeStyle: "short" });
}
function actorLabel(id: string, actors: ActorOption[] = demoActors) { return actors.find((actor) => actor.id === id)?.label ?? id; }
function statusLabel(status?: string) { return status ? (businessStatusLabel[status] ?? status) : "状态未知"; }
function criteriaFields(detail: ProjectDetail) {
  const criteria = detail.criteria_versions?.find((item) => item.id === detail.project.current_criteria_id);
  return Array.from(new Set([...(criteria?.required_evidence ?? []), ...(criteria?.rules?.map((rule) => rule.field) ?? [])]));
}
async function loadCandidateOptions(): Promise<CandidateOption[]> {
  const response = await api<ProjectListResponse>("/projects");
  const details = await Promise.all(response.items.map((project) => api<ProjectDetail>(`/projects/${project.id}`)));
  return details.flatMap((detail) => (detail.candidates ?? []).map((candidate) => ({
    ...candidate, project: detail.project, evidenceFields: criteriaFields(detail),
  })));
}

export default function TasksPage() {
  const { mode, actor, members, refresh, refreshToken } = useWorkspace();
  const actors: ActorOption[] = mode === 'pilot' ? members.map(member => ({ id: member.id, label: memberLabel(member) })) : demoActors;
  const [searchParams, setSearchParams] = useSearchParams();
  const candidateId = searchParams.get("candidate_id") ?? "";
  const owner = searchParams.get("owner_id") ?? "";
  const projectId = searchParams.get("project_id") ?? "";
  const workQuery = useWorkItems();
  function setFilter(key: string, value: string) { const next = new URLSearchParams(searchParams); if (value) next.set(key, value); else next.delete(key); if (key !== "task_id") next.delete("task_id"); if (key === "project_id") next.delete("candidate_id"); setSearchParams(next); setSelected(undefined); }
  const [state, setState] = useState("OPEN");
  const [overdue, setOverdue] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showConclusion, setShowConclusion] = useState(searchParams.get("conclusion") === "1");
  const [manualSelected, setSelected] = useState<Task>();
  const [error, setError] = useState("");

  const candidatesQuery = useQuery({ queryKey: ["task-candidates", refreshToken], queryFn: loadCandidateOptions, retry: false });
  const candidateQuery = useQuery({
    queryKey: ["candidate", candidateId, refreshToken],
    queryFn: () => api<CandidateAggregate>(`/candidates/${candidateId}`), enabled: Boolean(candidateId), retry: false,
  });
  const tasksQuery = useQuery({
    queryKey: ["tasks", owner, state, overdue, candidateId, refreshToken],
    queryFn: () => {
      const query = new URLSearchParams();



      if (candidateId) query.set("candidate_id", candidateId);
      return api<ListResponse>(`/tasks?${query.toString()}`);
    },
    retry: false,
  });

  const selected = manualSelected ?? tasksQuery.data?.items.find(task => task.id === searchParams.get("task_id"));
  const transitionCandidateId = selected?.candidate_id ?? "";
  const transitionCandidateQuery = useQuery({
    queryKey: ["candidate", transitionCandidateId, refreshToken],
    queryFn: () => api<CandidateAggregate>(`/candidates/${transitionCandidateId}`), enabled: Boolean(transitionCandidateId), retry: false,
  });
  const candidates = useMemo(() => {
    const items = [...(candidatesQuery.data ?? [])];
    const aggregate = candidateQuery.data;
    if (aggregate && !items.some((item) => item.id === aggregate.candidate.id)) {
      items.push({
        ...aggregate.candidate,
        project: aggregate.project,
        evidenceFields: Array.from(new Set([...(aggregate.criteria?.required_evidence ?? []), ...(aggregate.criteria?.rules?.map((rule) => rule.field) ?? [])])),
      });
    }
    return items;
  }, [candidateQuery.data, candidatesQuery.data]);

  const selectedAggregate = candidateQuery.data;
  const transitionAggregate = transitionCandidateQuery.data;
  const queryError = workQuery.error ?? tasksQuery.error ?? candidatesQuery.error ?? candidateQuery.error ?? transitionCandidateQuery.error;
  const workItems = (workQuery.data?.items ?? []).filter(item => (!projectId || item.project_id === projectId) && (!candidateId || item.candidate_id === candidateId) && (!owner || (owner === "UNASSIGNED" ? !item.owner_id : isMyWork(item, owner))) && (!state || (state === "OPEN" ? isOpenItem(item) : item.state === state)) && (!overdue || item.overdue));
  const canConclude = Boolean(selectedAggregate && actor === selectedAggregate.project.decision_owner_id);

  function chooseCandidate(value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("candidate_id", value); else next.delete("candidate_id");
    next.delete("task_id");
    setSearchParams(next, { replace: true });
    setSelected(undefined);
    setShowConclusion(false);
  }
  async function refreshChangedCandidate(candidate: string) {
    await Promise.all([
      tasksQuery.refetch(), candidatesQuery.refetch(), workQuery.refetch(),
      candidate === candidateId ? candidateQuery.refetch() : Promise.resolve(),
      candidate === transitionCandidateId ? transitionCandidateQuery.refetch() : Promise.resolve(),
    ]);
    refresh();
  }

  return <div className="feature-page tasks-page">
    <header className="page-heading"><div><h1>全部事项</h1><p className="muted">按项目、负责人和期限跟进团队工作。</p></div><button className="primary" type="button" disabled={candidates.length === 0} onClick={() => { setShowCreate((value) => !value); setSelected(undefined); }}>{showCreate ? "收起新建表单" : "新建任务"}</button></header>

    <section className="work-filters" aria-label="事项筛选">
      <label className="field"><span>项目</span><select value={projectId} onChange={event => setFilter("project_id", event.target.value)}><option value="">全部项目</option>{workQuery.data?.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label className="field"><span>负责人</span><select value={owner} onChange={(event) => setFilter("owner_id", event.target.value)}><option value="">全部负责人</option><option value="UNASSIGNED">待分配</option>{actors.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>
      <label className="field"><span>状态</span><select value={state} onChange={(event) => setState(event.target.value)}><option value="OPEN">未完成</option><option value="">全部状态</option>{states.map((value) => <option value={value} key={value}>{stateLabel[value]}</option>)}</select></label>
      <label className="field"><span>候选</span><select value={candidateId} onChange={(event) => chooseCandidate(event.target.value)}><option value="">全部候选</option>{candidates.filter(item => !projectId || item.project_id === projectId).map((item) => <option value={item.id} key={item.id}>{item.title} · {item.project.name}</option>)}</select></label>
      <label className="check-field"><input type="checkbox" checked={overdue} onChange={(event) => setOverdue(event.target.checked)} />只看逾期</label>
    </section>

    {showCreate && <TaskCreateSection actor={actor} actors={actors} initialCandidateId={candidateId} candidates={candidates} onCancel={() => setShowCreate(false)} onCreated={async (createdCandidateId) => { setShowCreate(false); setError(""); await refreshChangedCandidate(createdCandidateId); }} onError={setError} />}
    {(error || queryError) && <div className="error" role="alert">{error || errorMessage(queryError)} <button type="button" onClick={() => { void workQuery.refetch(); void tasksQuery.refetch(); }}>重试事项清单</button></div>}

    {selected && <div className="notice"><strong>{selected.question}</strong><span>负责人：{actorLabel(selected.owner_id, actors)} · 截止 {formatDate(selected.due_at)}</span><span>完成条件：{selected.completion_criteria}</span>{selected.type === "EVIDENCE" && selected.field && <Link to={`/candidates/${selected.candidate_id}?stage=evidence&field=${encodeURIComponent(selected.field)}&task_id=${selected.id}`}>补充或核验资料</Link>}{selected.state === "DONE" || selected.state === "CANCELLED" ? <span>已结束：{selected.result ?? selected.reason ?? stateLabel[selected.state]}</span> : null}</div>}
    {selected && transitions[selected.state].length > 0 && <TransitionSection key={`${selected.id}-${selected.version}`} actor={actor} actorName={actorLabel(actor, actors)} task={selected} aggregate={transitionAggregate} loadingEvidence={transitionCandidateQuery.isPending} onCancel={() => { setSelected(undefined); setFilter("task_id", ""); }} onCompleted={async () => { const changedCandidateId = selected.candidate_id; setSelected(undefined); setFilter("task_id", ""); setError(""); await refreshChangedCandidate(changedCandidateId); }} onError={setError} />}

    <section className="panel" aria-label="事项清单"><div className="card-heading"><h2>事项清单 <span className="small muted">{workItems.length} 项</span></h2><button type="button" className="secondary" onClick={() => { void workQuery.refetch(); void tasksQuery.refetch(); }}>刷新</button></div>
      {workQuery.isPending ? <p role="status">正在加载事项…</p> : <WorkItemList items={workItems} emptyText="没有符合条件的事项，试试调整筛选。" />}
    </section>

    {candidateId && selectedAggregate && selectedAggregate.candidate.approval_id && <section className="panel tasks-conclusion"><div><h2>{selectedAggregate.candidate.title}</h2><p className="muted">当前为{statusLabel(selectedAggregate.candidate.business_status)}。决策负责人提交明确结论后，候选才会进入结果跟进。</p><div className="tasks-links"><Link to={`/candidates/${candidateId}`}>返回候选资料</Link><Link to={`/candidates/${candidateId}/outcomes`}>打开结果跟进</Link></div></div><div className="tasks-conclusion__action"><button className="secondary" type="button" disabled={selectedAggregate.candidate.business_status !== "VALIDATING"} onClick={() => setShowConclusion((value) => !value)}>{showConclusion ? "收起结论表单" : "记录验证结论"}</button>{!canConclude && <small className="muted">提交结论需要项目决策负责人；服务器会最终校验权限。</small>}</div></section>}
    {showConclusion && selectedAggregate && selectedAggregate.candidate.business_status === "VALIDATING" && <ConclusionSection actor={actor} actorName={actorLabel(actor, actors)} aggregate={selectedAggregate} onCancel={() => setShowConclusion(false)} onDone={async () => { setShowConclusion(false); setError(""); await refreshChangedCandidate(selectedAggregate.candidate.id); }} onError={setError} />}
  </div>;
}

function TaskCreateSection({ actor, actors, initialCandidateId, candidates, onCancel, onCreated, onError }: { actor: string; actors: ActorOption[]; initialCandidateId: string; candidates: CandidateOption[]; onCancel: () => void; onCreated: (candidateId: string) => Promise<void>; onError: (message: string) => void }) {
  const [type, setType] = useState<TaskType>("EVIDENCE");
  const [chosenCandidateId, setChosenCandidateId] = useState(initialCandidateId || candidates[0]?.id || "");
  const [busy, setBusy] = useState(false);
  const chosenCandidate = candidates.find((candidate) => candidate.id === chosenCandidateId);
  const canUseChosenCandidate = type === "EVIDENCE" || (chosenCandidate?.business_status === "VALIDATING" && Boolean(chosenCandidate.approval_id));

  function changeType(nextType: TaskType) {
    setType(nextType);
    const current = candidates.find((candidate) => candidate.id === chosenCandidateId);
    if (nextType !== "EVIDENCE" && (current?.business_status !== "VALIDATING" || !current.approval_id)) {
      const valid = candidates.find((candidate) => candidate.business_status === "VALIDATING" && candidate.approval_id);
      setChosenCandidateId(valid?.id ?? "");
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chosenCandidate || !canUseChosenCandidate) { onError("请选择符合当前任务类型的候选。询价、样品和测试任务需要已批准且正在验证的候选。"); return; }
    const form = new FormData(event.currentTarget);
    const expectedMetric = formValue(form, "expected_metrics").trim();
    setBusy(true); onError("");
    try {
      await command(`/candidates/${chosenCandidate.id}/tasks`, {
        expected_version: chosenCandidate.version,
        type,
        question: formValue(form, "question"),
        owner_id: formValue(form, "owner_id"),
        due_at: new Date(formValue(form, "due_at")).toISOString(),
        completion_criteria: formValue(form, "completion_criteria"),
        expected_metrics: expectedMetric ? { target: expectedMetric } : {},
        field: type === "EVIDENCE" ? formValue(form, "field") : undefined,
      });
      await onCreated(chosenCandidate.id);
    } catch (caught) { onError(errorMessage(caught)); } finally { setBusy(false); }
  }
  return <section className="panel tasks-editor" aria-labelledby="create-task-title"><div className="tasks-section-heading"><div><h2 id="create-task-title">新建验证任务</h2></div><span className="muted">当前成员：{actorLabel(actor, actors)}</span></div><form onSubmit={(event) => void submit(event)}><div className="form-grid">
    <label className="field"><span>候选</span><select name="candidate_id" value={chosenCandidateId} onChange={(event) => setChosenCandidateId(event.target.value)} required><option value="">请选择候选</option>{candidates.map((candidate) => { const disabled = type !== "EVIDENCE" && (candidate.business_status !== "VALIDATING" || !candidate.approval_id); return <option value={candidate.id} key={candidate.id} disabled={disabled}>{candidate.title} · {candidate.project.name} · {statusLabel(candidate.business_status)}</option>; })}</select><small>询价、样品和测试任务只适用于已批准并正在验证的候选。</small></label>
    <label className="field"><span>任务类型</span><select value={type} onChange={(event) => changeType(event.target.value as TaskType)}>{taskTypes.map((item) => <option value={item} key={item}>{typeLabel[item]}</option>)}</select></label>
    {type === "EVIDENCE" && <label className="field"><span>需要补充的证据</span><select key={chosenCandidateId} name="field" required defaultValue=""><option value="">请选择证据字段</option>{(chosenCandidate?.evidenceFields ?? []).map((field) => <option value={field} key={field}>{fieldLabel[field] ?? field}</option>)}</select>{!chosenCandidate?.evidenceFields.length && <small>该项目尚未配置可选证据字段。</small>}</label>}
    <label className="field"><span>负责人</span><select name="owner_id" defaultValue={actor} required>{actors.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>
    <label className="field tasks-field-wide"><span>验证问题</span><textarea name="question" required placeholder="要验证什么？" /></label>
    <label className="field"><span>截止日期</span><input name="due_at" type="datetime-local" required /></label>
    {type !== "EVIDENCE" && <label className="field"><span>预期指标</span><input name="expected_metrics" required placeholder="例如：样品测试全部通过" /></label>}
    <label className="field tasks-field-wide"><span>完成条件</span><textarea name="completion_criteria" required placeholder="需要留下什么结果与证据才算完成？" /></label>
  </div><p className="muted">项目参与角色可以创建任务；权限、候选状态和版本由服务器最终校验。</p><div className="tasks-actions"><button className="secondary" type="button" onClick={onCancel}>取消</button><button className="primary" type="submit" disabled={busy || !canUseChosenCandidate}>{busy ? "正在创建…" : "创建任务"}</button></div></form></section>;
}

function TransitionSection({ actor, actorName, task, aggregate, loadingEvidence, onCancel, onCompleted, onError }: { actor: string; actorName: string; task: Task; aggregate?: CandidateAggregate; loadingEvidence: boolean; onCancel: () => void; onCompleted: () => Promise<void>; onError: (message: string) => void }) {
  const availableStates = transitions[task.state];
  const [nextState, setNextState] = useState<TaskState>(availableStates[0] ?? task.state);
  const [busy, setBusy] = useState(false);
  const canUpdate = Boolean(aggregate && [task.owner_id, aggregate.project.analyst_id, aggregate.project.decision_owner_id].includes(actor));
  const supersededIds = new Set(aggregate?.evidence.map((item) => item.supersedes_id).filter((id): id is string => Boolean(id)) ?? []);
  const relevantEvidence = (aggregate?.evidence ?? []).filter((item) => task.type !== "EVIDENCE" || item.field === task.field);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const evidenceIds = form.getAll("evidence_ids").filter((value): value is string => typeof value === "string");
    const reason = formValue(form, "reason").trim();
    if (nextState === "DONE" && evidenceIds.length === 0) { onError("请至少勾选一条候选证据作为完成依据。"); return; }
    if (nextState === "DONE" && form.get("target_met") === "false" && !reason) { onError("目标未达成时，请填写原因。"); return; }
    setBusy(true); onError("");
    try {
      await command(`/tasks/${task.id}/transitions`, {
        expected_version: task.version,
        state: nextState,
        result: nextState === "DONE" ? formValue(form, "result") : undefined,
        evidence_ids: nextState === "DONE" ? evidenceIds : [],
        target_met: nextState === "DONE" ? form.get("target_met") === "true" : undefined,
        reason: reason || undefined,
      });
      await onCompleted();
    } catch (caught) { onError(errorMessage(caught)); } finally { setBusy(false); }
  }
  return <section className="panel tasks-editor" aria-labelledby="transition-task-title"><div className="tasks-section-heading"><div><h2 id="transition-task-title">{task.question}</h2></div><span className="badge">{stateLabel[task.state]}</span></div><form onSubmit={(event) => void submit(event)}>
    <label className="field"><span>变更为</span><select value={nextState} onChange={(event) => setNextState(event.target.value as TaskState)}>{availableStates.map((item) => <option value={item} key={item}>{stateLabel[item]}</option>)}</select></label>
    {nextState === "DONE" && <div className="form-grid"><label className="field tasks-field-wide"><span>实际结果</span><textarea name="result" required placeholder="记录观察到的实际结果" /></label><fieldset className="tasks-evidence tasks-field-wide"><legend>完成依据</legend>{loadingEvidence ? <p role="status">正在加载候选证据…</p> : relevantEvidence.length ? <div className="tasks-check-list">{relevantEvidence.map((evidence) => { const superseded = supersededIds.has(evidence.id); return <label key={evidence.id}><input name="evidence_ids" type="checkbox" value={evidence.id} disabled={superseded} /><span><strong>{fieldLabel[evidence.field] ?? evidence.field}</strong>{evidence.value ? `：${evidence.value}${evidence.currency ? ` ${evidence.currency}` : ""}${evidence.unit ? ` / ${evidence.unit}` : ""}` : ""}<small>{verificationLabel[evidence.verification]} · {evidence.source_locator}{superseded ? " · 已被新版本替代" : ""}</small></span></label>; })}</div> : <p className="muted">该候选还没有可用于此任务的证据，请先返回候选资料补充。</p>}<small>完成任务至少勾选一条候选证据；补证任务还需选择当前、已核验且字段匹配的证据。</small></fieldset><label className="field"><span>目标是否达成</span><select name="target_met" defaultValue="" required><option value="" disabled>请选择</option><option value="true">已达成</option><option value="false">未达成</option></select></label><label className="field"><span>备注</span><textarea name="reason" placeholder="未达目标时必须说明原因" /></label></div>}
    {(nextState === "BLOCKED" || nextState === "CANCELLED") && <label className="field"><span>原因</span><textarea name="reason" required placeholder="说明受阻或取消原因" /></label>}
    {!canUpdate && <p className="notice" role="status">当前成员为{actorName}。只有任务负责人、项目分析负责人或决策负责人可以更新；服务器会最终校验权限。</p>}
    <div className="tasks-actions"><button className="secondary" type="button" onClick={onCancel}>取消</button><button className="primary" type="submit" disabled={busy || !canUpdate || !aggregate}>{busy ? "正在保存…" : "保存"}</button></div>
  </form></section>;
}

function ConclusionSection({ actor, actorName, aggregate, onCancel, onDone, onError }: { actor: string; actorName: string; aggregate: CandidateAggregate; onCancel: () => void; onDone: () => Promise<void>; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const canSubmit = actor === aggregate.project.decision_owner_id;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setBusy(true); onError("");
    try {
      await command(`/candidates/${aggregate.candidate.id}/validation-conclusions`, { expected_version: aggregate.candidate.version, action: formValue(form, "action"), reason: formValue(form, "reason") });
      await onDone();
    } catch (caught) { onError(errorMessage(caught)); } finally { setBusy(false); }
  }
  return <section className="panel tasks-editor" aria-labelledby="conclusion-title"><div className="tasks-section-heading"><div><h2 id="conclusion-title">记录下一步</h2></div><span className="muted">基于当前呈现的候选版本 v{aggregate.candidate.version}</span></div><form onSubmit={(event) => void submit(event)}><div className="form-grid"><label className="field"><span>下一步</span><select name="action" defaultValue="CONTINUE"><option value="CONTINUE">继续验证</option><option value="FOLLOW_UP">进入结果跟进</option><option value="STOP">停止验证</option></select></label><label className="field tasks-field-wide"><span>判断依据</span><textarea name="reason" required placeholder="说明依据与下一步安排" /></label></div>{!canSubmit && <p className="notice" role="status">当前成员为{actorName}；该结论需由项目决策负责人提交，服务器会最终校验权限。</p>}<div className="tasks-actions"><button className="secondary" type="button" onClick={onCancel}>取消</button><button className="primary" type="submit" disabled={busy || !canSubmit}>{busy ? "正在提交…" : "提交结论"}</button></div></form></section>;
}
