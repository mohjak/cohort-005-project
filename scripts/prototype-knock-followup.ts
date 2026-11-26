// PROTOTYPE — Knock spike (#35) follow-up probes. Throwaway branch only.
import Knock, { signUserToken } from "@knocklabs/node";
process.loadEnvFile(".env");
const E = process.env as Record<string, string>;
const knock = new Knock({ apiKey: E.KNOCK_API_KEY });
const API = "https://api.knock.app/v1", CH = E.KNOCK_FEED_CHANNEL_ID;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tok: Record<string, string> = {};
const c = async (uid: string, path: string, init: RequestInit = {}) => {
  tok[uid] ??= await signUserToken(uid, { signingKey: E.KNOCK_SIGNING_KEY });
  const r = await fetch(API + path, { ...init, headers: { Authorization: `Bearer ${E.KNOCK_PUBLIC_API_KEY}`, "X-Knock-User-Token": tok[uid], "Content-Type": "application/json" } });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
const feed = async (uid: string) => (await c(uid, `/users/${uid}/feeds/${CH}?page_size=50`)).body;

console.log("== categories on existing entries (user 9) ==");
console.log((await feed("9")).entries.map((e: any) => ({ key: e.source.key, categories: e.source.categories })).slice(0, 3));

const fresh = `prototype-fresh-${Date.now()}`;
await knock.users.update(fresh, { name: "Fresh prototype user" });
console.log("\n== fresh user, never had a preference set:", fresh);
console.log("GET prefs (server)", JSON.stringify(await knock.users.getPreferences(fresh, "default").catch((e) => String(e))));
await knock.workflows.trigger("new-enrollment", { recipients: [fresh], data: { studentName: "S", courseTitle: "C" } });
await sleep(4000);
console.log("feed total after default trigger:", (await feed(fresh)).meta.total_count, "(expect 0)");
const msgs = await knock.users.listMessages(fresh, {} as any);
console.log("message log:", msgs.items?.map((m: any) => ({ wf: m.source?.key, status: m.status })));

console.log("\n== cross-user mark read ==");
await knock.workflows.trigger("discussion-reply", { recipients: [fresh], data: { replierName: "X", lessonTitle: "L" } });
await sleep(4000);
const f = await feed(fresh);
const id = f.entries.find((e: any) => e.source.key === "discussion-reply").id;
console.log("before: unread", f.meta.unread_count);
const r = await c("1", `/messages/batch/read`, { method: "POST", body: JSON.stringify({ message_ids: [id] }) });
console.log("user 1 marks fresh's message read:", r.status, JSON.stringify(r.body).slice(0, 200));
await sleep(1500);
const f2 = await feed(fresh);
console.log("after: unread", f2.meta.unread_count, "entry read_at", f2.entries.find((e: any) => e.id === id).read_at);
