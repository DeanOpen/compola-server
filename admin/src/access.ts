// Effective access, as the server computes it (docs: highest role over the user's and their groups' grants; scope =
// union, `all` wins; admins see everything). Used by the reverse "who sees this conversation" view and the mock.
import type { Conversation, Grant, Group, Role, Scope, User } from './types';

export const ROLE_RANK: Record<Role, number> = { viewer: 1, agent: 2 };

export function grantsOfUser(userId: string, grants: Grant[], groups: Group[]): Grant[] {
  const groupIds = new Set(groups.filter((g) => g.members.includes(userId)).map((g) => g.id));
  return grants.filter(
    (g) => (g.subject.type === 'user' && g.subject.id === userId) || (g.subject.type === 'group' && groupIds.has(g.subject.id)),
  );
}

export function effective(userId: string, grants: Grant[], groups: Group[]) {
  const via = grantsOfUser(userId, grants, groups);
  let role: Role | null = null;
  const scope: Scope = { all: false, conversations: [], labels: [] };
  const convs = new Set<string>();
  const labels = new Set<string>();
  for (const g of via) {
    if (!role || ROLE_RANK[g.role] > ROLE_RANK[role]) role = g.role;
    if (g.scope.all) scope.all = true;
    g.scope.conversations.forEach((c) => convs.add(c));
    g.scope.labels.forEach((l) => labels.add(l));
  }
  if (!scope.all) {
    scope.conversations = [...convs];
    scope.labels = [...labels];
  }
  return { role, scope, via };
}

export function scopeCovers(scope: Scope, conv: Pick<Conversation, 'id' | 'labels'>): boolean {
  return scope.all || scope.conversations.includes(conv.id) || conv.labels.some((l) => scope.labels.includes(l));
}

export interface ConversationAccessRow {
  user: User;
  /** The user's effective role (roles are not per conversation), or "admin". */
  role: Role | 'admin';
  /** Grants that make this conversation visible to the user. */
  via: Grant[];
}

/** Who can see `conv`: admins, plus every enabled user with a grant (own or via a group) covering it. */
export function whoSees(conv: Conversation, users: User[], grants: Grant[], groups: Group[]): ConversationAccessRow[] {
  const rows: ConversationAccessRow[] = [];
  for (const user of users) {
    if (user.disabled) continue;
    if (user.isAdmin) {
      rows.push({ user, role: 'admin', via: [] });
      continue;
    }
    const eff = effective(user.id, grants, groups);
    const via = eff.via.filter((g) => scopeCovers(g.scope, conv));
    if (via.length && eff.role) rows.push({ user, role: eff.role, via });
  }
  return rows.sort((a, b) => (a.role === 'admin' ? 1 : 0) - (b.role === 'admin' ? 1 : 0) || a.user.username.localeCompare(b.user.username));
}
