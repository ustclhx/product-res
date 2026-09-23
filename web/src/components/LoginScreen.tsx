import { useState, type FormEvent } from 'react';
import { ApiError } from '../app/client';
import { useWorkspace } from '../app/workspace';
import type { PilotWorkspace } from '../app/workspaceContext';

function workspaceChoices(error: ApiError): PilotWorkspace[] {
  const value = error.details?.workspaces;
  return Array.isArray(value) ? value.filter((item): item is PilotWorkspace => Boolean(item && typeof item === 'object' && 'id' in item && 'name' in item)) : [];
}

export function LoginScreen() {
  const { login } = useWorkspace();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [choices, setChoices] = useState<PilotWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try { await login(username.trim(), password, workspaceId || undefined); }
    catch (reason) {
      if (reason instanceof ApiError && reason.code === 'WORKSPACE_SELECTION_REQUIRED') {
        const next = workspaceChoices(reason); setChoices(next); setWorkspaceId(next[0]?.id ?? '');
        setError('该账号属于多个工作区。请选择本次要进入的工作区。');
      } else setError(reason instanceof Error ? reason.message : '登录未完成，请检查账号和口令。');
    } finally { setBusy(false); }
  }

  return <main className="login-page">
    <section className="login-panel" aria-labelledby="login-title">
      <div><p className="eyebrow">团队试点</p><h1 id="login-title">登录选品工作台</h1><p className="muted">登录后只会看到你所属工作区的项目、候选和任务。</p></div>
      {error && <div className={choices.length ? 'notice' : 'error'} role="alert">{error}</div>}
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <label className="field">账号<input autoComplete="username" value={username} onChange={event => { setUsername(event.target.value); setChoices([]); setWorkspaceId(''); }} required autoFocus /></label>
        <label className="field">口令<input type="password" autoComplete="current-password" value={password} onChange={event => { setPassword(event.target.value); setChoices([]); setWorkspaceId(''); }} required /></label>
        {choices.length > 0 && <label className="field">工作区<select value={workspaceId} onChange={event => setWorkspaceId(event.target.value)} required>{choices.map(item => <option value={item.id} key={item.id}>{item.name}{item.role ? ` · ${item.role}` : ''}</option>)}</select></label>}
        <button className="primary" disabled={busy || !username.trim() || !password || (choices.length > 0 && !workspaceId)}>{busy ? '正在登录…' : choices.length ? '进入所选工作区' : '登录'}</button>
      </form>
      <p className="small muted">账号由试点管理员分配，不提供公开注册。</p>
    </section>
  </main>;
}
