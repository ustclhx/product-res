import type { WorkspaceMember } from './workspaceContext';

export function memberLabel(member: WorkspaceMember): string {
  return member.display_name ?? member.name ?? member.username ?? member.id;
}

export function memberHasRole(member: WorkspaceMember, ...roles: string[]): boolean {
  const values = [...(member.roles ?? []), ...(member.role ? [member.role] : [])].map(value => value.toLowerCase());
  return roles.some(role => values.includes(role.toLowerCase()));
}

export function membersForRole(members: WorkspaceMember[], ...roles: string[]): WorkspaceMember[] {
  const matching = members.filter(member => memberHasRole(member, ...roles));
  return matching.length ? matching : members;
}
