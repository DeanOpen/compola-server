# Compola Server — design references (Mobbin)

Patterns, not skins: everything stays in the Zalo PC look (docs/zalo-pc-style.md). Do not copy other products' branding.

## Desktop

The joined app's sign-in (login card › "Compola Server" tab, `src/features/remote/JoinServer.tsx`), the connection
gate (`RemoteGate.tsx`) and Settings › Compola Server (`ServerSettings.tsx`). Mock: `npm run dev`, then
`?mock=1&phase=login` (join), `&providers=many` (provider tiles), `?mock=1&remote=offline|drop|viewer|agent`,
`?mock=1&settings=server` (host).

| Where | App · screen | Link | What we borrowed |
|---|---|---|---|
| Join › address | Miro · sign in | [mobbin](https://mobbin.com/screens/f00037ce-c11b-4365-8a32-809e3ef9e687) | The server address is the first, prominent field (40px). A quiet secondary line under the form ("Dùng tài khoản Zalo của riêng bạn? Đăng nhập bằng mã QR"), like Miro's "different region / private organization" link. The device name is a separate field, labelled as the device and not the account. |
| Join › sign-in | Notion · login | [mobbin](https://mobbin.com/screens/c10168a0-730b-4a72-933c-22614ff4c648) | Username + password first, then a "hoặc tiếp tục với" divider, then provider tiles (each OIDC provider + "Trình duyệt") when there are more than two SSO providers. The resolved server shows as a chip "Máy chủ: <serverName> · đổi" above the form, with "Thiết bị: <deviceName>" under it. |
| Join › sign-in (1–2 SSO providers) | Calendly · sign in | [mobbin](https://mobbin.com/screens/275fcd1b-1caf-4143-b676-f09542baeef7) | Full-width "Tiếp tục với <provider>" buttons, plus "Tiếp tục với trình duyệt", instead of tiles. |
| Join › browser code | incident.io · Sign in with Slack | [mobbin](https://mobbin.com/screens/c225706e-d8c6-4a12-a697-e07e5e928570) | A two-logo header (Compola ⇄ server), the user code in large segmented boxes to compare with the browser, the expiry line ("Mã hết hạn sau 10 phút"), a waiting pill, and small "Mở lại trình duyệt" / "Huỷ" links. |
| Settings › sessions | Framer · Sessions | [mobbin](https://mobbin.com/screens/55d95f0f-0015-40bd-bb94-7a7930898dc5) | One row per session: an icon with an online dot, two lines, and a per-row "Ngắt" on the right. |
| Settings › sessions | Airtable · sessions | [mobbin](https://mobbin.com/screens/d055c852-3894-4756-a84e-c739457a0b9c) | What line 2 carries: client / IP / since. Line 1 is the person (displayName @username, plus a "Quản trị" chip); line 2 is the device (name · #short id · IP · since), so two devices with the same name can be told apart. |
| Kick / leave confirms | Replit · Sign out of all devices? | [mobbin](https://mobbin.com/screens/991321b6-852c-48dc-9f7a-7257e3b3dcfa) | A short question title ("Ngắt phiên này?", "Rời Compola Server?"), one sentence of consequence, and a red destructive primary (Zalo PC confirm layout, `ui/Overlays.tsx` `Alert`). |

Also, account vs device: wherever a joined app shows who is signed in (Settings › Compola Server, Settings › Tài
khoản, the account menu, the connection gate), it shows "Đăng nhập với tư cách <displayName> (@username)" and,
separately, "Thiết bị: <deviceName> · #<short id>". The device name is never presented as the account.
