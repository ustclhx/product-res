import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { ApiError, api, authPost } from "../../app/client";
import { useWorkspace } from "../../app/workspace";
import "./admin.css";

type Workspace = { id: string; name: string; slug?: string };
type Membership = { workspace_id: string; role: string };
type Account = { id: string; username: string; display_name?: string; active: boolean; is_admin: boolean; version: number; memberships: Membership[] };
type AccountsResponse = { items: Account[]; workspaces: Workspace[] };
type FormState = { username: string; display_name: string; active: boolean; memberships: Membership[] };
const roleLabels: Record<string, string> = { analyst: "分析负责人", decision: "决策负责人", contributor: "补证成员" };
const roles = Object.keys(roleLabels);
const emptyForm: FormState = { username: "", display_name: "", active: true, memberships: [] };

function errorText(reason: unknown): string { return reason instanceof Error ? reason.message : "操作未完成，请稍后重试。"; }
function cloneForm(account: Account): FormState { return { username: account.username, display_name: account.display_name ?? "", active: account.active, memberships: account.memberships.map(item => ({ ...item })) }; }

export default function AdminAccountsPage() {
  const { session, mode } = useWorkspace();
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editVersion, setEditVersion] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [credentials, setCredentials] = useState<{ username: string; password: string } | null>(null);
  const [resetConfirm, setResetConfirm] = useState<string | null>(null);
  const csrf = session?.csrf_token;
  const selfId = session?.user.id;

  const load = useCallback(async (clearError = true) => {
    setLoading(true); if (clearError) setError("");
    try { setData(await api<AccountsResponse>("/admin/accounts")); }
    catch (reason) { setError(errorText(reason)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { if (mode !== "pilot" || session?.user.is_admin !== true) return; const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load, mode, session?.user.is_admin]);
  const accounts = useMemo(() => data?.items ?? [], [data]);
  const workspaces = useMemo(() => data?.workspaces ?? [], [data]);
  const selected = useMemo(() => accounts.find(item => item.id === selectedId), [accounts, selectedId]);
  const isSelf = selected?.id === selfId;

  if (mode !== "pilot" || session?.user.is_admin !== true) return <Navigate to="/" replace />;

  function beginCreate() { setSelectedId(null); setEditVersion(null); setForm({ ...emptyForm, memberships: [] }); setCredentials(null); setResetConfirm(null); setError(""); }
  function beginEdit(account: Account) { setSelectedId(account.id); setEditVersion(account.version); setForm(cloneForm(account)); setCredentials(null); setResetConfirm(null); setError(""); }
  function toggleWorkspace(workspaceId: string, checked: boolean) {
    setForm(current => ({ ...current, memberships: checked ? [...current.memberships, { workspace_id: workspaceId, role: "contributor" }] : current.memberships.filter(item => item.workspace_id !== workspaceId) }));
  }
  function updateRole(workspaceId: string, role: string) { setForm(current => ({ ...current, memberships: current.memberships.map(item => item.workspace_id === workspaceId ? { ...item, role } : item) })); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setCredentials(null);
    try {
      if (selectedId) {
        const account = selected;
        if (!account) return;
        const next = await patchAccount(`/admin/accounts/${selectedId}`, { expected_version: editVersion ?? account.version, display_name: form.display_name.trim(), active: isSelf ? account.active : form.active, memberships: isSelf ? account.memberships : form.memberships });
        setData(current => current ? { ...current, items: current.items.map(item => item.id === next.account.id ? next.account : item) } : current);
        setForm(cloneForm(next.account));
        setEditVersion(next.account.version);
      } else {
        const next = await authPost<{ account: Account; password: string }>("/admin/accounts", { username: form.username.trim(), display_name: form.display_name.trim(), memberships: form.memberships }, csrf);
        setCredentials({ username: next.account.username, password: next.password });
        setSelectedId(next.account.id); setEditVersion(next.account.version); setForm(cloneForm(next.account)); await load();
      }
    } catch (reason) {
      const duplicate = reason instanceof ApiError && reason.status === 409 && (reason.code === "USERNAME_TAKEN" || /用户名|账号.*存在|username/i.test(reason.message));
      setError(duplicate ? "登录账号已存在，请换一个账号名。" : reason instanceof ApiError && reason.status === 409 ? "账号资料已被其他操作更新，当前表单内容已保留。请重新点击该账号加载最新资料。" : errorText(reason));
      if (reason instanceof ApiError && reason.status === 409 && !duplicate) await load(false);
    } finally { setBusy(false); }
  }
  async function patchAccount(path: string, payload: Record<string, unknown>): Promise<{ account: Account }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (csrf) headers["X-CSRF-Token"] = csrf;
    const response = await fetch(`/api/v1${path}`, { method: "PATCH", credentials: "same-origin", headers, body: JSON.stringify(payload) });
    let body: unknown = {};
    try { body = await response.json(); } catch { /* handled by the generic message below */ }
    if (!response.ok) { const value = body as { message?: string; error_code?: string; details?: Record<string, unknown> }; throw new ApiError(value.message ?? "操作未完成，请检查输入后重试", value.error_code, response.status, value.details); }
    return body as { account: Account };
  }
  async function resetPassword(account: Account) {
    if (account.id === selfId) { setError("为避免当前会话立即失效，请先退出后再由其他管理员重置此账号口令。"); setResetConfirm(null); return; }
    setBusy(true); setError("");
    try { const next = await authPost<{ account: Account; password: string }>(`/admin/accounts/${account.id}/reset-password`, { expected_version: editVersion ?? account.version }, csrf); setCredentials({ username: next.account.username, password: next.password }); setResetConfirm(null); setData(current => current ? { ...current, items: current.items.map(item => item.id === next.account.id ? next.account : item) } : current); setForm(cloneForm(next.account)); setEditVersion(next.account.version); }
    catch (reason) { setError(errorText(reason)); if (reason instanceof ApiError && reason.status === 409) await load(false); }
    finally { setBusy(false); }
  }
  async function copyPassword() { if (credentials) await navigator.clipboard?.writeText(credentials.password); }

  return <section className="admin-page">
    <div className="page-heading"><div><h1>账号管理</h1><p>创建团队账号，配置可进入的工作区和业务角色。</p></div><button className="primary" type="button" disabled={busy} onClick={beginCreate}>新建账号</button></div>
    {error && <div className="error" role="alert">{error}<button type="button" disabled={busy} onClick={() => void load()}>刷新列表</button></div>}
    {credentials && <div className="admin-credentials" role="status"><div><strong>新口令只显示这一次</strong><p>请交给账号使用者保存。关闭后无法再次查看。</p></div><code>{credentials.username} / {credentials.password}</code><div className="form-actions"><button type="button" onClick={() => void copyPassword()}>复制口令</button><button type="button" onClick={() => setCredentials(null)}>关闭</button></div></div>}
    <div className="admin-layout">
      <section className="panel admin-list" aria-labelledby="account-list-title"><div className="card-heading"><h2 id="account-list-title">团队账号</h2><span className="muted">{accounts.length} 个</span></div>{loading ? <p role="status">正在加载账号…</p> : accounts.length === 0 ? <div className="empty"><p>还没有团队账号。</p><button type="button" disabled={busy} onClick={beginCreate}>创建第一个账号</button></div> : <div className="admin-account-list">{accounts.map(account => <button type="button" disabled={busy} className={`admin-account-row ${selectedId === account.id ? "selected" : ""}`} key={account.id} onClick={() => beginEdit(account)}><span><strong>{account.display_name || account.username}</strong><small>{account.username}</small></span><span className="admin-account-meta"><span className={`badge ${account.active ? "" : "warning"}`}>{account.active ? "启用" : "已停用"}</span>{account.is_admin && <span className="badge">管理员</span>}</span></button>)}</div>}</section>
      <section className="panel admin-editor" aria-labelledby="account-editor-title"><div className="card-heading"><h2 id="account-editor-title">{selectedId ? "编辑账号" : "新建账号"}</h2>{selectedId && selected && <span className="muted">版本 {editVersion ?? selected.version}</span>}</div><form onSubmit={event => void submit(event)}><fieldset disabled={busy} className="admin-form-fields"><div className="form-grid"><label className="field">登录账号<input value={form.username} onChange={event => setForm({ ...form, username: event.target.value })} disabled={Boolean(selectedId)} required autoComplete="off" /><small>{selectedId ? "登录账号不可修改。" : "服务器会生成一次性初始口令。"}</small></label><label className="field">显示名称<input value={form.display_name} onChange={event => setForm({ ...form, display_name: event.target.value })} required /></label>{selectedId && <label className="field admin-active-field">账号状态<select value={form.active ? "active" : "inactive"} onChange={event => setForm({ ...form, active: event.target.value === "active" })} disabled={isSelf}><option value="active">启用</option><option value="inactive">停用</option></select>{isSelf && <small>当前登录账号不能停用自己。</small>}</label>}</div>{selectedId && selected?.is_admin && <div className="notice">管理员权限由服务端控制，当前页面只读显示。</div>}<fieldset><legend>工作区与业务角色</legend><p className="muted">至少选择一个账号需要进入的工作区，并为每个工作区指定角色。</p>{workspaces.length === 0 ? <p className="muted">暂无可配置工作区。</p> : <div className="workspace-memberships">{workspaces.map(workspace => { const membership = form.memberships.find(item => item.workspace_id === workspace.id); const locked = Boolean(isSelf); return <div className="workspace-membership" key={workspace.id}><label><input type="checkbox" checked={Boolean(membership)} disabled={locked} onChange={event => toggleWorkspace(workspace.id, event.target.checked)} />{workspace.name}<small>{workspace.slug || workspace.id}</small></label>{membership && <select aria-label={`${workspace.name}业务角色`} value={membership.role} disabled={locked} onChange={event => updateRole(workspace.id, event.target.value)}>{roles.map(role => <option value={role} key={role}>{roleLabels[role]}</option>)}</select>}</div>; })}</div>}{isSelf && <small className="muted">当前登录账号的工作区成员关系不能在此修改。</small>}</fieldset><div className="form-actions"><button className="primary" type="submit" disabled={busy || !form.display_name.trim() || !form.username.trim()}>{busy ? "正在保存…" : selectedId ? "保存修改" : "创建账号"}</button>{selectedId && selected && <>{resetConfirm === selected.id ? <><button type="button" disabled={busy || isSelf} onClick={() => void resetPassword(selected)}>确认重置口令</button><button type="button" disabled={busy} onClick={() => setResetConfirm(null)}>取消</button></> : <button type="button" disabled={busy || isSelf} onClick={() => setResetConfirm(selected.id)}>重置口令</button>}</>}</div>{isSelf && <small className="muted">修改自己的密码请使用页面右上角的“修改密码”入口。</small>}</fieldset></form></section>
    </div>
    {isSelf && <p className="small muted admin-self-note">需要修改自己的管理员密码？请使用页面右上角的“修改密码”入口。</p>}
  </section>;
}
