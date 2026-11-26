// PROTOTYPE — Knock spike (#35) checks 2–4. Throwaway branch only.
import Database from "better-sqlite3";
import Knock, { signUserToken } from "@knocklabs/node";
process.loadEnvFile(".env");
const E = process.env as Record<string, string>;
const knock = new Knock({ apiKey: E.KNOCK_API_KEY });
const API = "https://api.knock.app/v1";
const CH = E.KNOCK_FEED_CHANNEL_ID;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sqlite = new Database("data.db", { readonly: true });
const q = sqlite.prepare(`select c.id, c.body, c.user_id as authorId, a.name as authorName, a.email as authorEmail, l.title as lessonTitle
  from comments c join users a on a.id=c.user_id join lessons l on l.id=c.lesson_id
  where c.parent_id is null and c.deleted_at is null order by c.created_at desc limit 1`).get() as any;
const replier = sqlite.prepare(`select id, name, email from users where id != ? order by id limit 1`).get(q.authorId) as any;
console.log(`question #${q.id} by ${q.authorName} (${q.authorId}); replier ${replier.name} (${replier.id})`);

const tok: Record<string, string> = {};
const c = async (uid: string, path: string, init: RequestInit = {}) => {
  tok[uid] ??= await signUserToken(uid, { signingKey: E.KNOCK_SIGNING_KEY });
  const r = await fetch(API + path, { ...init, headers: { Authorization: `Bearer ${E.KNOCK_PUBLIC_API_KEY}`, "X-Knock-User-Token": tok[uid], "Content-Type": "application/json" } });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
const feed = async (uid: string) => (await c(uid, `/users/${uid}/feeds/${CH}?page_size=50`)).body;
const show = (label: string, f: any) => console.log(label, JSON.stringify(f.meta), f.entries.slice(0, 3).map((e: any) => ({ key: e.source.key, seen: !!e.seen_at, read: !!e.read_at, text: e.blocks.map((b: any) => b.rendered).join("|").slice(0, 100) })));

const A = String(q.authorId), R = String(replier.id);
// clean slate prefs for author
await knock.users.setPreferences(A, "default", { __persistence_strategy__: "replace" } as any);

console.log("\n== CHECK 2: trigger Discussion Reply ==");
const before = { a: (await feed(A)).meta.total_count, r: (await feed(R)).meta.total_count };
const run = await knock.workflows.trigger("discussion-reply", {
  actor: { id: R, name: replier.name, email: replier.email },
  recipients: [{ id: A, name: q.authorName, email: q.authorEmail }],
  data: { replierName: replier.name, lessonTitle: q.lessonTitle, questionExcerpt: q.body.slice(0, 120), questionId: q.id },
});
console.log("trigger ->", run);
await sleep(4000);
const fa = await feed(A), fr = await feed(R);
console.log(`author total ${before.a} -> ${fa.meta.total_count}; replier total ${before.r} -> ${fr.meta.total_count}`);
show("author feed:", fa);

console.log("\n== CHECK 3: headless feed ops ==");
const id = fa.entries[0].id;
console.log("seen", (await c(A, `/messages/batch/seen`, { method: "POST", body: JSON.stringify({ message_ids: [id] }) })).status);
show("after seen:", await feed(A));
console.log("read", (await c(A, `/messages/batch/read`, { method: "POST", body: JSON.stringify({ message_ids: [id] }) })).status);
show("after read:", await feed(A));
console.log("unread", (await c(A, `/messages/batch/unread`, { method: "POST", body: JSON.stringify({ message_ids: [id] }) })).status);
show("after unread:", await feed(A));
console.log("replier tries to mark author's msg read:", (await c(R, `/messages/batch/read`, { method: "POST", body: JSON.stringify({ message_ids: [id] }) })).status);
const bulk = await c(A, `/channels/${CH}/messages/bulk/read`, { method: "POST", body: JSON.stringify({ user_ids: [A] }) });
console.log("bulk mark all read", bulk.status, JSON.stringify(bulk.body).slice(0, 150));
await sleep(3000);
show("after bulk read:", await feed(A));

console.log("\n== CHECK 4: new Enrollment off by default, opt-in ==");
const n0 = (await feed(A)).meta.total_count;
console.log("trigger (default prefs) ->", await knock.workflows.trigger("new-enrollment", { recipients: [A], data: { studentName: "Prototype Student", courseTitle: "Prototype Course" } }));
await sleep(4000);
const n1 = (await feed(A)).meta.total_count;
console.log(`total ${n0} -> ${n1} (expect unchanged)`);
const opt = await c(A, `/users/${A}/preferences/default`, { method: "PUT", body: JSON.stringify({ __persistence_strategy__: "merge", categories: { "new-enrollment": { channel_types: { in_app_feed: true } } } }) });
console.log("user opts in via own token", opt.status, JSON.stringify(opt.body.categories));
console.log("trigger (opted in) ->", await knock.workflows.trigger("new-enrollment", { recipients: [A], data: { studentName: "Prototype Student", courseTitle: "Prototype Course" } }));
await sleep(4000);
const f2 = await feed(A);
console.log(`total ${n1} -> ${f2.meta.total_count} (expect +1)`);
show("author feed:", f2);
const msgs = await knock.users.listMessages(A, { page_size: 5 } as any);
console.log("server-side message log:", msgs.items?.map((m: any) => ({ wf: m.source?.key, status: m.status })));
await knock.users.setPreferences(A, "default", { __persistence_strategy__: "replace" } as any);
console.log("reset author prefs");
