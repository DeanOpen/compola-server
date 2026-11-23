// Shared views of Zalo accounts (M5): an account chip, and a user's access listed per account.
import { useMemo } from 'react';
import { Globe2 } from 'lucide-react';
import { ALL_ACCOUNTS, accountName } from './access';
import { api } from './api';
import { roleLabel, scopeSummary } from './format';
import { useLoad } from './hooks';
import type { MultiAccess, ZaloAccount } from './types';
import { Avatar, Badge } from './ui';

export type AccountBrief = Pick<ZaloAccount, 'id' | 'name' | 'label' | 'avatar'>;

/** Admins: the host's accounts (empty on failure). Keyed by id, plus the ordered list. */
export function useAccounts(enabled = true) {
  const state = useLoad(() => (enabled ? api.accounts().catch(() => null) : Promise.resolve(null)), [enabled]);
  const list = state.data?.accounts ?? [];
  const byId = useMemo(() => new Map(list.map((a) => [a.id, a])), [list]);
  return { list, byId, data: state.data, reload: state.reload, loaded: state.data !== undefined };
}

export function AccountChip({ id, account, size = 20 }: { id: string; account?: AccountBrief | null; size?: number }) {
  if (id === ALL_ACCOUNTS)
    return (
      <span className="account-chip">
        <span className="group-icon group-icon-sm" style={{ width: size, height: size }}>
          <Globe2 size={size * 0.6} />
        </span>
        <span className="truncate">Tất cả tài khoản</span>
      </span>
    );
  const name = accountName(account, id);
  return (
    <span className="account-chip" title={id}>
      <Avatar name={name} src={account?.avatar} size={size} />
      <span className="truncate">{name}</span>
    </span>
  );
}

const ROLE_TONE: Record<string, 'accent' | 'ok' | 'neutral'> = { admin: 'accent', agent: 'ok', viewer: 'neutral' };

/** "Kho HN — Nhân viên · 3 cuộc trò chuyện" for each account the user can use. */
export function AccessByAccount({ access, accounts, empty }: { access: MultiAccess; accounts: Map<string, AccountBrief>; empty?: React.ReactNode }) {
  const ids = Object.keys(access.accounts);
  if (!ids.length) return <>{empty ?? <span className="secondary">Chưa được cấp quyền trên tài khoản Zalo nào.</span>}</>;
  // Known accounts in their order first, unknown ids after.
  const order = [...accounts.keys()];
  ids.sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999));
  return (
    <ul className="access-accounts">
      {ids.map((id) => {
        const a = access.accounts[id];
        return (
          <li key={id}>
            <AccountChip id={id} account={accounts.get(id)} size={22} />
            <Badge tone={ROLE_TONE[a.role] ?? 'neutral'}>{roleLabel(a.role)}</Badge>
            <span className="secondary small">{a.role === 'admin' ? 'Mọi cuộc trò chuyện' : scopeSummary(a.scope)}</span>
          </li>
        );
      })}
    </ul>
  );
}
