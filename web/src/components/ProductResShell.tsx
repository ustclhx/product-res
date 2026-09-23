import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router-dom";
import { getHealth } from "../app/apiClient";
import { useWorkspace } from "../app/workspace";
import { LoginScreen } from './LoginScreen';

const navigation = [["工作台", "/"], ["选品项目", "/projects"], ["全部事项", "/tasks"]] as const;
const actorLabels: Record<string, string> = { analyst: "分析负责人", owner: "决策负责人", contributor: "补证成员" };

export function ProductResShell() {
  const { mode, booting, bootError, session, actor, setActor, logout, switchWorkspace, retryBootstrap } = useWorkspace();
  const health = useQuery({ queryKey: ["health"], queryFn: ({ signal }) => getHealth(signal), retry: false });
  if (booting) return <main className="login-page"><p role="status">正在连接工作台…</p></main>;
  if (bootError) return <main className="login-page"><section className="login-panel"><div className="error" role="alert"><strong>工作台服务暂时不可用</strong><p>{bootError}</p></div><button className="primary" type="button" onClick={retryBootstrap}>重新连接</button></section></main>;
  if (mode === 'pilot' && !session) return <LoginScreen />;
  const workspaceKey = mode === 'pilot' ? session?.workspace.id ?? 'signed-out' : 'demo';
  const isAdmin = mode === 'pilot' && session?.user.is_admin === true;
  return <div className="app-shell">
    <header className="topbar">
      <NavLink className="brand" to="/" aria-label="跨境选品工作台首页"><span aria-hidden="true">Product Res</span><span>选品工作台</span></NavLink>
      <div className="topbar-controls">{mode === 'demo' ? <label className="role-select"><span>当前角色</span><select value={actor} onChange={(event) => setActor(event.target.value)}>{Object.entries(actorLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label> : <><label className="workspace-select"><span>工作区</span><select value={session?.workspace.id} onChange={event => void switchWorkspace(event.target.value)}>{session?.workspaces.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><span className="user-name">{session?.user.display_name ?? session?.user.name ?? session?.user.username ?? '当前成员'}</span><button type="button" onClick={() => void logout()}>退出</button></>}<span className="small muted" role="status"><span className={`status-dot ${health.isSuccess ? "status-dot--ready" : ""}`} aria-hidden="true" />{health.isSuccess ? "服务在线" : health.isPending ? "连接中" : "服务不可用"}</span></div>
    </header>
    <div className="app-layout"><aside className="app-nav" aria-label="主导航">{navigation.map(([item, path]) => <NavLink to={path} end={path === "/"} key={path} className={({ isActive }) => isActive ? "active" : undefined}>{item}</NavLink>)}<NavLink className="nav-secondary" to="/observations">试用观察</NavLink>{isAdmin && <NavLink to="/admin/accounts" className={({ isActive }) => isActive ? "active" : undefined}>账号管理</NavLink>}<p className="nav-note">{mode === 'demo' ? '示例模式。所有操作只写入本地演示工作区。' : `${session?.workspace.name ?? '当前工作区'} · 数据与其他团队隔离`}</p></aside>
      <main className="app-main" id="workspace" key={workspaceKey}><Outlet /></main>
    </div>
  </div>;
}
