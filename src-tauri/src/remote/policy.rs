//! Access enforcement of Compola Server (docs/compola-server.md, "Enforcement"). Pure: no I/O, no clock.
//!
//! * [`Mirror`]: host-wide knowledge learned from every `compola://state` payload (all users): the conversation rows,
//!   the Zalo labels and their conversations, message id → conversation, poll id → conversation, people seen in a
//!   conversation, confirm tokens. The server calls [`Mirror::observe`] for every state payload **before** filtering
//!   that payload for the sessions, and [`Mirror::observe_result`] for every `engine_call` result (it learns undo ids
//!   and group members, which only answers carry).
//! * [`check_call`]: classifies one invoke of a joined user (read / write / refused) and checks the conversation it
//!   touches.
//! * [`filter_event`] / [`filter_result`]: what of an event / an answer one user may receive.
//!
//! Rules: admins see and do everything. Viewers only read. A scoped user (not `all`) sees the conversations listed
//! in their scope plus those that carry one of their labels; everything that is not explicitly known to be inside
//! that scope is dropped or refused (deny by default). Account-wide features (contacts lists, friend requests, group
//! creation, labels, hidden-chat PIN, zCloud, message transfer, settings) need the `all` scope.

use std::collections::{HashMap, VecDeque};

use serde_json::{Map, Value, json};

// ---- access ----

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Viewer,
    Agent,
    Admin,
}

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Scope {
    pub all: bool,
    pub conversations: Vec<String>,
    pub labels: Vec<String>,
}

/// Admin = sees and does everything (treated as `all` scope + write).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    pub role: Role,
    pub scope: Scope,
}

impl Access {
    pub fn is_admin(&self) -> bool {
        self.role == Role::Admin
    }

    /// Every conversation is visible (admin or `all` scope).
    pub fn sees_all(&self) -> bool {
        self.is_admin() || self.scope.all
    }

    pub fn can_write(&self) -> bool {
        self.role >= Role::Agent
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallKind {
    Read,
    Write,
}

// ---- messages (Vietnamese, shown in the joined UI) ----

pub const DENIED_VIEWER: &str = "Bạn chỉ có quyền xem nên không thể thực hiện thao tác này.";
pub const DENIED_CONVERSATION: &str = "Bạn không có quyền truy cập hội thoại này.";
pub const DENIED_UNKNOWN: &str = "Thao tác này không được phép với quyền truy cập của bạn.";
pub const DENIED_ACCOUNT_WIDE: &str = "Tính năng này chỉ dùng được khi bạn được cấp quyền với mọi hội thoại.";
pub const DENIED_REMOTE: &str = "Thao tác này không dùng được khi kết nối qua Compola Server.";
pub const DENIED_CALLS: &str = "Cuộc gọi chưa dùng được khi kết nối qua Compola Server.";

// ---- bounds of the mirror ----

const MAX_MESSAGES: usize = 50_000;
const MAX_POLLS: usize = 10_000;
const MAX_PEOPLE: usize = 30_000;
/// Conversations remembered per person.
const MAX_PEOPLE_CONVERSATIONS: usize = 8;
const MAX_TOKENS: usize = 512;

/// A map that forgets its oldest keys (insertion order) beyond `cap`.
struct Bounded<V> {
    map: HashMap<String, V>,
    order: VecDeque<String>,
}

impl<V> Default for Bounded<V> {
    fn default() -> Self {
        Self { map: HashMap::new(), order: VecDeque::new() }
    }
}

impl<V> Bounded<V> {
    fn get(&self, key: &str) -> Option<&V> {
        self.map.get(key)
    }

    fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.map.get_mut(key)
    }

    fn insert(&mut self, key: String, value: V, cap: usize) {
        if self.map.insert(key.clone(), value).is_none() {
            self.order.push_back(key);
            while self.map.len() > cap {
                match self.order.pop_front() {
                    Some(old) => {
                        self.map.remove(&old);
                    }
                    None => break,
                }
            }
        }
    }

    fn insert_if_absent(&mut self, key: String, value: V, cap: usize) {
        if !self.map.contains_key(&key) {
            self.insert(key, value, cap);
        }
    }
}

// ---- mirror ----

#[derive(Clone, Debug, PartialEq)]
struct Label {
    id: String,
    name: String,
    color: String,
    conversations: Vec<String>,
}

/// Host-wide knowledge learned from every state event (all users): conversation list (id, name, isGroup, avatar),
/// Zalo labels (id, name, color, conversation ids), message id → conversation id (bounded), poll id → conversation,
/// people seen in a conversation, confirm tokens and undo ids.
#[derive(Default)]
pub struct Mirror {
    /// Latest row of each conversation (`state-adapter.js`: `{id, isGroup, name, avatar, pinned, members, unread, preview}`).
    rows: HashMap<String, Value>,
    /// A full conversation list (`reset`) arrived: `rows` is complete.
    primed: bool,
    labels: Vec<Label>,
    /// conversation id → label ids.
    labels_of: HashMap<String, Vec<String>>,
    self_conversation: String,
    my_uid: String,
    messages: Bounded<String>,
    polls: Bounded<String>,
    people: Bounded<Vec<String>>,
    /// Composer confirm token → conversation.
    confirms: Bounded<String>,
    /// Undo id of a "delete for me" → conversation.
    undos: Bounded<String>,
    generation: u64,
}

/// A non-empty id from a string or a number.
fn id_of(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn str_of<'a>(v: Option<&'a Value>) -> &'a str {
    v.and_then(Value::as_str).unwrap_or_default()
}

impl Mirror {
    /// Called for EVERY `compola://state` payload, before it is filtered for the sessions.
    pub fn observe(&mut self, state: &Value) {
        let Some(o) = state.as_object() else { return };
        if o.get("page").and_then(Value::as_str) != Some("main") {
            return;
        }
        if let Some(uid) = o.get("user").and_then(|u| id_of(u.get("userId"))) {
            self.my_uid = uid;
        }
        if let Some(rows) = o.get("conversations") {
            self.observe_conversations(o, rows);
        }
        if let Some(extras) = o.get("conversationExtras") {
            self.observe_extras(extras);
        }
        if let Some(chat) = o.get("chat") {
            self.observe_chat(chat);
        }
        if let Some(poll) = o.get("poll") {
            if let (Some(id), Some(conv)) = (id_of(poll.get("id")), poll.get("detail").and_then(|d| id_of(d.get("groupId")))) {
                // Chat messages (trusted: the renderer's own message) win over the conversation a watcher named.
                self.polls.insert_if_absent(id, conv, MAX_POLLS);
            }
        }
        if let Some(compose) = o.get("compose") {
            if str_of(compose.get("kind")) == "confirm" {
                if let (Some(token), Some(conv)) = (id_of(compose.get("token")), id_of(compose.get("convId"))) {
                    self.confirms.insert(token, conv, MAX_TOKENS);
                }
            }
        }
        if let Some(pins) = o.get("pins") {
            if let Some(conv) = id_of(pins.get("convId")) {
                for item in pins.get("items").and_then(Value::as_array).into_iter().flatten() {
                    for key in ["msgId", "cliMsgId"] {
                        if let Some(id) = id_of(item.get(key)) {
                            self.messages.insert_if_absent(id, conv.clone(), MAX_MESSAGES);
                        }
                    }
                }
            }
        }
    }

    fn observe_conversations(&mut self, o: &Map<String, Value>, rows: &Value) {
        let reset = o.get("reset").and_then(Value::as_bool).unwrap_or(o.get("removed").is_none());
        if reset {
            self.rows.clear();
            self.primed = true;
        }
        for row in rows.as_array().into_iter().flatten() {
            if let Some(id) = id_of(row.get("id")) {
                self.rows.insert(id, row.clone());
            }
        }
        for id in o.get("removed").and_then(Value::as_array).into_iter().flatten() {
            if let Some(id) = id_of(Some(id)) {
                self.rows.remove(&id);
            }
        }
    }

    fn observe_extras(&mut self, extras: &Value) {
        if let Some(id) = extras.get("selfConversationId").and_then(Value::as_str) {
            self.self_conversation = id.to_owned();
        }
        let Some(list) = extras.get("labels").and_then(Value::as_array) else { return };
        let labels: Vec<Label> = list
            .iter()
            .filter_map(|l| {
                Some(Label {
                    id: id_of(l.get("id"))?,
                    name: str_of(l.get("name")).to_owned(),
                    color: str_of(l.get("color")).to_owned(),
                    conversations: l.get("convIds").and_then(Value::as_array).into_iter().flatten().filter_map(|c| id_of(Some(c))).collect(),
                })
            })
            .collect();
        if labels == self.labels {
            return;
        }
        let membership = |ls: &[Label]| ls.iter().map(|l| (l.id.clone(), l.conversations.clone())).collect::<Vec<_>>();
        if membership(&labels) != membership(&self.labels) {
            self.generation += 1;
        }
        self.labels_of.clear();
        for l in &labels {
            for c in &l.conversations {
                self.labels_of.entry(c.clone()).or_default().push(l.id.clone());
            }
        }
        self.labels = labels;
    }

    fn observe_chat(&mut self, chat: &Value) {
        let Some(conv) = id_of(chat.get("convId")) else { return };
        for m in chat.get("messages").and_then(Value::as_array).into_iter().flatten() {
            self.learn_message(m, &conv);
        }
    }

    /// One ChatMessageJSON (chat-adapter.js) of conversation `conv`.
    fn learn_message(&mut self, m: &Value, conv: &str) {
        let conv = id_of(m.get("conversationId")).unwrap_or_else(|| conv.to_owned());
        if let Some(id) = id_of(m.get("id")) {
            self.messages.insert(id, conv.clone(), MAX_MESSAGES);
        }
        if let Some(sender) = id_of(m.get("senderId")) {
            self.add_person(sender, &conv);
        }
        let kind = m.get("kind");
        match kind.map(|k| str_of(k.get("type"))) {
            Some("contactCard") => {
                if let Some(uid) = id_of(kind.and_then(|k| k.get("uid"))) {
                    self.add_person(uid, &conv);
                }
            }
            Some("poll") => {
                if let Some(poll) = id_of(kind.and_then(|k| k.get("pollId"))) {
                    let poll_conv = id_of(kind.and_then(|k| k.get("conversationId"))).unwrap_or_else(|| conv.clone());
                    self.polls.insert(poll, poll_conv, MAX_POLLS);
                }
            }
            _ => {}
        }
    }

    fn add_person(&mut self, uid: String, conv: &str) {
        if uid == "0" {
            return;
        }
        if let Some(convs) = self.people.get_mut(&uid) {
            if !convs.iter().any(|c| c == conv) {
                convs.push(conv.to_owned());
                if convs.len() > MAX_PEOPLE_CONVERSATIONS {
                    convs.remove(0);
                }
            }
            return;
        }
        self.people.insert(uid, vec![conv.to_owned()], MAX_PEOPLE);
    }

    /// Called with the answer of every `engine_call` / `engine_call_with_files` (any user): learns what only answers
    /// carry (undo ids of "delete for me", group members, mention candidates, reactors, shared-media items).
    pub fn observe_result(&mut self, cmd: &str, args: &Value, result: &Value) {
        if cmd != "engine_call" && cmd != "engine_call_with_files" {
            return;
        }
        let target = str_of(args.get("target"));
        let method = str_of(args.get("method"));
        let list = args.get("args").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        let Some(conv) = id_of(list.first()) else { return };
        match (target, method) {
            ("__zaloMsgActions", "deleteForMe") => {
                if let Some(id) = result.get("undo").and_then(|u| id_of(u.get("id"))) {
                    self.undos.insert(id, conv, MAX_TOKENS);
                }
            }
            ("__zaloGroupCreate", "members") => {
                for m in result.get("members").and_then(Value::as_array).into_iter().flatten() {
                    if let Some(uid) = id_of(m.get("id")) {
                        self.add_person(uid, &conv);
                    }
                }
            }
            ("__zaloChat", "mentionCandidates") => {
                for m in result.as_array().into_iter().flatten() {
                    if let Some(uid) = id_of(m.get("id")).filter(|_| m.get("isAll").and_then(Value::as_bool) != Some(true)) {
                        self.add_person(uid, &conv);
                    }
                }
            }
            ("__zaloChat", "reactors") => {
                for m in result.get("users").and_then(Value::as_array).into_iter().flatten() {
                    if let Some(uid) = id_of(m.get("uid")) {
                        self.add_person(uid, &conv);
                    }
                }
            }
            ("__zaloMediaStore", "page") => {
                for m in result.get("items").and_then(Value::as_array).into_iter().flatten() {
                    self.learn_message(m, &conv);
                }
            }
            _ => {}
        }
    }

    /// Main page reloaded / account changed.
    pub fn reset(&mut self) {
        let generation = self.generation + 1;
        *self = Self::default();
        self.generation = generation;
    }

    /// Bumped whenever which conversation carries which label changes (and on [`Mirror::reset`]): visibility of label
    /// scopes may have changed, so a session should get a fresh list ([`Mirror::conversations_snapshot`]).
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// `{conversations:[{id,name,isGroup,avatar,labels:[labelId]}], labels:[{id,name,color}]}` (admin grant editor).
    pub fn conversations_json(&self) -> Value {
        let mut rows: Vec<&Value> = self.rows.values().collect();
        let ts = |r: &Value| r.get("preview").and_then(|p| p.get("ts")).and_then(Value::as_i64).unwrap_or(0);
        rows.sort_by(|a, b| ts(b).cmp(&ts(a)).then_with(|| str_of(a.get("name")).cmp(str_of(b.get("name")))));
        let conversations: Vec<Value> = rows
            .into_iter()
            .map(|r| {
                let id = str_of(r.get("id"));
                json!({
                    "id": id,
                    "name": str_of(r.get("name")),
                    "isGroup": r.get("isGroup").and_then(Value::as_bool).unwrap_or(false),
                    "avatar": str_of(r.get("avatar")),
                    "labels": self.labels_of.get(id).cloned().unwrap_or_default(),
                })
            })
            .collect();
        let labels: Vec<Value> = self.labels.iter().map(|l| json!({ "id": l.id, "name": l.name, "color": l.color })).collect();
        json!({ "conversations": conversations, "labels": labels })
    }

    /// The conversation is inside `scope`: `all`, listed, or carries a listed label.
    pub fn visible(&self, scope: &Scope, conversation_id: &str) -> bool {
        if scope.all {
            return true;
        }
        if conversation_id.is_empty() {
            return false;
        }
        scope.conversations.iter().any(|c| c == conversation_id)
            || (!scope.labels.is_empty()
                && self.labels_of.get(conversation_id).is_some_and(|ls| ls.iter().any(|l| scope.labels.contains(l))))
    }

    fn sees(&self, access: &Access, conversation_id: &str) -> bool {
        access.is_admin() || self.visible(&access.scope, conversation_id)
    }

    /// A person is in reach: me, the other side of a visible 1:1 conversation, or someone seen in a visible
    /// conversation (sender, contact card, group member, reactor).
    fn sees_person(&self, access: &Access, uid: &str) -> bool {
        if access.sees_all() {
            return true;
        }
        if uid.is_empty() {
            return false;
        }
        (!self.my_uid.is_empty() && uid == self.my_uid)
            || self.visible(&access.scope, uid)
            || self.people.get(uid).is_some_and(|convs| convs.iter().any(|c| self.visible(&access.scope, c)))
    }

    fn unread(&self, conversation_id: &str) -> i64 {
        self.rows.get(conversation_id).and_then(|r| r.get("unread")).and_then(Value::as_i64).unwrap_or(0)
    }

    /// The conversations with unread messages among the visible ones (the badge of a scoped user); None while the
    /// conversation list is not known yet.
    pub fn unread_badge(&self, scope: &Scope) -> Option<i64> {
        if !self.primed {
            return None;
        }
        Some(self.rows.keys().filter(|id| self.visible(scope, id) && self.unread(id) > 0).count() as i64)
    }

    /// A full conversation list for one user, as the state adapter posts it (`reset: true`): what to send a session
    /// when its access or [`Mirror::generation`] changed. None until the list is known.
    pub fn conversations_snapshot(&self, access: &Access) -> Option<Value> {
        if !self.primed {
            return None;
        }
        let rows: Vec<Value> = self.rows.iter().filter(|(id, _)| self.sees(access, id)).map(|(_, r)| r.clone()).collect();
        Some(json!({ "page": "main", "conversations": rows, "removed": [], "reset": true }))
    }
}

// ---- call classification ----

#[derive(Clone, Copy, Debug, PartialEq)]
enum Op {
    Read,
    Write,
    /// Never for joined users (host lifecycle / host-local settings); admins only.
    Denied,
}

/// What a call touches; every requirement must hold for a scoped user (for `all` scope they all hold except
/// none — `Global` included).
#[derive(Clone, Copy, Debug)]
enum Need {
    /// Conversation id at this argument.
    Conv(usize),
    /// Conversation id or null (null = nothing touched).
    ConvOrNull(usize),
    /// Array of conversation ids (all of them).
    Convs(usize),
    /// Conversation at the first index, message id (nullable) at the second: the conversation must be visible and,
    /// when the mirror knows the message, so must its conversation.
    Msg(usize, usize),
    /// A person (uid) in reach.
    Person(usize),
    /// Poll id whose conversation the mirror knows and is visible.
    Poll(usize),
    /// Conversation at the first index and the poll at the second (both).
    PollIn(usize, usize),
    /// Composer confirm token whose conversation is known and visible.
    Confirm(usize),
    /// Undo id of a "delete for me" whose conversation is known and visible.
    Undo(usize),
    /// When this argument is truthy, the My Cloud conversation is touched too.
    SelfIf(usize),
    /// Account-wide: `all` scope only.
    Global,
}

use Need::*;
use Op::{Denied, Read, Write};

/// Adapter objects the UI calls (src/engine/call.ts `AdapterTarget`). Other renderer globals (`__zaloStore`,
/// `__zaloNet`, `__zaloLocal`, …) are internals: admins only.
const TARGETS: &[&str] = &[
    "__zaloChat",
    "__zaloCompose",
    "__zaloMsgActions",
    "__zaloConvActions",
    "__zaloConversations",
    "__zaloContacts",
    "__zaloPoll",
    "__zaloSticker",
    "__zaloCloud",
    "__zaloTransfer",
    "__zaloCall",
    "__zaloMediaStore",
    "__zaloNotification",
    "__zaloGroupCreate",
];

/// (target, method, op, needs). Argument indexes are into `args.args`.
#[rustfmt::skip]
const RULES: &[(&str, &str, Op, &[Need])] = &[
    // chat-adapter.js
    ("__zaloChat", "open", Read, &[Conv(0)]),
    ("__zaloChat", "close", Read, &[Conv(0)]),
    ("__zaloChat", "loadMore", Read, &[Conv(0)]),
    ("__zaloChat", "mentionCandidates", Read, &[Conv(0)]),
    ("__zaloChat", "reactors", Read, &[Msg(0, 1)]),
    ("__zaloChat", "resolveMedia", Read, &[Msg(0, 1)]),
    ("__zaloChat", "sendText", Write, &[Msg(0, 2)]),
    ("__zaloChat", "markRead", Write, &[Conv(0)]),
    ("__zaloChat", "react", Write, &[Msg(0, 1)]),
    // card-actions-adapter.js (attached to __zaloChat)
    ("__zaloChat", "performAction", Write, &[Msg(0, 1)]),
    ("__zaloChat", "cardStickers", Read, &[Msg(0, 1)]),
    ("__zaloChat", "reminderWatch", Read, &[Msg(0, 1)]),
    ("__zaloChat", "reminderResponders", Read, &[Msg(0, 1)]),
    ("__zaloChat", "reminderRespond", Write, &[Msg(0, 1)]),
    ("__zaloChat", "contactState", Read, &[Person(0)]),
    ("__zaloChat", "contactProfile", Read, &[Person(0)]),
    ("__zaloChat", "prepareFriendRequest", Read, &[Global]),
    ("__zaloChat", "aliasSave", Write, &[Conv(0)]),
    ("__zaloChat", "groupPreview", Read, &[Global]),
    ("__zaloChat", "groupJoin", Write, &[Global]),
    ("__zaloChat", "stickerCategory", Read, &[]),
    ("__zaloChat", "stickerCategorySend", Write, &[Conv(0)]),
    ("__zaloChat", "cardReset", Denied, &[]),
    // composer-adapter.js
    ("__zaloCompose", "sendMedia", Write, &[Conv(0)]),
    ("__zaloCompose", "sendFiles", Write, &[Conv(0)]),
    ("__zaloCompose", "sendShot", Write, &[Conv(0), SelfIf(1)]),
    ("__zaloCompose", "shareShot", Write, &[Convs(0)]),
    ("__zaloCompose", "sendMyCard", Write, &[Conv(0)]),
    ("__zaloCompose", "myCard", Read, &[]),
    ("__zaloCompose", "reminderInfo", Read, &[Conv(0)]),
    ("__zaloCompose", "createReminder", Write, &[Conv(0)]),
    ("__zaloCompose", "answer", Write, &[Confirm(0)]),
    ("__zaloCompose", "missing", Read, &[]),
    // message-actions-adapter.js
    ("__zaloMsgActions", "isProtected", Read, &[Conv(0)]),
    ("__zaloMsgActions", "watchPins", Read, &[ConvOrNull(0)]),
    ("__zaloMsgActions", "pins", Read, &[Conv(0)]),
    ("__zaloMsgActions", "forward", Write, &[Msg(0, 1), Convs(2)]),
    ("__zaloMsgActions", "recall", Write, &[Msg(0, 1)]),
    ("__zaloMsgActions", "deleteForMe", Write, &[Msg(0, 1)]),
    ("__zaloMsgActions", "undoDelete", Write, &[Undo(0)]),
    ("__zaloMsgActions", "commitDelete", Write, &[Undo(0)]),
    ("__zaloMsgActions", "dropDelete", Write, &[Undo(0)]),
    ("__zaloMsgActions", "star", Write, &[Msg(0, 1)]),
    ("__zaloMsgActions", "pin", Write, &[Msg(0, 1)]),
    ("__zaloMsgActions", "unpin", Write, &[Conv(0)]),
    ("__zaloMsgActions", "reset", Denied, &[]),
    // conversation-actions-adapter.js
    ("__zaloConvActions", "republish", Read, &[]),
    ("__zaloConvActions", "pinBoard", Read, &[Conv(0)]),
    ("__zaloConvActions", "pin", Write, &[Conv(0)]),
    ("__zaloConvActions", "unpin", Write, &[Conv(0)]),
    ("__zaloConvActions", "pinReplacing", Write, &[Convs(0), Conv(1)]),
    ("__zaloConvActions", "archive", Write, &[Conv(0)]),
    ("__zaloConvActions", "unarchive", Write, &[Conv(0)]),
    ("__zaloConvActions", "deleteConversation", Write, &[Conv(0)]),
    ("__zaloConvActions", "markRead", Write, &[Conv(0)]),
    ("__zaloConvActions", "markUnread", Write, &[Conv(0)]),
    ("__zaloConvActions", "checkPin", Read, &[Global]),
    ("__zaloConvActions", "hiddenSearch", Read, &[Global]),
    ("__zaloConvActions", "hide", Write, &[Conv(0), Global]),
    ("__zaloConvActions", "hideWithNewPin", Write, &[Conv(0), Global]),
    ("__zaloConvActions", "unhide", Write, &[Conv(0), Global]),
    ("__zaloConvActions", "setPin", Write, &[Global]),
    ("__zaloConvActions", "resetPin", Write, &[Global]),
    // conversations-adapter.js (labels define label scopes: account-wide)
    ("__zaloConversations", "publish", Read, &[]),
    ("__zaloConversations", "setFilter", Read, &[]),
    ("__zaloConversations", "setConvLabel", Write, &[Conv(0), Global]),
    ("__zaloConversations", "createLabel", Write, &[Global]),
    ("__zaloConversations", "updateLabel", Write, &[Global]),
    ("__zaloConversations", "deleteLabel", Write, &[Global]),
    ("__zaloConversations", "reorderLabels", Write, &[Global]),
    // contacts-adapter.js (the `contacts` state is filtered for scoped users)
    ("__zaloContacts", "refresh", Read, &[]),
    ("__zaloContacts", "resetSearch", Read, &[]),
    ("__zaloContacts", "search", Read, &[Global]),
    ("__zaloContacts", "watchGroupInvites", Read, &[Global]),
    ("__zaloContacts", "loadMoreGroupInvites", Read, &[Global]),
    ("__zaloContacts", "requestInfo", Read, &[Conv(0)]),
    ("__zaloContacts", "sendRequest", Write, &[Global]),
    ("__zaloContacts", "accept", Write, &[Global]),
    ("__zaloContacts", "decline", Write, &[Global]),
    ("__zaloContacts", "cancel", Write, &[Global]),
    ("__zaloContacts", "dismissSuggestion", Write, &[Global]),
    ("__zaloContacts", "acceptGroupInvite", Write, &[Global]),
    ("__zaloContacts", "declineGroupInvite", Write, &[Global]),
    ("__zaloContacts", "block", Write, &[Conv(0)]),
    // poll-adapter.js
    ("__zaloPoll", "watch", Read, &[PollIn(1, 0)]),
    ("__zaloPoll", "refresh", Read, &[Poll(0)]),
    ("__zaloPoll", "voters", Read, &[Poll(0)]),
    ("__zaloPoll", "capabilities", Read, &[Conv(0)]),
    ("__zaloPoll", "pinState", Read, &[PollIn(0, 1)]),
    ("__zaloPoll", "vote", Write, &[PollIn(0, 1)]),
    ("__zaloPoll", "lock", Write, &[PollIn(0, 1)]),
    ("__zaloPoll", "share", Write, &[PollIn(0, 1)]),
    ("__zaloPoll", "pin", Write, &[PollIn(0, 1)]),
    ("__zaloPoll", "unpin", Write, &[PollIn(0, 1)]),
    ("__zaloPoll", "create", Write, &[Conv(0)]),
    ("__zaloPoll", "reset", Denied, &[]),
    // sticker-adapter.js
    ("__zaloSticker", "categories", Read, &[]),
    ("__zaloSticker", "category", Read, &[]),
    ("__zaloSticker", "search", Read, &[]),
    ("__zaloSticker", "suggestSetting", Read, &[]),
    ("__zaloSticker", "suggest", Read, &[Conv(0)]),
    ("__zaloSticker", "send", Write, &[Conv(0)]),
    ("__zaloSticker", "setSuggestSetting", Write, &[Global]),
    ("__zaloSticker", "reset", Denied, &[]),
    // zcloud-adapter.js (storage of the whole account)
    ("__zaloCloud", "refresh", Read, &[Global]),
    ("__zaloCloud", "list", Read, &[Global]),
    ("__zaloCloud", "thumb", Read, &[Global]),
    ("__zaloCloud", "fetch", Read, &[Global]),
    ("__zaloCloud", "deleteItems", Write, &[Global]),
    ("__zaloCloud", "setOffload", Write, &[Global]),
    // transfer-adapter.js (message sync of the account with the phone)
    ("__zaloTransfer", "availability", Read, &[]),
    ("__zaloTransfer", "state", Read, &[]),
    ("__zaloTransfer", "respond", Write, &[Global]),
    ("__zaloTransfer", "dismiss", Write, &[Global]),
    ("__zaloTransfer", "start", Write, &[Global]),
    // media-store-adapter.js
    ("__zaloMediaStore", "page", Read, &[Conv(0)]),
    ("__zaloMediaStore", "item", Read, &[Msg(0, 1)]),
    // notification-adapter.js (permission / defaults are the host's own notifications)
    ("__zaloNotification", "refresh", Read, &[]),
    ("__zaloNotification", "activity", Read, &[]),
    ("__zaloNotification", "mute", Write, &[Conv(0)]),
    ("__zaloNotification", "unmute", Write, &[Conv(0)]),
    ("__zaloNotification", "setEnabled", Write, &[Global]),
    ("__zaloNotification", "setSound", Write, &[Global]),
    ("__zaloNotification", "setPermission", Denied, &[]),
    ("__zaloNotification", "permissionResult", Denied, &[]),
    ("__zaloNotification", "reconcileDefaults", Denied, &[]),
    // group-create-adapter.js (`groupId` is the group's conversation id)
    ("__zaloGroupCreate", "info", Read, &[Global]),
    ("__zaloGroupCreate", "create", Write, &[Global]),
    ("__zaloGroupCreate", "members", Read, &[Conv(0)]),
    ("__zaloGroupCreate", "removeMember", Write, &[Conv(0)]),
];

fn rule(target: &str, method: &str) -> Option<(Op, &'static [Need])> {
    RULES.iter().find(|(t, m, _, _)| *t == target && *m == method).map(|(_, _, op, needs)| (*op, *needs))
}

fn arg(args: &[Value], i: usize) -> Option<String> {
    id_of(args.get(i))
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// One requirement for a scoped (not `all`) user.
fn need_holds(access: &Access, mirror: &Mirror, need: Need, args: &[Value]) -> Result<(), &'static str> {
    let conv = |i: usize| match arg(args, i) {
        Some(c) if mirror.visible(&access.scope, &c) => Ok(()),
        _ => Err(DENIED_CONVERSATION),
    };
    let known = |c: Option<&String>| match c {
        Some(c) if mirror.visible(&access.scope, c) => Ok(()),
        _ => Err(DENIED_CONVERSATION),
    };
    match need {
        Conv(i) => conv(i),
        ConvOrNull(i) => match args.get(i) {
            None | Some(Value::Null) => Ok(()),
            Some(_) => conv(i),
        },
        Convs(i) => {
            let Some(list) = args.get(i).and_then(Value::as_array) else { return Err(DENIED_CONVERSATION) };
            if list.iter().all(|c| id_of(Some(c)).is_some_and(|c| mirror.visible(&access.scope, &c))) { Ok(()) } else { Err(DENIED_CONVERSATION) }
        }
        Msg(c, m) => {
            conv(c)?;
            match arg(args, m).and_then(|id| mirror.messages.get(&id)) {
                Some(owner) => known(Some(owner)),
                None => Ok(()),
            }
        }
        Person(i) => match arg(args, i) {
            Some(uid) if mirror.sees_person(access, &uid) => Ok(()),
            _ => Err(DENIED_CONVERSATION),
        },
        Poll(i) => known(arg(args, i).and_then(|p| mirror.polls.get(&p))),
        PollIn(c, p) => {
            conv(c)?;
            known(arg(args, p).and_then(|p| mirror.polls.get(&p)))
        }
        Confirm(i) => known(arg(args, i).and_then(|t| mirror.confirms.get(&t))),
        Undo(i) => known(arg(args, i).and_then(|u| mirror.undos.get(&u))),
        SelfIf(i) => {
            if truthy(args.get(i)) { known(Some(&mirror.self_conversation)) } else { Ok(()) }
        }
        Global => Err(DENIED_ACCOUNT_WIDE),
    }
}

fn check_adapter(access: &Access, mirror: &Mirror, target: &str, method: &str, args: &[Value]) -> Result<CallKind, String> {
    if target.starts_with("__zaloCall") {
        return Err(DENIED_CALLS.into());
    }
    let found = rule(target, method);
    if access.is_admin() {
        return Ok(match found {
            Some((Read, _)) => CallKind::Read,
            _ => CallKind::Write,
        });
    }
    if !TARGETS.contains(&target) || method.is_empty() || method.starts_with('_') {
        return Err(DENIED_UNKNOWN.into());
    }
    let Some((op, needs)) = found else {
        // Unknown method of a known adapter: only for agents with every conversation.
        return if access.scope.all && access.can_write() { Ok(CallKind::Write) } else { Err(DENIED_UNKNOWN.into()) };
    };
    let kind = match op {
        Denied => return Err(DENIED_REMOTE.into()),
        Read => CallKind::Read,
        Write if !access.can_write() => return Err(DENIED_VIEWER.into()),
        Write => CallKind::Write,
    };
    if !access.scope.all {
        for need in needs {
            need_holds(access, mirror, *need, args)?;
        }
    }
    Ok(kind)
}

/// Classify + authorize one invoke of a joined user. `cmd` is the WebSocket invoke command; `args` its args object
/// (for `engine_call`: `{target, method, args:[…]}`). Err(message in Vietnamese) when refused.
pub fn check_call(access: &Access, mirror: &Mirror, cmd: &str, args: &Value) -> Result<CallKind, String> {
    let scoped_conversation = |key: &str| -> Result<CallKind, String> {
        match args.get(key) {
            None | Some(Value::Null) => Ok(CallKind::Read),
            Some(Value::String(s)) if s.is_empty() => Ok(CallKind::Read),
            v if mirror.sees(access, &id_of(v).unwrap_or_default()) => Ok(CallKind::Read),
            _ => Err(DENIED_CONVERSATION.into()),
        }
    };
    match cmd {
        "engine_call" | "engine_call_with_files" => {
            let list = args.get("args").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
            check_adapter(access, mirror, str_of(args.get("target")), str_of(args.get("method")), list)
        }
        "engine_phase" | "engine_info" | "engine_replay" => Ok(CallKind::Read),
        // The host's own sign-in / runtime: agents with every conversation (and admins).
        "engine_refresh_qr" | "engine_retry_runtime" => {
            if !access.can_write() {
                Err(DENIED_VIEWER.into())
            } else if !access.sees_all() {
                Err(DENIED_ACCOUNT_WIDE.into())
            } else {
                Ok(CallKind::Write)
            }
        }
        // Results filtered by `filter_result`.
        "automation_search_status" | "automation_conversations" => Ok(CallKind::Read),
        "automation_messages" | "automation_search" => scoped_conversation("conversationId"),
        _ if access.is_admin() => Ok(CallKind::Write),
        _ if access.scope.all && access.can_write() => Ok(CallKind::Write),
        _ => Err(DENIED_UNKNOWN.into()),
    }
}

// ---- events ----

/// One UI event for one user: Some(possibly reduced payload) or None to drop.
pub fn filter_event(access: &Access, mirror: &Mirror, event: &str, payload: &Value) -> Option<Value> {
    if access.is_admin() {
        return Some(payload.clone());
    }
    match event {
        "compola://state" => filter_state(access, mirror, payload),
        "compola://phase" => Some(redact_phase(payload.clone())),
        "compola://page" => Some(payload.clone()),
        "compola://badge" => {
            if access.scope.all {
                Some(payload.clone())
            } else {
                mirror.unread_badge(&access.scope).map(Value::from)
            }
        }
        "compola://remote-notification" => {
            let tag = id_of(payload.get("tag")).unwrap_or_default();
            mirror.visible(&access.scope, &tag).then(|| payload.clone())
        }
        _ if access.scope.all => Some(payload.clone()),
        _ => None,
    }
}

/// The login QR is the host's own sign-in: admins only (whoever scans it signs the host in to their account).
fn redact_phase(mut phase: Value) -> Value {
    if let Some(login) = phase.get_mut("login").and_then(Value::as_object_mut) {
        if login.contains_key("qr") {
            login.insert("qr".into(), Value::Null);
        }
    }
    phase
}

fn filter_state(access: &Access, mirror: &Mirror, payload: &Value) -> Option<Value> {
    let o = payload.as_object()?;
    if o.get("page").and_then(Value::as_str) != Some("main") {
        // Login page snapshots: no QR for joined users.
        let mut copy = o.clone();
        if copy.contains_key("qr") {
            copy.insert("qr".into(), Value::Null);
        }
        return Some(Value::Object(copy));
    }
    if access.scope.all {
        return Some(payload.clone());
    }
    let scope = &access.scope;
    let vis = |id: &str| mirror.visible(scope, id);
    let mut out = Map::new();
    out.insert("page".into(), Value::from("main"));
    let mut kept = false;
    for (key, value) in o {
        let filtered = match key.as_str() {
            "page" | "removed" | "reset" => continue,
            "user" => Some(value.clone()),
            "conversations" => {
                let (rows, removed, reset) = filter_conversations(mirror, scope, o, value);
                if rows.is_empty() && removed.is_empty() && !reset {
                    None
                } else {
                    out.insert("removed".into(), Value::Array(removed));
                    out.insert("reset".into(), Value::Bool(reset));
                    Some(Value::Array(rows))
                }
            }
            "conversationExtras" => Some(filter_extras(mirror, scope, value)),
            "convActions" => Some(filter_conv_actions(mirror, scope, value)),
            "chat" | "typing" | "compose" | "pins" => vis(&id_of(value.get("convId")).unwrap_or_default()).then(|| value.clone()),
            "poll" => poll_visible(mirror, scope, value).then(|| value.clone()),
            "contacts" => filter_contacts(mirror, scope, value),
            "notification" => filter_notification(mirror, scope, value),
            // call, transfer, transferAvailable, zcloud and anything unknown: not for scoped users.
            _ => None,
        };
        if let Some(v) = filtered {
            out.insert(key.clone(), v);
            kept = true;
        }
    }
    kept.then_some(Value::Object(out))
}

fn ids_in(v: Option<&Value>, keep: impl Fn(&str) -> bool) -> Vec<Value> {
    v.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|x| id_of(Some(*x)).is_some_and(|id| keep(&id)))
        .cloned()
        .collect()
}

fn filter_conversations(mirror: &Mirror, scope: &Scope, o: &Map<String, Value>, rows: &Value) -> (Vec<Value>, Vec<Value>, bool) {
    let reset = o.get("reset").and_then(Value::as_bool).unwrap_or(o.get("removed").is_none());
    let vis = |id: &str| mirror.visible(scope, id);
    let rows = rows.as_array().into_iter().flatten().filter(|r| id_of(r.get("id")).is_some_and(|id| vis(&id))).cloned().collect();
    (rows, ids_in(o.get("removed"), vis), reset)
}

fn filter_extras(mirror: &Mirror, scope: &Scope, x: &Value) -> Value {
    let vis = |id: &str| mirror.visible(scope, id);
    let mut out = Map::new();
    for key in ["limits", "archivedEnabled", "filter", "unboxStranger", "epoch"] {
        if let Some(v) = x.get(key) {
            out.insert(key.into(), v.clone());
        }
    }
    let own = str_of(x.get("selfConversationId"));
    out.insert("selfConversationId".into(), Value::from(if vis(own) { own } else { "" }));
    let labels: Vec<Value> = x
        .get("labels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|l| {
            let id = id_of(l.get("id"))?;
            let convs = ids_in(l.get("convIds"), vis);
            if !scope.labels.contains(&id) && convs.is_empty() {
                return None;
            }
            let mut l = l.as_object()?.clone();
            l.insert("convIds".into(), Value::Array(convs));
            Some(Value::Object(l))
        })
        .collect();
    // The (shared) list filter names only labels this user knows.
    if let Some(ids) = out.get_mut("filter").and_then(|f| f.get_mut("labelIds")).and_then(Value::as_array_mut) {
        ids.retain(|id| labels.iter().any(|l| l.get("id") == Some(id)));
    }
    out.insert("labels".into(), Value::Array(labels));
    for key in ["listIds", "strangerIds", "strangerFolderIds"] {
        if x.get(key).is_some() {
            out.insert(key.into(), Value::Array(ids_in(x.get(key), vis)));
        }
    }
    if let Some(bx) = x.get("strangerBox") {
        let folder: Vec<String> = ids_in(x.get("strangerFolderIds"), vis).iter().filter_map(|v| id_of(Some(v))).collect();
        let newest = str_of(bx.get("newestId"));
        out.insert(
            "strangerBox".into(),
            json!({
                "chats": folder.len(),
                "unreadChats": folder.iter().filter(|id| mirror.unread(id) > 0).count(),
                "unreadMessages": folder.iter().map(|id| mirror.unread(id)).sum::<i64>(),
                "newestId": if vis(newest) { newest } else { "" },
            }),
        );
    }
    out.insert("action".into(), Value::Null);
    Value::Object(out)
}

fn filter_keyed(v: Option<&Value>, keep: impl Fn(&str) -> bool) -> Value {
    let map: Map<String, Value> =
        v.and_then(Value::as_object).into_iter().flatten().filter(|(k, _)| keep(k)).map(|(k, v)| (k.clone(), v.clone())).collect();
    Value::Object(map)
}

fn filter_conv_actions(mirror: &Mirror, scope: &Scope, x: &Value) -> Value {
    let vis = |id: &str| mirror.visible(scope, id);
    let mut out = Map::new();
    for key in ["epoch", "markUnread"] {
        if let Some(v) = x.get(key) {
            out.insert(key.into(), v.clone());
        }
    }
    for key in ["flags", "left"] {
        if x.get(key).is_some() {
            out.insert(key.into(), filter_keyed(x.get(key), vis));
        }
    }
    if let Some(h) = x.get("hidden") {
        out.insert(
            "hidden".into(),
            json!({
                "enabled": h.get("enabled").cloned().unwrap_or(Value::Bool(false)),
                "hasPin": h.get("hasPin").cloned().unwrap_or(Value::Bool(false)),
                "ids": ids_in(h.get("ids"), vis),
            }),
        );
    }
    if let Some(late) = x.get("late").filter(|l| vis(str_of(l.get("removedId")))) {
        out.insert("late".into(), late.clone());
    }
    Value::Object(out)
}

/// Every conversation known for the poll (chat messages, its detail) is visible, and there is one.
fn poll_visible(mirror: &Mirror, scope: &Scope, poll: &Value) -> bool {
    let id = id_of(poll.get("id")).unwrap_or_default();
    let convs = [mirror.polls.get(&id).cloned(), poll.get("detail").and_then(|d| id_of(d.get("groupId")))];
    let known: Vec<String> = convs.into_iter().flatten().collect();
    !known.is_empty() && known.iter().all(|c| mirror.visible(scope, c))
}

fn filter_contacts(mirror: &Mirror, scope: &Scope, x: &Value) -> Option<Value> {
    let vis = |id: &str| mirror.visible(scope, id);
    let mut out = Map::new();
    for key in ["friends", "groups"] {
        if let Some(list) = x.get(key).and_then(Value::as_array) {
            let kept: Vec<Value> = list.iter().filter(|r| id_of(r.get("id")).is_some_and(|id| vis(&id))).cloned().collect();
            out.insert(key.into(), Value::Array(kept));
        }
    }
    if let Some(v) = x.get("loading") {
        out.insert("loading".into(), v.clone());
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

fn filter_notification(mirror: &Mirror, scope: &Scope, x: &Value) -> Option<Value> {
    match str_of(x.get("kind")) {
        "ready" => Some(x.clone()),
        "settings" => {
            let mut out = x.as_object()?.clone();
            let mutes: Vec<Value> = x
                .get("mutes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|m| id_of(m.get("id")).is_some_and(|id| mirror.visible(scope, &id)))
                .cloned()
                .collect();
            out.insert("mutes".into(), Value::Array(mutes));
            Some(Value::Object(out))
        }
        _ => None,
    }
}

// ---- results ----

/// Results of read calls that list / search across conversations (conversation lists, search hits, pinned
/// conversations, replay, …), reduced to what the user may see.
pub fn filter_result(access: &Access, mirror: &Mirror, cmd: &str, args: &Value, result: Value) -> Value {
    if access.is_admin() {
        return result;
    }
    let scope = &access.scope;
    let vis = |id: &str| mirror.visible(scope, id);
    let by_conversation = |list: Value, key: &str| -> Value {
        match list {
            Value::Array(items) => {
                Value::Array(items.into_iter().filter(|m| id_of(m.get(key)).is_some_and(|id| vis(&id))).collect())
            }
            _ => Value::Array(Vec::new()),
        }
    };
    match cmd {
        "engine_phase" => redact_phase(result),
        "engine_info" => {
            let mut result = result;
            if let Some(o) = result.as_object_mut() {
                o.insert("recentLog".into(), Value::Array(Vec::new()));
            }
            result
        }
        "engine_replay" => match result {
            Value::Array(events) => {
                Value::Array(events.iter().filter_map(|e| filter_event(access, mirror, "compola://state", e)).collect())
            }
            _ => Value::Array(Vec::new()),
        },
        "automation_search_status" => {
            let mut result = result;
            if let Some(o) = result.as_object_mut() {
                if let Some(cfg) = o.get_mut("config").and_then(Value::as_object_mut) {
                    cfg.insert("apiKey".into(), Value::from(""));
                }
                o.insert("path".into(), Value::from(""));
                if !scope.all {
                    o.insert("stats".into(), Value::Null);
                }
            }
            result
        }
        _ if scope.all => result,
        "automation_conversations" => by_conversation(result, "id"),
        "automation_messages" => by_conversation(result, "conversationId"),
        "automation_search" => {
            let mut result = result;
            if let Some(o) = result.as_object_mut() {
                let hits = o.remove("hits").unwrap_or(Value::Null);
                o.insert("hits".into(), by_conversation(hits, "conversationId"));
            }
            result
        }
        "engine_call" | "engine_call_with_files" => match (str_of(args.get("target")), str_of(args.get("method"))) {
            ("__zaloConvActions", "pinBoard") => {
                let mut result = result;
                if let Some(o) = result.as_object_mut() {
                    let items = ids_in(o.get("items"), vis);
                    o.insert("items".into(), Value::Array(items));
                }
                result
            }
            _ => result,
        },
        _ => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "1000";
    const AN: &str = "2001"; // 1:1, listed in the scope
    const BINH: &str = "2002"; // 1:1, invisible
    const SALES: &str = "g3001"; // group, invisible
    const VIP: &str = "g3002"; // group, label "Khách VIP" (in scope)
    const CLOUD: &str = "3999"; // My Cloud
    const LABEL_VIP: &str = "1";
    const LABEL_OTHER: &str = "2";

    fn access(role: Role, all: bool) -> Access {
        Access { role, scope: Scope { all, conversations: vec![AN.into()], labels: vec![LABEL_VIP.into()] } }
    }
    fn scoped_agent() -> Access {
        access(Role::Agent, false)
    }
    fn all_agent() -> Access {
        access(Role::Agent, true)
    }
    fn all_viewer() -> Access {
        access(Role::Viewer, true)
    }
    fn admin() -> Access {
        Access { role: Role::Admin, scope: Scope::default() }
    }

    fn row(id: &str, name: &str, group: bool, unread: i64, text: &str) -> Value {
        json!({
            "id": id, "isGroup": group, "name": name, "avatar": format!("https://s120-ava-talk.zadn.vn/{id}.jpg"),
            "pinned": false, "members": if group { 12 } else { 0 }, "unread": unread,
            "preview": { "text": text, "ts": 1_763_000_000_000i64, "fromMe": false, "type": 1 },
        })
    }

    fn conversations_reset() -> Value {
        json!({
            "page": "main",
            "conversations": [
                row(AN, "An Nguyễn", false, 2, "Hẹn gặp lúc 3 giờ"),
                row(BINH, "Bình Trần", false, 5, "Lương tháng này"),
                row(SALES, "Nhóm Sales nội bộ", true, 1, "Doanh số quý"),
                row(VIP, "Khách VIP Hà Nội", true, 0, "Cảm ơn anh"),
                row(CLOUD, "Cloud của tôi", false, 0, "[Tệp]"),
            ],
            "removed": [],
            "reset": true,
        })
    }

    fn extras() -> Value {
        json!({
            "page": "main",
            "conversationExtras": {
                "selfConversationId": CLOUD,
                "limits": { "maxLabels": 15, "maxNameLength": 30, "minNameLength": 1, "palette": ["#D91B1B"] },
                "labels": [
                    { "id": LABEL_VIP, "name": "Khách VIP", "color": "#D91B1B", "emoji": "", "convIds": [VIP] },
                    { "id": LABEL_OTHER, "name": "Nội bộ", "color": "#0068FF", "emoji": "", "convIds": [SALES, BINH] },
                ],
                "archivedEnabled": true,
                "filter": { "type": 0, "labelIds": [] },
                "listIds": [AN, BINH, SALES, VIP, CLOUD],
                "strangerIds": [BINH, "2050"],
                "strangerFolderIds": [BINH, "2050"],
                "strangerBox": { "chats": 2, "unreadChats": 1, "unreadMessages": 5, "newestId": BINH },
                "unboxStranger": false,
                "action": { "seq": 3, "ok": true, "text": "Đã tạo phân loại" },
            }
        })
    }

    fn chat(conv: &str, messages: Value) -> Value {
        json!({ "page": "main", "chat": { "convId": conv, "messages": messages, "removed": [], "hasMore": true, "reset": true } })
    }

    fn message(conv: &str, id: &str, sender: &str, text: &str) -> Value {
        json!({
            "id": id, "conversationId": conv, "senderId": sender, "senderName": "Ai đó", "senderAvatar": "", "isMine": false,
            "text": text, "date": 1_763_000_000_000i64, "status": "sent", "kind": { "type": "text" }, "quote": null,
            "reactions": [], "mentions": [], "isE2EE": false, "menu": null,
        })
    }

    fn mirror() -> Mirror {
        let mut m = Mirror::default();
        m.observe(&json!({ "page": "main", "user": { "userId": ME, "displayName": "Tôi", "zaloName": "Tôi", "avatar": "", "phoneNumber": "" } }));
        m.observe(&conversations_reset());
        m.observe(&extras());
        m.observe(&chat(AN, json!([message(AN, "m-an-1", AN, "Chào bạn")])));
        m.observe(&chat(BINH, json!([message(BINH, "m-binh-1", BINH, "Bí mật")])));
        let mut poll = message(VIP, "m-vip-poll", "2100", "[Bình chọn] Chọn ngày họp");
        poll["kind"] = json!({ "type": "poll", "question": "Chọn ngày họp", "header": "", "anonymous": false, "pollId": "p-vip", "conversationId": VIP });
        let mut card = message(VIP, "m-vip-card", "2100", "[Danh thiếp] Chị Lan");
        card["kind"] = json!({ "type": "contactCard", "name": "Chị Lan", "uid": "2200", "avatar": "", "phone": "", "qr": "", "oaLink": "", "isOA": false });
        m.observe(&chat(VIP, json!([poll, card])));
        let mut secret_poll = message(SALES, "m-sales-poll", "2101", "[Bình chọn] Thưởng");
        secret_poll["kind"] = json!({ "type": "poll", "pollId": "p-sales", "conversationId": SALES });
        m.observe(&chat(SALES, json!([secret_poll])));
        m
    }

    fn call(target: &str, method: &str, args: Value) -> Value {
        json!({ "target": target, "method": method, "args": args })
    }

    fn check(access: &Access, mirror: &Mirror, target: &str, method: &str, args: Value) -> Result<CallKind, String> {
        check_call(access, mirror, "engine_call", &call(target, method, args))
    }

    fn state(access: &Access, mirror: &Mirror, payload: &Value) -> Option<Value> {
        filter_event(access, mirror, "compola://state", payload)
    }

    #[test]
    fn access_json_shape() {
        let a: Access = serde_json::from_value(json!({ "role": "agent", "scope": { "all": false, "conversations": ["1"], "labels": ["2"] } })).unwrap();
        assert_eq!(a, Access { role: Role::Agent, scope: Scope { all: false, conversations: vec!["1".into()], labels: vec!["2".into()] } });
        let partial: Access = serde_json::from_value(json!({ "role": "viewer", "scope": { "all": true } })).unwrap();
        assert!(partial.scope.all && partial.scope.conversations.is_empty());
        assert_eq!(serde_json::to_value(Role::Admin).unwrap(), json!("admin"));
        assert!(Role::Viewer < Role::Agent && Role::Agent < Role::Admin);
    }

    #[test]
    fn visibility_by_list_and_label() {
        let m = mirror();
        let s = scoped_agent().scope;
        assert!(m.visible(&s, AN));
        assert!(m.visible(&s, VIP), "carries a label of the scope");
        assert!(!m.visible(&s, BINH));
        assert!(!m.visible(&s, SALES));
        assert!(!m.visible(&s, ""));
        assert!(m.visible(&Scope { all: true, ..Default::default() }, BINH));
    }

    #[test]
    fn label_changes_move_visibility() {
        let mut m = mirror();
        let s = scoped_agent().scope;
        let g = m.generation();
        let mut x = extras();
        x["conversationExtras"]["labels"][0]["convIds"] = json!([VIP, SALES]);
        m.observe(&x);
        assert!(m.visible(&s, SALES));
        assert!(m.generation() > g);
        let g = m.generation();
        m.observe(&x); // same labels: nothing changes
        assert_eq!(m.generation(), g);
        x["conversationExtras"]["labels"][0]["convIds"] = json!([]);
        m.observe(&x);
        assert!(!m.visible(&s, VIP) && !m.visible(&s, SALES));
        // A fresh list for the session after the change.
        let snap = m.conversations_snapshot(&scoped_agent()).unwrap();
        let ids: Vec<&str> = snap["conversations"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec![AN]);
        assert_eq!(snap["reset"], json!(true));
    }

    #[test]
    fn viewer_cannot_send() {
        let m = mirror();
        let v = all_viewer();
        assert_eq!(check(&v, &m, "__zaloChat", "open", json!([BINH])), Ok(CallKind::Read));
        assert_eq!(check(&v, &m, "__zaloChat", "loadMore", json!([BINH])), Ok(CallKind::Read));
        assert_eq!(check(&v, &m, "__zaloChat", "resolveMedia", json!([BINH, "m-binh-1", "photo"])), Ok(CallKind::Read));
        for (t, method, args) in [
            ("__zaloChat", "sendText", json!([AN, "xin chào", null, [], []])),
            ("__zaloChat", "react", json!([AN, "m-an-1", "❤️"])),
            ("__zaloChat", "markRead", json!([AN])),
            ("__zaloMsgActions", "recall", json!([AN, "m-an-1"])),
            ("__zaloConvActions", "pin", json!([AN])),
            ("__zaloCompose", "sendFiles", json!([AN])),
            ("__zaloSticker", "send", json!([AN, { "cateId": 1, "id": 2 }, "category", {}])),
            ("__zaloPoll", "vote", json!([VIP, "p-vip", [], ["1"]])),
            ("__zaloContacts", "accept", json!(["2300"])),
            ("__zaloGroupCreate", "create", json!([{ "name": "x", "members": ["1", "2"], "avatar": null }])),
        ] {
            assert_eq!(check(&v, &m, t, method, args), Err(DENIED_VIEWER.into()), "{t}.{method}");
        }
        let files = json!({ "target": "__zaloCompose", "method": "sendMedia", "args": [AN], "files": ["0123456789abcdef0123456789abcdef/a.png"] });
        assert_eq!(check_call(&v, &m, "engine_call_with_files", &files), Err(DENIED_VIEWER.into()));
        assert!(check_call(&v, &m, "engine_refresh_qr", &json!({})).is_err());
        assert!(check_call(&v, &m, "engine_replay", &json!({})).is_ok());
    }

    #[test]
    fn scoped_agent_stays_in_scope() {
        let m = mirror();
        let a = scoped_agent();
        assert_eq!(check(&a, &m, "__zaloChat", "open", json!([AN])), Ok(CallKind::Read));
        assert_eq!(check(&a, &m, "__zaloChat", "sendText", json!([AN, "chào", null, [], []])), Ok(CallKind::Write));
        assert_eq!(check(&a, &m, "__zaloChat", "sendText", json!([VIP, "chào cả nhóm", null, [], []])), Ok(CallKind::Write));
        assert_eq!(check(&a, &m, "__zaloChat", "open", json!([BINH])), Err(DENIED_CONVERSATION.into()));
        assert_eq!(check(&a, &m, "__zaloChat", "sendText", json!([SALES, "x", null, [], []])), Err(DENIED_CONVERSATION.into()));
        assert_eq!(check(&a, &m, "__zaloChat", "open", json!([])), Err(DENIED_CONVERSATION.into()));
        assert_eq!(check(&a, &m, "__zaloChat", "open", json!([null])), Err(DENIED_CONVERSATION.into()));
        // A message of an invisible conversation, named with a visible one.
        assert_eq!(check(&a, &m, "__zaloChat", "react", json!([AN, "m-binh-1", "👍"])), Err(DENIED_CONVERSATION.into()));
        assert_eq!(check(&a, &m, "__zaloChat", "resolveMedia", json!([AN, "m-binh-1", "photo"])), Err(DENIED_CONVERSATION.into()));
        assert_eq!(check(&a, &m, "__zaloChat", "sendText", json!([AN, "trích", "m-binh-1", [], []])), Err(DENIED_CONVERSATION.into()));
        assert_eq!(check(&a, &m, "__zaloChat", "react", json!([AN, "m-an-1", "👍"])), Ok(CallKind::Write));
        // Forward: every target must be visible.
        assert!(check(&a, &m, "__zaloMsgActions", "forward", json!([AN, "m-an-1", [VIP]])).is_ok());
        assert!(check(&a, &m, "__zaloMsgActions", "forward", json!([AN, "m-an-1", [VIP, BINH]])).is_err());
        assert!(check(&a, &m, "__zaloCompose", "shareShot", json!([[AN, SALES]])).is_err());
        // Screenshot to My Cloud: My Cloud is not in the scope.
        assert!(check(&a, &m, "__zaloCompose", "sendShot", json!([AN, false])).is_ok());
        assert!(check(&a, &m, "__zaloCompose", "sendShot", json!([AN, true])).is_err());
        // Pins watch: null = stop watching.
        assert!(check(&a, &m, "__zaloMsgActions", "watchPins", json!([null])).is_ok());
        assert!(check(&a, &m, "__zaloMsgActions", "watchPins", json!([BINH])).is_err());
        // Conversation menu and members.
        assert!(check(&a, &m, "__zaloConvActions", "pinReplacing", json!([[SALES], AN])).is_err());
        assert!(check(&a, &m, "__zaloConvActions", "pinReplacing", json!([[VIP], AN])).is_ok());
        assert!(check(&a, &m, "__zaloGroupCreate", "members", json!([VIP])).is_ok());
        assert!(check(&a, &m, "__zaloGroupCreate", "removeMember", json!([SALES, "2101", false])).is_err());
        assert!(check(&a, &m, "__zaloMediaStore", "page", json!([BINH, "images", null, 30])).is_err());
        assert!(check(&a, &m, "__zaloNotification", "mute", json!([BINH, 1])).is_err());
        // Numeric ids are compared as strings.
        assert!(check(&a, &m, "__zaloChat", "open", json!([2001])).is_ok());
    }

    #[test]
    fn account_wide_features_need_all_scope() {
        let m = mirror();
        let a = scoped_agent();
        for (t, method, args) in [
            ("__zaloContacts", "search", json!(["0901234567", "VN"])),
            ("__zaloContacts", "sendRequest", json!(["2300", "Chào bạn"])),
            ("__zaloContacts", "watchGroupInvites", json!([true])),
            ("__zaloGroupCreate", "create", json!([{ "name": "x", "members": ["1", "2"], "avatar": null }])),
            ("__zaloGroupCreate", "info", json!([])),
            ("__zaloChat", "groupJoin", json!(["https://zalo.me/g/abc"])),
            ("__zaloChat", "prepareFriendRequest", json!([AN, AN, "add"])),
            ("__zaloConversations", "createLabel", json!(["Mới", "#D91B1B", []])),
            ("__zaloConversations", "setConvLabel", json!([AN, LABEL_VIP])),
            ("__zaloConvActions", "hiddenSearch", json!(["1234"])),
            ("__zaloConvActions", "hide", json!([AN, "1234"])),
            ("__zaloCloud", "list", json!([{ "convId": AN, "kind": "media" }])),
            ("__zaloTransfer", "start", json!([])),
            ("__zaloSticker", "setSuggestSetting", json!([false])),
        ] {
            assert_eq!(check(&a, &m, t, method, args.clone()), Err(DENIED_ACCOUNT_WIDE.into()), "{t}.{method}");
            assert!(check(&all_agent(), &m, t, method, args).is_ok(), "{t}.{method} for an all-scope agent");
        }
        assert!(check_call(&a, &m, "engine_refresh_qr", &json!({})).is_err());
        assert!(check_call(&all_agent(), &m, "engine_refresh_qr", &json!({})).is_ok());
        // Contacts list itself: allowed, the snapshot is filtered.
        assert_eq!(check(&a, &m, "__zaloContacts", "refresh", json!([])), Ok(CallKind::Read));
    }

    #[test]
    fn people_in_reach() {
        let mut m = mirror();
        let a = scoped_agent();
        assert!(check(&a, &m, "__zaloChat", "contactProfile", json!([AN])).is_ok(), "the other side of a visible 1:1");
        assert!(check(&a, &m, "__zaloChat", "contactProfile", json!(["2200"])).is_ok(), "contact card in a visible group");
        assert!(check(&a, &m, "__zaloChat", "contactProfile", json!(["2100"])).is_ok(), "sender in a visible group");
        assert!(check(&a, &m, "__zaloChat", "contactProfile", json!([ME])).is_ok());
        assert!(check(&a, &m, "__zaloChat", "contactProfile", json!([BINH])).is_err());
        assert!(check(&a, &m, "__zaloChat", "contactState", json!(["2101"])).is_err(), "seen only in an invisible group");
        // Group members learned from a members answer.
        assert!(check(&a, &m, "__zaloChat", "contactProfile", json!(["2400"])).is_err());
        let args = call("__zaloGroupCreate", "members", json!([VIP]));
        m.observe_result("engine_call", &args, &json!({ "status": "ok", "groupId": VIP, "members": [{ "id": "2400", "name": "Hùng" }] }));
        assert!(check(&a, &m, "__zaloChat", "contactProfile", json!(["2400"])).is_ok());
    }

    #[test]
    fn polls_tokens_and_undo_need_a_known_conversation() {
        let mut m = mirror();
        let a = scoped_agent();
        assert!(check(&a, &m, "__zaloPoll", "refresh", json!(["p-vip", false])).is_ok());
        assert!(check(&a, &m, "__zaloPoll", "voters", json!(["p-sales"])).is_err());
        assert!(check(&a, &m, "__zaloPoll", "voters", json!(["p-unknown"])).is_err());
        assert!(check(&a, &m, "__zaloPoll", "watch", json!(["p-vip", VIP])).is_ok());
        // A poll of an invisible group, named with a visible one.
        assert!(check(&a, &m, "__zaloPoll", "watch", json!(["p-sales", VIP])).is_err());
        assert!(check(&a, &m, "__zaloPoll", "vote", json!([VIP, "p-sales", [], ["1"]])).is_err());
        assert!(check(&a, &m, "__zaloPoll", "vote", json!([VIP, "p-vip", [], ["1"]])).is_ok());

        // Composer confirm tokens.
        assert!(check(&a, &m, "__zaloCompose", "answer", json!(["ab12cd-1", true])).is_err());
        m.observe(&json!({ "page": "main", "compose": { "kind": "confirm", "token": "ab12cd-1", "convId": AN, "title": "Gửi dưới dạng file?", "message": "", "ok": "Gửi", "cancel": "Hủy" } }));
        m.observe(&json!({ "page": "main", "compose": { "kind": "confirm", "token": "ab12cd-2", "convId": BINH, "title": "Gửi dưới dạng file?", "message": "", "ok": "Gửi", "cancel": "Hủy" } }));
        assert!(check(&a, &m, "__zaloCompose", "answer", json!(["ab12cd-1", true])).is_ok());
        assert!(check(&a, &m, "__zaloCompose", "answer", json!(["ab12cd-2", true])).is_err());

        // Undo of "delete for me".
        assert!(check(&a, &m, "__zaloMsgActions", "undoDelete", json!(["7"])).is_err());
        let del = call("__zaloMsgActions", "deleteForMe", json!([AN, "m-an-1", true]));
        m.observe_result("engine_call", &del, &json!({ "status": "done", "undo": { "id": "7", "count": 1, "ms": 5000 } }));
        let del = call("__zaloMsgActions", "deleteForMe", json!([BINH, "m-binh-1", true]));
        m.observe_result("engine_call", &del, &json!({ "status": "done", "undo": { "id": "8", "count": 1, "ms": 5000 } }));
        assert!(check(&a, &m, "__zaloMsgActions", "undoDelete", json!(["7"])).is_ok());
        assert!(check(&a, &m, "__zaloMsgActions", "commitDelete", json!(["8"])).is_err());
        // An all-scope agent needs none of that.
        assert!(check(&all_agent(), &m, "__zaloMsgActions", "commitDelete", json!(["99"])).is_ok());
    }

    #[test]
    fn unknown_methods_and_targets() {
        let m = mirror();
        // Unknown method of a known adapter.
        assert_eq!(check(&scoped_agent(), &m, "__zaloChat", "newThing", json!([AN])), Err(DENIED_UNKNOWN.into()));
        assert_eq!(check(&all_viewer(), &m, "__zaloChat", "newThing", json!([AN])), Err(DENIED_UNKNOWN.into()));
        assert_eq!(check(&all_agent(), &m, "__zaloChat", "newThing", json!([AN])), Ok(CallKind::Write));
        // Renderer internals and private members: never for joined users.
        for (t, method) in [("__zaloStore", "dispatch"), ("__zaloNet", "status"), ("__zaloLocal", "get"), ("__zaloLoginAction", "call"), ("__zaloCompose", "__scope"), ("", "open")] {
            assert_eq!(check(&all_agent(), &m, t, method, json!([])), Err(DENIED_UNKNOWN.into()), "{t}.{method}");
        }
        // Host lifecycle / host-local settings.
        assert_eq!(check(&all_agent(), &m, "__zaloNotification", "setPermission", json!(["denied"])), Err(DENIED_REMOTE.into()));
        assert_eq!(check(&all_agent(), &m, "__zaloChat", "cardReset", json!([])), Err(DENIED_REMOTE.into()));
        // Calls: refused for everyone.
        assert_eq!(check(&admin(), &m, "__zaloCall", "start", json!(["2001", false, 1])), Err(DENIED_CALLS.into()));
        assert_eq!(check(&all_agent(), &m, "__zaloCall", "refresh", json!([])), Err(DENIED_CALLS.into()));
        // Unknown commands.
        assert!(check_call(&scoped_agent(), &m, "engine_eval", &json!({ "js": "1" })).is_err());
        assert!(check_call(&all_viewer(), &m, "engine_eval", &json!({ "js": "1" })).is_err());
    }

    #[test]
    fn admin_unaffected() {
        let m = mirror();
        let a = admin();
        assert_eq!(check(&a, &m, "__zaloChat", "sendText", json!([BINH, "x"])), Ok(CallKind::Write));
        assert_eq!(check(&a, &m, "__zaloChat", "open", json!([SALES])), Ok(CallKind::Read));
        assert_eq!(check(&a, &m, "__zaloStore", "dispatch", json!([{}])), Ok(CallKind::Write));
        assert_eq!(check(&a, &m, "__zaloNotification", "setPermission", json!(["granted"])), Ok(CallKind::Write));
        assert!(check_call(&a, &m, "engine_refresh_qr", &json!({})).is_ok());
        for payload in [conversations_reset(), extras(), chat(BINH, json!([message(BINH, "m2", BINH, "x")]))] {
            assert_eq!(state(&a, &m, &payload), Some(payload.clone()));
        }
        let n = json!({ "title": "Bình Trần", "body": "Lương", "tag": BINH, "silent": false, "image": null });
        assert_eq!(filter_event(&a, &m, "compola://remote-notification", &n), Some(n.clone()));
        assert_eq!(filter_event(&a, &m, "compola://badge", &json!(7)), Some(json!(7)));
        let phase = json!({ "kind": "login", "login": { "step": { "kind": "waitingScan" }, "qr": "data:image/png;base64,AAAA", "isSecondQr": false }, "notice": null });
        assert_eq!(filter_event(&a, &m, "compola://phase", &phase), Some(phase.clone()));
        let hits = json!({ "mode": "keyword", "hits": [{ "id": "m", "conversationId": BINH }], "semanticError": null });
        assert_eq!(filter_result(&a, &m, "automation_search", &json!({}), hits.clone()), hits);
    }

    #[test]
    fn conversation_list_is_filtered() {
        let m = mirror();
        let a = scoped_agent();
        let out = state(&a, &m, &conversations_reset()).unwrap();
        let ids: Vec<&str> = out["conversations"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec![AN, VIP]);
        assert_eq!(out["reset"], json!(true));
        // All-scope users get it unchanged.
        assert_eq!(state(&all_viewer(), &m, &conversations_reset()), Some(conversations_reset()));
    }

    #[test]
    fn deltas_of_invisible_conversations_never_leak() {
        let mut m = mirror();
        let a = scoped_agent();
        let delta = json!({ "page": "main", "conversations": [row(BINH, "Bình Trần", false, 6, "Mật khẩu wifi là 1234")], "removed": [], "reset": false });
        m.observe(&delta);
        assert_eq!(state(&a, &m, &delta), None);
        let removal = json!({ "page": "main", "conversations": [], "removed": [SALES], "reset": false });
        m.observe(&removal);
        assert_eq!(state(&a, &m, &removal), None);
        // Mixed delta: only the visible row, no trace of the other.
        let mixed = json!({ "page": "main", "conversations": [row(AN, "An Nguyễn", false, 3, "OK"), row(BINH, "Bình Trần", false, 7, "Mật khẩu wifi")], "removed": [SALES, VIP], "reset": false });
        m.observe(&mixed);
        let out = state(&a, &m, &mixed).unwrap();
        let text = out.to_string();
        assert!(!text.contains("Bình") && !text.contains(BINH) && !text.contains("wifi") && !text.contains(SALES), "{text}");
        assert_eq!(out["removed"], json!([VIP]));
        assert_eq!(out["conversations"].as_array().unwrap().len(), 1);
        // The mirror merged the deltas.
        assert_eq!(m.unread(AN), 3);
        assert!(!m.rows.contains_key(SALES));
    }

    #[test]
    fn chat_typing_pins_compose_of_invisible_conversations_dropped() {
        let m = mirror();
        let a = scoped_agent();
        let visible = chat(AN, json!([message(AN, "m-an-2", AN, "Chào")]));
        assert_eq!(state(&a, &m, &visible), Some(visible.clone()));
        let hidden = chat(BINH, json!([message(BINH, "m-binh-2", BINH, "Bí mật")]));
        assert_eq!(state(&a, &m, &hidden), None);
        let delta = json!({ "page": "main", "chat": { "convId": SALES, "messages": [], "removed": ["m-sales-poll"], "hasMore": false, "reset": false, "grew": false } });
        assert_eq!(state(&a, &m, &delta), None);
        assert_eq!(state(&a, &m, &json!({ "page": "main", "typing": { "convId": BINH, "name": "Bình" } })), None);
        assert!(state(&a, &m, &json!({ "page": "main", "typing": { "convId": VIP, "name": "Lan" } })).is_some());
        let pins = json!({ "page": "main", "pins": { "convId": SALES, "ready": true, "canPin": true, "items": [{ "ref": "message:1", "kind": "message", "title": "Lương", "sender": "Sếp", "thumb": "", "msgId": "1", "cliMsgId": "2" }] } });
        assert_eq!(state(&a, &m, &pins), None);
        let toast = json!({ "page": "main", "compose": { "kind": "toast", "convId": BINH, "text": "Đã gửi" } });
        assert_eq!(state(&a, &m, &toast), None);
        let toast = json!({ "page": "main", "compose": { "kind": "toast", "convId": "", "text": "Đã gửi" } });
        assert_eq!(state(&a, &m, &toast), None);
        // Unknown and account-wide kinds are dropped for scoped users, the profile passes.
        for p in [
            json!({ "page": "main", "zcloud": { "conversations": [{ "id": BINH, "name": "Bình" }] } }),
            json!({ "page": "main", "transfer": null }),
            json!({ "page": "main", "call": { "kind": "status", "conv": { "id": BINH, "can": true } } }),
            json!({ "page": "main", "somethingNew": { "secret": 1 } }),
        ] {
            assert_eq!(state(&a, &m, &p), None, "{p}");
            assert_eq!(state(&all_viewer(), &m, &p), Some(p.clone()));
        }
        let user = json!({ "page": "main", "user": { "userId": ME, "displayName": "Tôi" } });
        assert_eq!(state(&a, &m, &user), Some(user.clone()));
    }

    #[test]
    fn polls_follow_their_conversation() {
        let m = mirror();
        let a = scoped_agent();
        let detail = |id: &str, group: &str| json!({ "page": "main", "poll": { "id": id, "detail": { "id": id, "groupId": group, "question": "Thưởng tết", "options": [] } } });
        assert!(state(&a, &m, &detail("p-vip", VIP)).is_some());
        assert_eq!(state(&a, &m, &detail("p-sales", SALES)), None);
        // A watcher named a visible group for a poll of an invisible one.
        assert_eq!(state(&a, &m, &detail("p-sales", VIP)), None);
        // Error of an unknown poll: nothing tells where it belongs.
        assert_eq!(state(&a, &m, &json!({ "page": "main", "poll": { "id": "p-x", "error": "fetch" } })), None);
    }

    #[test]
    fn notifications_follow_their_conversation() {
        let m = mirror();
        let a = scoped_agent();
        let n = |tag: Value| json!({ "title": "Bình Trần", "body": "Lương tháng này", "tag": tag, "silent": false, "image": null });
        assert_eq!(filter_event(&a, &m, "compola://remote-notification", &n(json!(BINH))), None);
        assert_eq!(filter_event(&a, &m, "compola://remote-notification", &n(json!(null))), None);
        assert!(filter_event(&a, &m, "compola://remote-notification", &n(json!(AN))).is_some());
        assert!(filter_event(&a, &m, "compola://remote-notification", &n(json!(VIP))).is_some());
        assert!(filter_event(&all_viewer(), &m, "compola://remote-notification", &n(json!(BINH))).is_some());
        // Notification settings: mutes of visible conversations only.
        let settings = json!({ "page": "main", "notification": { "kind": "settings", "userId": ME, "enabled": true, "sound": true, "hasSoundSetting": true,
            "mutes": [{ "id": AN, "startTime": 1, "duration": -1 }, { "id": BINH, "startTime": 1, "duration": 3600 }] } });
        let out = state(&a, &m, &settings).unwrap();
        assert_eq!(out["notification"]["mutes"], json!([{ "id": AN, "startTime": 1, "duration": -1 }]));
        assert_eq!(state(&a, &m, &json!({ "page": "main", "notification": { "kind": "requestPermission" } })), None);
    }

    #[test]
    fn extras_and_conv_actions_are_reduced() {
        let m = mirror();
        let a = scoped_agent();
        let x = state(&a, &m, &extras()).unwrap()["conversationExtras"].clone();
        assert_eq!(x["listIds"], json!([AN, VIP]));
        assert_eq!(x["strangerIds"], json!([]));
        assert_eq!(x["strangerBox"], json!({ "chats": 0, "unreadChats": 0, "unreadMessages": 0, "newestId": "" }));
        assert_eq!(x["selfConversationId"], json!(""));
        assert_eq!(x["action"], Value::Null);
        assert_eq!(x["labels"], json!([{ "id": LABEL_VIP, "name": "Khách VIP", "color": "#D91B1B", "emoji": "", "convIds": [VIP] }]));
        assert!(!x.to_string().contains("Nội bộ"));
        assert_eq!(x["limits"]["maxLabels"], json!(15));
        let mut filtered = extras();
        filtered["conversationExtras"]["filter"]["labelIds"] = json!([LABEL_OTHER, LABEL_VIP]);
        let x = state(&a, &m, &filtered).unwrap()["conversationExtras"].clone();
        assert_eq!(x["filter"], json!({ "type": 0, "labelIds": [LABEL_VIP] }));

        let acts = json!({ "page": "main", "convActions": { "epoch": 1, "flags": { AN: 1, BINH: 4, SALES: 2 }, "left": { SALES: "kick" },
            "hidden": { "enabled": true, "hasPin": true, "ids": [BINH] }, "markUnread": true,
            "late": { "seq": 1, "ok": true, "text": "Đã xóa hội thoại", "neutral": false, "removedId": SALES } } });
        let out = state(&a, &m, &acts).unwrap()["convActions"].clone();
        assert_eq!(out, json!({ "epoch": 1, "markUnread": true, "flags": { AN: 1 }, "left": {}, "hidden": { "enabled": true, "hasPin": true, "ids": [] } }));
    }

    #[test]
    fn contacts_are_reduced_to_the_scope() {
        let m = mirror();
        let a = scoped_agent();
        let contacts = json!({ "page": "main", "contacts": {
            "friends": [{ "id": AN, "name": "An" }, { "id": BINH, "name": "Bình" }],
            "groups": [{ "id": VIP, "name": "Khách VIP" }, { "id": SALES, "name": "Sales" }],
            "received": [{ "id": "2500", "name": "Người lạ", "message": "Kết bạn nhé" }],
            "pendingRequestCount": 1, "suggestions": [{ "id": "2600" }], "groupInviteUnread": 2,
        } });
        let out = state(&a, &m, &contacts).unwrap()["contacts"].clone();
        assert_eq!(out, json!({ "friends": [{ "id": AN, "name": "An" }], "groups": [{ "id": VIP, "name": "Khách VIP" }] }));
        let search = json!({ "page": "main", "contacts": { "search": { "seq": 1, "status": "found", "user": { "id": "2700", "name": "X" } } } });
        assert_eq!(state(&a, &m, &search), None);
        assert_eq!(state(&all_agent(), &m, &search), Some(search.clone()));
    }

    #[test]
    fn badge_is_recomputed_for_scoped_users() {
        let m = mirror();
        // AN has 2 unread, VIP none.
        assert_eq!(filter_event(&scoped_agent(), &m, "compola://badge", &json!(9)), Some(json!(1)));
        assert_eq!(filter_event(&all_viewer(), &m, "compola://badge", &json!(9)), Some(json!(9)));
        assert_eq!(filter_event(&scoped_agent(), &Mirror::default(), "compola://badge", &json!(9)), None);
    }

    #[test]
    fn phase_and_info_redacted_for_joined_users() {
        let m = mirror();
        let phase = json!({ "kind": "login", "login": { "step": { "kind": "waitingScan" }, "qr": "data:image/png;base64,AAAA", "isSecondQr": false }, "notice": null });
        let out = filter_event(&all_agent(), &m, "compola://phase", &phase).unwrap();
        assert_eq!(out["login"]["qr"], Value::Null);
        assert_eq!(out["login"]["step"], phase["login"]["step"]);
        assert_eq!(filter_result(&all_agent(), &m, "engine_phase", &json!({}), phase.clone())["login"]["qr"], Value::Null);
        assert_eq!(filter_event(&scoped_agent(), &m, "compola://phase", &json!({ "kind": "ready" })), Some(json!({ "kind": "ready" })));
        let info = json!({ "runtimeVersion": "26.10", "storage": "idb", "recentLog": ["[chat] open 2002"] });
        assert_eq!(filter_result(&all_viewer(), &m, "engine_info", &json!({}), info)["recentLog"], json!([]));
    }

    #[test]
    fn replay_is_filtered_event_by_event() {
        let m = mirror();
        let replay = json!([
            conversations_reset(),
            extras(),
            chat(BINH, json!([message(BINH, "m-binh-1", BINH, "Bí mật")])),
            chat(AN, json!([message(AN, "m-an-1", AN, "Chào")])),
            { "page": "main", "zcloud": { "plan": {} } },
        ]);
        let out = filter_result(&scoped_agent(), &m, "engine_replay", &json!({}), replay.clone());
        let events = out.as_array().unwrap();
        assert_eq!(events.len(), 3);
        assert!(!out.to_string().contains("Bí mật"));
        assert_eq!(filter_result(&all_viewer(), &m, "engine_replay", &json!({}), replay.clone()), replay);
    }

    #[test]
    fn automation_is_scoped() {
        let m = mirror();
        let a = scoped_agent();
        assert!(check_call(&a, &m, "automation_messages", &json!({ "conversationId": BINH, "limit": 50 })).is_err());
        assert!(check_call(&a, &m, "automation_messages", &json!({ "conversationId": AN, "limit": 50 })).is_ok());
        assert!(check_call(&a, &m, "automation_messages", &json!({ "conversationId": null, "limit": 50 })).is_ok());
        assert!(check_call(&a, &m, "automation_search", &json!({ "query": "lương", "conversationId": SALES })).is_err());
        assert!(check_call(&a, &m, "automation_search", &json!({ "query": "lương", "conversationId": null })).is_ok());
        let msgs = json!([{ "id": "1", "conversationId": AN, "text": "a" }, { "id": "2", "conversationId": BINH, "text": "b" }]);
        assert_eq!(filter_result(&a, &m, "automation_messages", &json!({}), msgs), json!([{ "id": "1", "conversationId": AN, "text": "a" }]));
        let convs = json!([{ "id": AN, "name": "An" }, { "id": SALES, "name": "Sales" }]);
        assert_eq!(filter_result(&a, &m, "automation_conversations", &json!({}), convs), json!([{ "id": AN, "name": "An" }]));
        let hits = json!({ "mode": "keyword", "hits": [{ "id": "1", "conversationId": VIP, "score": 1.0 }, { "id": "2", "conversationId": BINH, "score": 0.9 }], "semanticError": null });
        let out = filter_result(&a, &m, "automation_search", &json!({}), hits);
        assert_eq!(out["hits"], json!([{ "id": "1", "conversationId": VIP, "score": 1.0 }]));
        assert_eq!(out["mode"], json!("keyword"));
        let status = json!({ "config": { "enabled": true, "apiKey": "sk-secret", "url": "https://api.example.com" }, "stats": { "messages": 10 }, "embedError": null, "path": "/Users/x/search.db" });
        let out = filter_result(&all_agent(), &m, "automation_search_status", &json!({}), status.clone());
        assert_eq!(out["config"]["apiKey"], json!(""));
        assert_eq!(out["path"], json!(""));
        assert_eq!(out["stats"], json!({ "messages": 10 }));
        assert_eq!(filter_result(&a, &m, "automation_search_status", &json!({}), status)["stats"], Value::Null);
    }

    #[test]
    fn pinned_conversation_board_is_filtered() {
        let m = mirror();
        let args = call("__zaloConvActions", "pinBoard", json!([AN]));
        let board = json!({ "tab": 0, "limit": 5, "total": 5, "need": 1, "items": [SALES, VIP, BINH] });
        assert_eq!(filter_result(&scoped_agent(), &m, "engine_call", &args, board.clone())["items"], json!([VIP]));
        assert_eq!(filter_result(&all_agent(), &m, "engine_call", &args, board.clone()), board);
    }

    #[test]
    fn conversations_json_for_the_grant_editor() {
        let m = mirror();
        let j = m.conversations_json();
        let convs = j["conversations"].as_array().unwrap();
        assert_eq!(convs.len(), 5);
        let vip = convs.iter().find(|c| c["id"] == VIP).unwrap();
        assert_eq!(vip["labels"], json!([LABEL_VIP]));
        assert_eq!(vip["isGroup"], json!(true));
        assert_eq!(vip["name"], json!("Khách VIP Hà Nội"));
        assert!(vip["avatar"].as_str().unwrap().ends_with("g3002.jpg"));
        assert_eq!(j["labels"], json!([{ "id": LABEL_VIP, "name": "Khách VIP", "color": "#D91B1B" }, { "id": LABEL_OTHER, "name": "Nội bộ", "color": "#0068FF" }]));
    }

    #[test]
    fn reset_forgets_the_account() {
        let mut m = mirror();
        let g = m.generation();
        m.reset();
        assert!(m.generation() > g);
        assert!(!m.visible(&scoped_agent().scope, VIP));
        assert_eq!(m.conversations_json()["conversations"], json!([]));
        assert!(m.conversations_snapshot(&scoped_agent()).is_none());
        assert!(check(&scoped_agent(), &m, "__zaloPoll", "refresh", json!(["p-vip"])).is_err());
    }

    #[test]
    fn mirror_stays_bounded() {
        let mut b: Bounded<String> = Bounded::default();
        for i in 0..100 {
            b.insert(i.to_string(), "c".into(), 10);
        }
        assert_eq!(b.map.len(), 10);
        assert!(b.get("0").is_none() && b.get("99").is_some());
    }
}
