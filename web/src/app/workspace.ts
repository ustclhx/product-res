import { useContext } from 'react';
import { WorkspaceContext } from './workspaceContext';
export { WorkspaceProvider } from './WorkspaceProvider';
export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('WorkspaceProvider is required');
  return value;
}
