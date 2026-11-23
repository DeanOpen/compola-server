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

## Admin console

`admin/` (served at `/admin/`, built into `src-tauri/admin-dist/`). Mock: `npm run dev:admin`, then
`http://localhost:1430/admin/?mock=1` (sign in as `admin`, `lan` or `minh`), or `&as=<username>` to start signed in.
Compola's own palette (Zalo blue, light + dark); preview images are on Mobbin.

| Where | App · screen | Link | What we borrowed |
|---|---|---|---|
| Shell (sidebar) | Base44 · Members and groups | [mobbin](https://mobbin.com/screens/06b69874-5889-4b5e-8f3b-bd23c6ccb4ec) | Settings-style left navigation with labelled sections: *Truy cập & danh tính* (Người dùng & nhóm, Phân quyền, Đăng nhập), *Bảo mật & giám sát* (Thiết bị, Nhật ký), *Máy chủ*, *Cá nhân*. |
| Người dùng & nhóm | Base44 · Members and groups | [mobbin](https://mobbin.com/screens/06b69874-5889-4b5e-8f3b-bd23c6ccb4ec) | One page: stat cards above (Người dùng, Quản trị viên, Được dùng Zalo, Nhóm), then **Người dùng / Nhóm tabs**; search + role filter; the person cell (avatar, name, `@username · email`, a **"Bạn"** badge), role, last active, and a row **⋯ menu** (Sửa thông tin, Đặt lại mật khẩu, Xem quyền truy cập, Xem thiết bị, Khóa / Mở khóa, Xóa). |
| Người dùng (table) | Plane · Members | [mobbin](https://mobbin.com/screens/d1e224bf-6308-4010-8a47-506f2a89662a) | Sortable columns (name, last active) and an **authentication column**, used as our source badge (Nội bộ / LDAP · tên / SSO · tên); the primary **"Thêm người dùng"** button top-right. |
| Phân quyền — role picker | Plain · Roles | [mobbin](https://mobbin.com/screens/1dee496e-c015-43c4-a0ca-79c37bf40174) | Roles as a **stacked card list**, one row per role with a one-line, plain-language description: Người xem, Nhân viên, and Quản trị viên (shown disabled: it is set on the user, not granted). It is the role radio group of the grant editor. |
| Đăng nhập (providers) | Plane · Identity | [mobbin](https://mobbin.com/screens/56666f27-de3a-4d42-9ed0-533e717d7df3) | One section per protocol (logo, title, one-line description, **Cấu hình / Thêm** on the right); each configured LDAP / OIDC provider below it with **Cấu hình**, which opens the form in a **side sheet**. |
| Đăng nhập (status) | incident.io · Security | [mobbin](https://mobbin.com/screens/fed51483-3056-4379-adc4-1482ca378c6c) | A **status pill** (Đang bật / Đã tắt / Chưa cấu hình) and a toggle per sign-in method, including "Đăng nhập bằng mật khẩu nội bộ" (always on, so admins cannot lock themselves out). |
| Nhật ký | Customer.io · Audit Logs | [mobbin](https://mobbin.com/screens/decad923-b3e9-4e22-8166-7b20e6c22140) | A **filter bar** (time frame, person, event type, IP); rows that **read as sentences** ("Trần Thị Lan (@lan) đã đăng xuất MacBook Pro #D7F3A91C · 192.168.1.31 của …") and **expand to the raw entry (JSON)**. |
| Nhật ký (person, time frame) | Klaviyo · Activity log | [mobbin](https://mobbin.com/screens/1f44450b-8a6f-4d19-83e8-24addf2ca0e8) | The person column (avatar, name, @username) and an obvious **time-frame** control (24 giờ / 7 ngày / 30 ngày / Mọi lúc). |
| Thiết bị | Airtable · Recent account activity | [mobbin](https://mobbin.com/screens/d055c852-3894-4756-a84e-c739457a0b9c) | Device / IP / sign-in / last-activity columns, a **"Phiên hiện tại"** tag, and **"Đăng xuất mọi phiên khác"** (Tài khoản của tôi). We group the rows **by person** (a card per account) and the device cell is name + short device id (+ IP column), since two devices can share a name. |
| Thiết bị (row action) | Framer · Sessions | [mobbin](https://mobbin.com/screens/55d95f0f-0015-40bd-bb94-7a7930898dc5) | A quiet per-row **Đăng xuất**. |
| Hoạt động (staff activity) | Customer.io · Audit Logs | [mobbin](https://mobbin.com/screens/decad923-b3e9-4e22-8166-7b20e6c22140) | Same as Nhật ký: a filter bar (time frame, person, Zalo account, conversation, action category) over sentence rows ("Trần Thị Lan (@lan) đã gửi tin nhắn trong «Khách A» · phản hồi sau 3 phút", device in the meta line), expandable to the raw entry; failed calls greyed ("đã thử … · không thành công"). |
| Thống kê | Klaviyo · Activity log | [mobbin](https://mobbin.com/screens/1f44450b-8a6f-4d19-83e8-24addf2ca0e8) | The time-frame control (Hôm nay / 7 ngày / 30 ngày / Tháng này / Tùy chọn) above KPI cards, a per-day bar chart (plain SVG, optionally stacked by person) and a sortable table by person / account / conversation. No new reference: a KPI-cards-plus-table layout. |
| Confirm dialogs | Replit · Sign out of all devices? | [mobbin](https://mobbin.com/screens/991321b6-852c-48dc-9f7a-7257e3b3dcfa) | A question title, one sentence on what happens (and what does not), a **destructive red primary** ("Đăng xuất mọi thiết bị", "Khóa tài khoản", "Xóa người dùng"). |
| Đăng nhập (sign-in page) | Notion · Login | [mobbin](https://mobbin.com/screens/c10168a0-730b-4a72-933c-22614ff4c648) | A centred column without a card: the **username first + "Tiếp tục"**, then the password; "hoặc tiếp tục với" and a **grid of provider tiles** (one per SSO provider, one per LDAP directory, and "Tài khoản nội bộ" when another method is selected). |
| Đăng nhập (few providers) | Calendly · Sign in | [mobbin](https://mobbin.com/screens/275fcd1b-1caf-4143-b676-f09542baeef7) | With only one or two alternatives: full-width **"Tiếp tục với …"** buttons instead of tiles. |
| Đăng nhập thiết bị | incident.io · Sign in with Slack | [mobbin](https://mobbin.com/screens/c225706e-d8c6-4a12-a697-e07e5e928570) | A **two-logo header** (Compola ⇄ device), the user code as **big segmented boxes** (XXXX – XXXX), then the requesting device (name, short device id, IP, time) and, separately, the account it signs in as; Cho phép / Từ chối. |

### Rules that came with these references

- **An account is not a device.** A person is always shown as display name + `@username` (+ source); a device as its
  name + short device id (`#` + first 8 characters of `deviceId`) + IP. Device names are never used as identities.
- Usernames are unique and case-insensitive; the create form says so and shows the server's 409 under the field.
