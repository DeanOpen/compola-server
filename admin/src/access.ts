// Effective access, as the server computes it (docs/compola-server.md, M5): per Zalo account, the highest role and
// the union of scopes over the user's and their groups' grants for that account or "*" (every account); admins see
// everything. Used by the "who sees this conversation" view, the users table and the mock.
import type { AccountAccess, Conversation, Grant, Group, Me, MeRole, MultiAccess, Role, Scope, User, ZaloAccount } from './types';

export const ROLE_RANK: Record<Role, number> = { viewer: 1, agent: 2 };
export const ALL_ACCOUNTS = '*';

/** The account of a grant ("default" for grants made before M5). */
export const grantAccount = (g: Grant) => g.account || 'default';

export function grantsOfUser(userId: string, grants: Grant[], groups: Group[]): Grant[] {
  const groupIds = new Set(groups.filter((g) => g.members.includes(userId)).map((g) => g.id));
  return grants.filter(
    (g) => (g.subject.type === 'user' && g.subject.id === userId) || (g.subject.type === 'group' && groupIds.has(g.subject.id)),
  );
}

/** Grants that apply to `account` (that account or "*"); every grant when `account` is undefined. */
export function grantsFor(account: string | undefined, grants: Grant[]): Grant[] {
  return account === undefined ? grants : grants.filter((g) => grantAccount(g) === account || grantAccount(g) === ALL_ACCOUNTS);
}

/** Effective access of a user on one account (or over all grants when `account` is undefined). */
export function effective(userId: string, grants: Grant[], groups: Group[], account?: string) {
  const via = grantsFor(account, grantsOfUser(userId, grants, groups));
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

/** `{admin, accounts}` of a user over the given account ids (the server's shape). */
export function multiAccess(user: User, grants: Grant[], groups: Group[], accountIds: string[]): MultiAccess {
  const accounts: Record<string, AccountAccess> = {};
  for (const id of accountIds) {
    if (user.isAdmin) {
      accounts[id] = { role: 'admin', scope: { all: true, conversations: [], labels: [] } };
      continue;
    }
    const e = effective(user.id, grants, groups, id);
    if (e.role) accounts[id] = { role: e.role, scope: e.scope };
  }
  return { admin: user.isAdmin, accounts };
}

export function scopeCovers(scope: Scope, conv: Pick<Conversation, 'id' | 'labels'>): boolean {
  return scope.all || scope.conversations.includes(conv.id) || conv.labels.some((l) => scope.labels.includes(l));
}

export interface ConversationAccessRow {
  user: User;
  /** The user's effective role on the conversation's account (roles are not per conversation), or "admin". */
  role: Role | 'admin';
  /** Grants that make this conversation visible to the user. */
  via: Grant[];
}

/** Who can see `conv` of `account`: admins, plus every enabled user with a grant (own or via a group) on that account
 *  (or "*") covering it. */
export function whoSees(account: string, conv: Conversation, users: User[], grants: Grant[], groups: Group[]): ConversationAccessRow[] {
  const rows: ConversationAccessRow[] = [];
  for (const user of users) {
    if (user.disabled) continue;
    if (user.isAdmin) {
      rows.push({ user, role: 'admin', via: [] });
      continue;
    }
    const eff = effective(user.id, grants, groups, account);
    const via = eff.via.filter((g) => scopeCovers(g.scope, conv));
    if (via.length && eff.role) rows.push({ user, role: eff.role, via });
  }
  return rows.sort((a, b) => (a.role === 'admin' ? 1 : 0) - (b.role === 'admin' ? 1 : 0) || a.user.username.localeCompare(b.user.username));
}

/** The highest role of the signed-in user over every account: "admin", "agent", "viewer" or null (no access). */
export function topRole(me: Pick<Me, 'user' | 'access'>): MeRole {
  if (me.user.isAdmin || me.access.admin) return 'admin';
  let best: Role | null = null;
  for (const a of Object.values(me.access.accounts)) {
    if (a.role === 'admin') return 'admin';
    if (!best || ROLE_RANK[a.role] > ROLE_RANK[best]) best = a.role;
  }
  return best;
}

/** The name to show for a Zalo account: its label, else its Zalo name, else a fallback. */
export function accountName(a: Pick<ZaloAccount, 'id' | 'label' | 'name'> | undefined | null, id?: string): string {
  if (!a) return id === ALL_ACCOUNTS ? 'Tất cả tài khoản' : id === 'default' ? 'Tài khoản chính' : id ? `Tài khoản ${id}` : 'Tài khoản Zalo';
  return a.label || a.name || (a.id === 'default' ? 'Tài khoản chính' : `Tài khoản ${a.id}`);
}

export function phaseKind(p: ZaloAccount['phase'] | null | undefined): string {
  if (!p) return 'starting';
  return typeof p === 'string' ? p : p.kind;
}
