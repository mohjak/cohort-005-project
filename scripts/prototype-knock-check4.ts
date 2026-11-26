// PROTOTYPE — Knock spike (#35) check 4 re-run. Throwaway branch only.
import Knock, { signUserToken } from "@knocklabs/node";
process.loadEnvFile(".env");
const E = process.env as Record<string, string>;
const knock = new Knock({ apiKey: E.KNOCK_API_KEY });
const API = "https://api.knock.app/v1", CH = E.KNOCK_FEED_CHANNEL_ID;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uid = `prototype-fresh-${Date.now()}`;
const token = await signUserToken(uid, { signingKey: E.KNOCK_SIGNING_KEY });
const c = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(API + path, { ...init, headers: { Authorization: `Bearer ${E.KNOCK_PUBLIC_API_KEY}`, "X-Knock-User-Token": token, "Content-Type": "application/json" } });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
const total = async () => (await c(`/users/${uid}/feeds/${CH}`)).body.meta.total_count;
const enroll = () => knock.workflows.trigger("new-enrollment", { recipients: [uid], data: { studentName: "S", courseTitle: "C" } });
const log = async () => (await knock.users.listMessages(uid, {} as any)).items?.map((m: any) => `${m.source?.key}:${m.status}`);
await knock.users.update(uid, { name: "Fresh prototype user" });
console.log("fresh user", uid);
await enroll(); await sleep(5000);
console.log("default prefs -> feed total", await total(), "(expect 0); message log", await log());
const opt = await c(`/users/${uid}/preferences/default`, { method: "PUT", body: JSON.stringify({ __persistence_strategy__: "merge", categories: { "new-enrollment": { channel_types: { in_app_feed: true } } } }) });
console.log("opt in with own token", opt.status);
await enroll(); await sleep(5000);
console.log("opted in -> feed total", await total(), "(expect 1); message log", await log());
await knock.workflows.trigger("discussion-reply", { recipients: [uid], data: { replierName: "X", lessonTitle: "L" } }); await sleep(5000);
console.log("discussion-reply unaffected -> feed total", await total(), "(expect 2)");
