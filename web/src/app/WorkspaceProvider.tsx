import { useCallback, useEffect, useState, type PropsWithChildren } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getHealth } from './apiClient';
import { api, authPost, setClientContext } from './client';
import { WorkspaceContext } from './workspaceContext';
import type { PilotSession, RuntimeMode } from './workspaceContext';
export function WorkspaceProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<RuntimeMode>('demo');
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState('');
  const [bootstrapToken, setBootstrapToken] = useState(0);
  const [session, setSession] = useState<PilotSession | null>(null);
  const [actor, changeActor] = useState(localStorage.getItem('product-res-actor') ?? 'analyst');
  const [refreshToken, setRefresh] = useState(0);
  const applySession = useCallback((next: PilotSession | null, nextMode: RuntimeMode) => {
    queryClient.clear();
    setSession(next);
    setClientContext({ mode: nextMode, csrfToken: next?.csrf_token });
    setRefresh(value => value + 1);
  }, [queryClient]);
  const reloadSession = useCallback(async () => {
    try { applySession(await api<PilotSession>('/auth/session'), 'pilot'); }
    catch { applySession(null, 'pilot'); }
  }, [applySession]);
  useEffect(() => {
    let active = true;
    void getHealth().then(async health => {
      if (!active) return;
      setMode(health.mode);
      if (health.mode === 'pilot') {
        try { const next = await api<PilotSession>('/auth/session'); if (active) applySession(next, 'pilot'); }
        catch { if (active) applySession(null, 'pilot'); }
      } else setClientContext({ mode: 'demo', actor: localStorage.getItem('product-res-actor') ?? 'analyst' });
    }).catch(reason => { if (active) setBootError(reason instanceof Error ? reason.message : '无法连接工作台服务'); })
      .finally(() => { if (active) setBooting(false); });
    return () => { active = false; };
  }, [applySession, bootstrapToken]);
  function setActor(value: string) {
    if (mode !== 'demo') return;
    localStorage.setItem('product-res-actor', value);
    changeActor(value);
    setClientContext({ mode: 'demo', actor: value });
    setRefresh(v => v + 1);
  }
  async function login(username: string, password: string, workspaceId?: string) {
    const next = await authPost<PilotSession>('/auth/login', { username, password, ...(workspaceId ? { workspace_id: workspaceId } : {}) });
    applySession(next, 'pilot');
    return next;
  }
  async function logout() {
    if (session?.csrf_token) await authPost('/auth/logout', {}, session.csrf_token);
    applySession(null, 'pilot');
  }
  async function switchWorkspace(workspaceId: string) {
    if (!session?.csrf_token || workspaceId === session.workspace.id) return;
    const next = await authPost<PilotSession>('/auth/switch-workspace', { workspace_id: workspaceId }, session.csrf_token);
    applySession(next, 'pilot');
  }
  const effectiveActor = mode === 'pilot' ? session?.user.id ?? '' : actor;
  function retryBootstrap() { setBooting(true); setBootError(''); setBootstrapToken(value => value + 1); }
  return <WorkspaceContext.Provider value={{ mode, booting, bootError, session, members: session?.members ?? [], actor: effectiveActor, setActor, refreshToken, refresh: () => setRefresh(v => v + 1), login, logout, switchWorkspace, reloadSession, retryBootstrap }}>{children}</WorkspaceContext.Provider>;
}
