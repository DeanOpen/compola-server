# Compola Server

The server half of Compola: one Compola app shares its Zalo account with other people. Each person signs in with
their own account (local, LDAP or OIDC), gets a role and a conversation/label scope, and is audited.

| Path | What |
|---|---|
| `src-tauri/src/remote/` | Rust server: HTTP/WebSocket API, auth (local / LDAP / OIDC, device sign-in), RBAC policy, store, audit and activity |
| `admin/` | Admin console (React + Vite), served at `/admin/` |
| `docs/compola-server.md` | Design and HTTP contract |
| `docs/design-refs/compola-server/` | UI references |

The desktop app lives in **compola-client**, which currently compiles `src-tauri/src/remote/` into the app. This repo
was extracted from it with full history. Next step: make the server core (`api`, `auth`, `http`, `policy`, `store`) a
standalone crate behind a small host interface, and have the client depend on it.

## Admin console

```sh
npm install
npm run dev:admin            # http://localhost:1430/admin/?mock=1  (mock data; sign in as admin, lan or minh)
npm run build:admin          # → src-tauri/admin-dist/, embedded by the Rust server
```
