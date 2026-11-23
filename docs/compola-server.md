# Compola Server — design & contracts

One Compola app (the **host**) shares its signed-in Zalo account. People sign in to it — local accounts, LDAP, or
SSO (OpenID Connect / OAuth 2) — from another Compola app (**joined app**) and use the account with the access an
admin gave them: a role (viewer / agent) and a scope (all conversations, or chosen conversations and Zalo labels).
The host also serves an **admin console** (`/admin`, Vite + React) to manage users, groups, sign-in providers,
access grants, devices and the audit log.

The Zalo session (cookies, databases, keys) never leaves the host. A joined app only sees what the UI sees, filtered
by its user's access.

## Code map

| Part | Where |
|---|---|
| Listener, HTTP routes, WebSocket sessions, uploads | `src-tauri/src/remote/server.rs`, `http.rs` |
| Users, groups, grants, sessions, providers, audit (SQLite) | `src-tauri/src/remote/store.rs` |
| Sign-in: local passwords (argon2), LDAP, OIDC / OAuth 2, device flow | `src-tauri/src/remote/auth.rs` |
| Admin + auth REST API | `src-tauri/src/remote/api.rs` |
| Access enforcement (state filtering, call checks) | `src-tauri/src/remote/policy.rs` |
| Joined side (WebSocket client, media, uploads) | `src-tauri/src/remote/client.rs` |
| Config, Tauri commands | `src-tauri/src/remote/mod.rs` |
| Admin console (served at `/admin/`) | `admin/` → built into `src-tauri/admin-dist/` (`npm run build:admin`) |
| Desktop UI: join screen, transport, settings | `src/engine/backend.ts`, `src/engine/remote.ts`, `src/features/remote/*` |

## Concepts

- **User**: `{id, username, displayName, email, source: "local" | "ldap:<providerId>" | "oidc:<providerId>", isAdmin,
  disabled, createdAt, lastLoginAt}`. Local users have a password (argon2id). LDAP / OIDC users are created on their
  first sign-in (just-in-time) and can be pre-created by an admin with the same username to give them access up front.
- **Group**: `{id, name, description, source: "local" | "ldap:<providerId>", members: userId[]}`. LDAP groups are
  synced at sign-in when the provider maps groups.
- **Grant**: who may use this Zalo account and how.
  `{id, subject: {type: "user" | "group", id}, role: "viewer" | "agent", scope: {all: boolean, conversations: string[],
  labels: string[]}, note, createdAt}`.
  - `viewer`: read only (no send, react, recall, pin, mark read on the server side, group admin, …).
  - `agent`: read and act within the scope.
  - Admins (`isAdmin`) manage the server and see everything as an agent.
  - **Effective access** of a user = highest role over their own and their groups' grants; scope = union
    (`all` wins). No grant and not admin → may sign in to the admin console only to see "no access".
- **Account ≠ device.** The identity is always the server user (`username` is unique, case-insensitive). A device is
  only where a session runs: `deviceId` (random, stable per Compola install) + `deviceName` (a label, may repeat).
  Sessions, audit entries and device approvals carry both, shown separately.
- **Session**: a sign-in. `kind: "web"` (admin console cookie `compola_session`, 12 h) or `"device"` (joined app bearer
  token, 90 days, sliding). Revocable by admins and by the user.
- **Provider**: `{id, kind: "ldap" | "oidc", name, enabled, config}`.
  - LDAP config: `{url: "ldaps://…" | "ldap://…", startTls, bindDn, bindPassword (write-only), userBaseDn,
    userFilter: "(uid={username})", usernameAttr, displayNameAttr, emailAttr, groupBaseDn?, groupFilter?:
    "(member={dn})", groupNameAttr?, adminGroup?, autoCreate: boolean}`.
  - OIDC config: `{issuer}` (discovery) **or** manual `{authorizationUrl, tokenUrl, userinfoUrl}`, `{clientId,
    clientSecret (write-only), scopes: "openid profile email", usernameClaim: "preferred_username" | "email" | …,
    displayNameClaim, emailClaim, groupsClaim?, adminGroup?, autoCreate: boolean}`. Plain OAuth 2 (GitHub, …) = manual
    URLs without `openid`.
- **Audit entry**: `{id, at, actor: {userId, username} | null, action, target, detail, ip}`. Actions: `login`,
  `login.failed`, `logout`, `user.create|update|delete|password`, `group.*`, `grant.*`, `provider.*`, `session.revoke`,
  `device.approve`, `message.send` (and other writes by joined users: `call.<target>.<method>`), `denied` (refused by
  policy).

## HTTP API (host, `http(s)://<host>:<port>`)

All bodies JSON. Errors: `{error: "<Vietnamese message>"}` with 400/401/403/404/409.
Auth: admin console = cookie `compola_session` **and** header `X-Compola: 1` on every `/api` request that changes
something (cross-site forms cannot set it). Joined apps = `Authorization: Bearer <device token>`.

### Public
- `GET /info` → `{app: "compola-server", version, instance}` (`instance`: a joining app refuses its own server)
- `GET /api/auth/providers` → `{serverName, local: true, ldap: [{id, name}], oidc: [{id, name}]}`

### Sign-in
- `POST /api/auth/login` `{username, password, provider: "local" | "<ldapProviderId>", device?: {name, id}}`
  → without `device`: sets the session cookie, `{user}`; with `device`: `{token, user}` (no cookie).
- `GET /api/auth/oidc/<providerId>/start?next=<path under /admin/>[&device=<userCode>]` → 302 to the IdP.
- `GET /api/auth/oidc/callback?code&state` → session cookie, 302 to `next` (or the device approval page).
- `GET /api/auth/otp?t=<one-time token>` → session cookie for the host's owner (created by the host app's
  "Mở trang quản trị" button), 302 to `/admin/`.
- `POST /api/auth/link` (signed in, any user) → `{token}`: a one-time link `GET /api/auth/otp?t=<token>&next=/admin/…`
  that opens the console signed in as that user (the apps' "Mở trang quản trị").
- `POST /api/auth/logout` → clears the cookie / revokes the bearer token.
- `GET /api/me` → `{user, access: {role: "admin" | "agent" | "viewer" | null, scope}}`

### Device sign-in (joined app with SSO or any provider via the browser)
1. App: `POST /api/device/start` `{deviceName, deviceId}` → `{deviceCode, userCode: "ABCD-EFGH", verifyUrl, expiresIn: 600,
   interval: 2}`; `verifyUrl` = `<publicUrl>/admin/#/device?code=<userCode>`. The app opens it in the browser.
2. Browser: signs in (any provider), `GET /api/device/info?code=<userCode>` → `{deviceName, deviceId, ip, createdAt}`, sees "Cho phép <deviceName> dùng tài khoản của bạn?", `POST /api/device/approve`
   `{userCode, approve: boolean}`.
3. App polls `POST /api/device/poll` `{deviceCode}` → `{status: "pending"}` | `{status: "approved", token, user}`
   (once) | `{status: "denied" | "expired"}`.

### Admin (`isAdmin` only)
- Users: `GET /api/admin/users` · `POST /api/admin/users` `{username, displayName, email, password?, isAdmin}` ·
  `PATCH /api/admin/users/<id>` `{displayName?, email?, isAdmin?, disabled?}` · `POST /api/admin/users/<id>/password`
  `{password}` · `DELETE /api/admin/users/<id>`
- Groups: `GET|POST /api/admin/groups` · `PATCH|DELETE /api/admin/groups/<id>` · `PUT /api/admin/groups/<id>/members`
  `{userIds}`
- Grants: `GET|POST /api/admin/grants` · `PATCH|DELETE /api/admin/grants/<id>`
- Effective access: `GET /api/admin/access/<userId>` → `{role, scope, via: [{grantId, subject, role}]}`
- Providers: `GET|POST /api/admin/providers` · `PATCH|DELETE /api/admin/providers/<id>` · `POST
  /api/admin/providers/<id>/test` `{username?, password?}` → `{ok, message, user?}` (secrets are never returned:
  `"bindPassword": "••••"` when set; sending `"••••"` keeps the stored value)
- Sessions / devices: `GET /api/admin/sessions` → `[{id, user: {id, username, displayName}, kind, deviceId, deviceName, ip, createdAt, lastSeenAt, online}]`
  · `DELETE /api/admin/sessions/<id>`
- Audit: `GET /api/admin/audit?limit=100&before=<id>&userId=&action=`
- Account data for the grant editor: `GET /api/admin/conversations` → `{conversations: [{id, name, isGroup, avatar,
  labels: [labelId]}], labels: [{id, name, color}]}` (from what the host's renderer posted)
- The host's Zalo account: `GET /api/admin/zalo` → `{phase, account: {name, avatar, phase}}` (`phase` is the engine
  phase, `login.qr` a data URL, steps generating / waitingScan / waitingConfirm {name, avatar} / expired / failed);
  `POST /api/admin/zalo/qr` (new QR), `POST /api/admin/zalo/logout` (sign the host out of Zalo), `POST
  /api/admin/zalo/retry` (runtime setup). All audited (`zalo.*`). Poll `GET` every ~2 s while the screen is open.
- Server: `GET /api/admin/server` → `{name, version, publicUrl, account: {name, avatar, phase}, listen: {port,
  allowNetwork}, addresses}` · `PATCH /api/admin/server` `{name?, publicUrl?}`

### Joined apps
- `GET /ws` (Bearer device token) — WebSocket. Server → app: `{t: "hello", server, user, access}`,
  `{t: "event", event, payload}`, `{t: "result", id, ok, value | error}`, `{t: "access", access}` (an admin changed
  it), `{t: "bye", reason: "revoked" | "disabled" | "restarted" | "lagged"}`. App → server: `{t: "invoke", id, cmd,
  args}`.
- `GET|HEAD /media/load?…` — the `compola-media` scheme of the host (Range).
- `POST /upload?id=<32 hex>&name=&offset=` — files to send, appended in chunks → `{path: "<id>/<name>", size}`.

### Static
- `GET /admin/` and below → the admin console (SPA, `index.html` fallback for unknown paths).

## Enforcement (policy.rs)

Every `compola://state` event, the `engine_replay` events, notifications and every `invoke` of a joined user pass
through the policy of that user's access:

- **State events**: conversation-bearing payloads are filtered to the visible conversations (lists filtered, events of
  other conversations dropped). Unknown payload kinds are dropped for scoped users (deny by default) and passed for
  `all` scope.
- **Calls**: each `(target, method)` is classified `read` / `write` / `denied`; `write` needs `agent`; the
  conversation the call touches (an argument, or the conversation of a message id the host has seen) must be
  visible. Unknown methods are refused for scoped users and viewers.
- **Results** of listing / search calls are filtered the same way.
- **Notifications** go only to users who may see the conversation (`tag`).

Known limit: there is one official renderer per host, so its "open conversation" is shared. When two people open
different chats at once, the renderer follows the latest request; each joined UI re-requests its chat when it
regains focus.

## Host app (desktop) — Tauri commands

- `remote_state()` → `{mode: "local" | "joined", computerName, server: {config: {enabled, port, allowNetwork, name,
  publicUrl}, running, error, addresses: [{ip, kind}], hasAdmin, adminUrl, sessions: [...]}, join, lastJoin,
  connection}`
- `remote_set_server(config)`
- `remote_admin_setup({username, password, displayName})` → creates the first admin (only when there is none)
- `remote_admin_open()` → opens the admin console in the browser, signed in as the owner (one-time link); returns it
- `remote_kick(sessionId)` → revokes a session
- `remote_api({method, path, body?})` → the REST API above (`path` below `/api/`: `admin/…`, `me…`, `device/…`) for the
  app's native admin screens: as the device's user when joined (bearer token), as the owner on the host. The server
  enforces admin on `admin/*`. Errors are the server's Vietnamese `{error}` text.
- `remote_admin_open({next?})` → opens `<server>/admin/` (or `next`, e.g. `/admin/#/audit`) signed in: the owner on the
  host, the device's user when joined.

Joining is refused when the server's `instance` is this install, and while this app's own server is enabled (it
would stop sharing its account). A saved join to this Mac (loopback / own address) is dropped at startup when the
server is enabled. Leaving (`remote_leave`) restarts the app in host mode: engine, automation and server start again.

## Joined app — Tauri commands

- `remote_providers(url)` → `{url (normalized), serverName, local, ldap, oidc}` (checks the address)
- `remote_join_password({url, username, password, provider, deviceName})` → saves the token and restarts the app
- `remote_join_browser({url, deviceName})` → device flow: opens the browser, waits for approval (emits
  `compola://remote {kind: "joinProgress", userCode, verifyUrl}`), then saves and restarts. `remote_join_cancel()`.
- `remote_status()` → `{mode, connection?}`; `connection` = `{state: "connecting" | "connected" | "disconnected",
  error, serverName, url, deviceId, deviceName, everConnected, retryAt, user: {username, displayName} | null, access: {role,
  scope: {all, conversations, labels}} | null}`
- `remote_leave()` (revokes the token on the server when reachable, restarts), `remote_retry()`,
  `remote_wait_connected()`, `remote_invoke(command, args)`, `remote_call_with_files(…)`, `remote_media_save(url,
  destPath)`, `remote_media_open_file(url, name)`
- Event `compola://remote`: `{kind: "changed"}` (host settings / sessions), `{kind: "connection", …connection}`,
  `{kind: "joinProgress", …}`, `{kind: "access", access}`.

Commands a joined UI keeps local: `ui_widen_window`, `clipboard_paste_files`, `media_allow_previews`,
`notification_authorization`, `notification_request_authorization`, `ui_set_open_conversation`,
`ui_set_shows_preview`, `calls_status`, all `remote_*`. Rewritten: `engine_call_with_files` → `remote_call_with_files`,
`media_save` → `remote_media_save`, `media_open_file` → `remote_media_open_file`, `engine_logout` → `remote_leave`.
Refused with a message: `screen_capture_start`, `call_show_window`, `engine_show_renderer`, `engine_switch_to_sqlite`,
`engine_eval`, `automation_*` and `ai_clients_*` (except `automation_search`, `automation_search_status`,
`automation_conversations`, `automation_messages`, which the host serves with the policy applied). Everything else →
`remote_invoke`.

## Activity tracking (per staff)

Every call a server user makes through Compola Server (joined app, web client) is attributed and stored in
`server.db` table `activity`, next to the audit log (the audit log is about administration; activity is about the
Zalo work itself). Calls made directly in the host app are recorded with `user = null`, `device.kind = "host"`.

Entry: `{id, at, account, user: {id, username, displayName} | null, device: {id, name, kind: "device" | "web" |
"host"}, action, conversation: {id, name} | null, messageId, ok, responseMs | null, detail}`.
`account` is the Zalo account id (`""` until multi-account lands).

Actions (from `policy::describe_call`): `message.send` (text), `message.media`, `message.file`, `message.sticker`,
`message.card`, `message.forward`, `message.recall`, `message.delete`, `message.react`, `message.pin`,
`message.unpin`, `message.star`, `conversation.open`, `conversation.read`, `conversation.unread`,
`conversation.pin`, `conversation.archive`, `conversation.mute`, `poll.create`, `poll.vote`, `reminder.create`,
`group.member`, `contact.request`, … (`detail.call` keeps `target.method`). Message text is never stored.

`responseMs`: on a successful send, the time since the oldest inbound message of that conversation that had no
reply yet (from the host's renderer state), else null.

- `GET /api/admin/activity?userId=&account=&conversationId=&action=<exact or prefix>&from=<ms>&to=<ms>&limit=100&before=<id>`
  → `[entry]`, newest first.
- `GET /api/admin/activity/stats?from=&to=&account=&userId=&groupBy=user|day|account|conversation` →
  `{rows: [{key, label, sent, media, recalled, reactions, reads, opens, conversations, responses, avgResponseMs,
  medianResponseMs, p90ResponseMs}], totals: {…same}}`; `day` keys are `YYYY-MM-DD` in the host's local time.
- `GET /api/admin/activity/export.csv?…filters` → CSV (UTF-8 with BOM, for Excel), `Content-Disposition: attachment`.

## Web client (`/web/`)

The desktop UI also runs in the browser at `<server>/web/` (built with `npm run build:web` into
`src-tauri/web-dist`). It signs in with the console's cookie session (`/admin/#/login?next=/web/`), talks to `GET /ws`
with that cookie (Origin must be the server's own), loads media from `/media/load` and uploads through `/upload`
(cookie + `X-Compola: 1`). Same policy as joined apps: a user needs an access grant.

## Multiple Zalo accounts (M5, docs/multi-account.md §7)

The server shares every account of the host. Access, mirror, policy, activity and the wire carry the account.

- **Grants** gain `account: "<accountId>" | "*"` (default `"default"`; existing grants migrate to `"default"`).
  `"*"` = every account, present and future, and requires `scope.all` (400 otherwise).
- **Access** (`/api/me`, `/api/admin/access/<id>`, WS `hello` / `access`):
  `{admin: bool, accounts: {<accountId>: {role, scope}}}`; admins get every account as `admin`. The highest role and
  the union of scopes per account over the user's and groups' grants, `"*"` grants included.
  `/api/admin/access/<id>` → `{user, admin, accounts, via: [{grantId, subject, account, role, scope}]}`.
- **Accounts API** (admins): `GET /api/admin/accounts` → `{active, maxAccounts, accounts: [{id, uid, name, label,
  avatar, order, enabled, active, phase, badge}]}` · `POST /api/admin/accounts` → `{id}` (a new account on its QR
  screen) · `GET /api/admin/accounts/<id>` → `{account: summary, phase}` (`phase.login.qr` while signing in) ·
  `POST …/<id>/qr` · `POST …/<id>/logout` · `DELETE …/<id>` (`default`: sign-out only) · `PATCH …/<id>
  {label?, enabled?}` · `PUT /api/admin/accounts/order {ids}`. `/api/admin/zalo*` stays as an alias of `default`.
  `GET /api/admin/conversations?account=<id>` (default `default`). Audit `zalo.*` entries carry `account`.
- **Wire**: `hello` and `access` carry `accounts`: the account summaries the user may see (granted ones; all for
  admins). Events are `{t: "event", account, event, payload}` with the payload tagged like on the host
  (`account` field; `badge` → `{account, count}`; `page` → `{account, page}`). Invokes select with `args.account`
  (missing → the user's first account in order). Media: `/media/load?…&account=` is checked against access.
- **Activity** entries carry the account id and its uid; the console's account filter lists the accounts.
- **Joined app / web client**: the switcher lists the server's accounts from `hello` (`remote_accounts_list`).
  Choosing one is local (`remote_account_set_active`): the joined UI shows that account's events (or all accounts'
  with `ui_set_event_scope("all")`), and `remote_invoke` fills `args.account` with it. `account_add|remove|
  set_enabled|rename|reorder` are not available in a joined app (admins manage accounts in Quản trị máy chủ).
