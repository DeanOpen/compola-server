// Vietnamese wording for staff activity (docs/compola-server.md "Activity tracking").

/** Action categories of the timeline filter → the `action` values (exact or prefix, comma-separated) they cover. */
export const ACTIVITY_CATEGORIES: { key: string; label: string; actions: string[] }[] = [
  { key: 'send', label: 'Gửi tin', actions: ['message.send', 'message.media', 'message.file', 'message.sticker', 'message.card', 'message.forward'] },
  { key: 'recall', label: 'Thu hồi', actions: ['message.recall'] },
  { key: 'react', label: 'Cảm xúc', actions: ['message.react'] },
  { key: 'read', label: 'Đã đọc', actions: ['conversation.read'] },
  { key: 'open', label: 'Mở hội thoại', actions: ['conversation.open'] },
  {
    key: 'other',
    label: 'Khác',
    actions: [
      'message.delete',
      'message.pin',
      'message.unpin',
      'message.star',
      'message.action',
      'message.confirm',
      'conversation.unread',
      'conversation.pin',
      'conversation.unpin',
      'conversation.archive',
      'conversation.unarchive',
      'conversation.mute',
      'conversation.delete',
      'conversation.hide',
      'conversation.unhide',
      'conversation.hiddenPin',
      'conversation.label',
      'label',
      'poll',
      'reminder',
      'group',
      'contact',
      'settings',
      'cloud',
      'transfer',
    ],
  },
];

export function categoryOf(action: string): (typeof ACTIVITY_CATEGORIES)[number] {
  return (
    ACTIVITY_CATEGORIES.find((c) => c.actions.some((a) => action === a || action.startsWith(a + '.'))) ??
    ACTIVITY_CATEGORIES[ACTIVITY_CATEGORIES.length - 1]
  );
}

export const CATEGORY_TONE: Record<string, 'ok' | 'info' | 'warn' | 'neutral' | 'accent'> = {
  send: 'ok',
  recall: 'warn',
  react: 'accent',
  read: 'info',
  open: 'neutral',
  other: 'neutral',
};

/** "đã gửi tin nhắn" … (the predicate; the conversation is added by the caller). */
export const ACTIVITY_VERB: Record<string, string> = {
  'message.send': 'đã gửi tin nhắn',
  'message.media': 'đã gửi ảnh / video',
  'message.file': 'đã gửi tệp',
  'message.sticker': 'đã gửi sticker',
  'message.card': 'đã gửi danh thiếp',
  'message.forward': 'đã chuyển tiếp tin nhắn',
  'message.recall': 'đã thu hồi tin nhắn',
  'message.delete': 'đã xóa tin nhắn ở phía mình',
  'message.react': 'đã thả cảm xúc',
  'message.pin': 'đã ghim tin nhắn',
  'message.unpin': 'đã bỏ ghim tin nhắn',
  'message.star': 'đã đánh dấu tin nhắn',
  'conversation.open': 'đã mở hội thoại',
  'conversation.read': 'đã đánh dấu đã đọc',
  'conversation.unread': 'đã đánh dấu chưa đọc',
  'conversation.pin': 'đã ghim hội thoại',
  'conversation.archive': 'đã lưu trữ hội thoại',
  'conversation.mute': 'đã tắt thông báo hội thoại',
  'poll.create': 'đã tạo bình chọn',
  'poll.vote': 'đã bình chọn',
  'reminder.create': 'đã tạo nhắc hẹn',
  'message.action': 'đã bấm nút trong tin nhắn',
  'message.confirm': 'đã xác nhận tin nhắn',
  'conversation.unpin': 'đã bỏ ghim hội thoại',
  'conversation.unarchive': 'đã bỏ lưu trữ hội thoại',
  'conversation.delete': 'đã xóa hội thoại',
  'conversation.hide': 'đã ẩn hội thoại',
  'conversation.unhide': 'đã bỏ ẩn hội thoại',
  'conversation.hiddenPin': 'đã đổi mã PIN hội thoại ẩn',
  'conversation.label': 'đã gắn / bỏ nhãn hội thoại',
  'reminder.respond': 'đã trả lời nhắc hẹn',
  'group.member': 'đã thay đổi thành viên nhóm',
  'group.create': 'đã tạo nhóm',
  'group.join': 'đã tham gia nhóm',
  'group.decline': 'đã từ chối lời mời vào nhóm',
  'contact.request': 'đã gửi lời mời kết bạn',
  'contact.accept': 'đã đồng ý kết bạn',
  'contact.decline': 'đã từ chối lời mời kết bạn',
  'contact.cancel': 'đã hủy lời mời kết bạn',
  'contact.dismiss': 'đã bỏ qua gợi ý kết bạn',
  'contact.block': 'đã chặn / bỏ chặn liên hệ',
  'contact.alias': 'đã đặt tên gợi nhớ cho liên hệ',
  'settings.notification': 'đã đổi cài đặt thông báo',
  'settings.sticker': 'đã đổi bộ sticker',
  'cloud.delete': 'đã xóa dữ liệu trong Cloud của tôi',
  'cloud.offload': 'đã dọn dữ liệu Cloud khỏi máy',
};

/** Prefix families without a specific verb above. */
const FAMILY_VERB: Record<string, string> = {
  label: 'đã sửa nhãn',
  transfer: 'đã chuyển dữ liệu',
  poll: 'đã thao tác bình chọn',
  reminder: 'đã thao tác nhắc hẹn',
  group: 'đã thao tác nhóm',
  contact: 'đã thao tác liên hệ',
  settings: 'đã đổi cài đặt',
  cloud: 'đã thao tác Cloud của tôi',
};

/** The predicate for any action: the specific verb, else its family's, else the raw call. */
export function activityVerb(action: string, call?: unknown): string {
  return ACTIVITY_VERB[action] ?? FAMILY_VERB[action.split('.')[0]] ?? `đã thao tác ${String(call ?? action)}`;
}

/** "45 giây", "3 phút", "1 giờ 20 phút", "2 ngày 3 giờ". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} giây`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} phút`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} giờ ${m % 60} phút` : `${h} giờ`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} ngày ${h % 24} giờ` : `${d} ngày`;
}

export type Frame = 'today' | '24h' | '7d' | '30d' | 'month' | 'all' | 'custom';

const DAY = 86_400_000;
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** The [from, to] of a time frame in ms (to = undefined: until now). */
export function frameRange(frame: Frame, custom?: { from: string; to: string }): { from?: number; to?: number } {
  const now = new Date();
  switch (frame) {
    case 'today':
      return { from: startOfDay(now).getTime() };
    case '24h':
      return { from: now.getTime() - DAY };
    case '7d':
      return { from: startOfDay(now).getTime() - 6 * DAY };
    case '30d':
      return { from: startOfDay(now).getTime() - 29 * DAY };
    case 'month':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1).getTime() };
    case 'custom': {
      const parse = (v: string) => (v ? new Date(`${v}T00:00:00`).getTime() : undefined);
      const from = parse(custom?.from ?? '');
      const toDay = parse(custom?.to ?? '');
      return { from, to: toDay !== undefined ? toDay + DAY - 1 : undefined };
    }
    default:
      return {};
  }
}

/** "YYYY-MM-DD" in local time. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
