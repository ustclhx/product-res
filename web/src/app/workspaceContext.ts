import { createContext } from 'react';
export type RuntimeMode = 'demo' | 'pilot';
export type PilotWorkspace = { id: string; name: string; slug?: string; role?: string };
export type PilotUser = { id: string; username?: string; name?: string; display_name?: string; is_admin?: boolean };
export type WorkspaceMember = { id: string; name?: string; display_name?: string; username?: string; role?: string; roles?: string[] };
export type PilotSession = {
  user: PilotUser;
  workspace: PilotWorkspace;
  workspaces: PilotWorkspace[];
  members: WorkspaceMember[];
  csrf_token: string;
  expires_at: string;
};
export interface WorkspaceValue {
  mode: RuntimeMode;
  booting: boolean;
  bootError: string;
  session: PilotSession | null;
  members: WorkspaceMember[];
  actor: string;
  setActor: (actor: string) => void;
  refreshToken: number;
  refresh: () => void;
  login: (username: string, password: string, workspaceId?: string) => Promise<PilotSession>;
  logout: () => Promise<void>;
  switchWorkspace: (workspaceId: string) => Promise<void>;
  reloadSession: () => Promise<void>;
  retryBootstrap: () => void;
}
export const WorkspaceContext = createContext<WorkspaceValue | null>(null);
