// PROTOTYPE — Knock spike (#35) probe. Throwaway branch only.
import Knock, { signUserToken } from "@knocklabs/node";
process.loadEnvFile(".env");
const E = process.env as Record<string,string>;
const knock = new Knock({ apiKey: E.KNOCK_API_KEY });
const API = "https://api.knock.app/v1";
await knock.users.update("1", { name: "probe 1" });
await knock.users.update("2", { name: "probe 2" });
const t1 = await signUserToken("1", { signingKey: E.KNOCK_SIGNING_KEY });
const c = async (label: string, path: string, init: RequestInit = {}, tok = t1) => {
  const r = await fetch(API + path, { ...init, headers: { Authorization: `Bearer ${E.KNOCK_PUBLIC_API_KEY}`, "X-Knock-User-Token": tok, "Content-Type": "application/json" } });
  console.log(label, r.status, (await r.text()).slice(0, 300));
};
await c("own feed", `/users/1/feeds/${E.KNOCK_FEED_CHANNEL_ID}`);
await c("other user's feed w/ my token", `/users/2/feeds/${E.KNOCK_FEED_CHANNEL_ID}`);
await c("get own prefs", `/users/1/preferences/default`);
await c("put own prefs", `/users/1/preferences/default`, { method: "PUT", body: JSON.stringify({ __persistence_strategy__: "merge", categories: { "new-enrollment": { channel_types: { in_app_feed: false } } } }) });
await c("put OTHER prefs", `/users/2/preferences/default`, { method: "PUT", body: JSON.stringify({ categories: { "new-enrollment": false } }) });
await c("trigger with public key+token (should fail)", `/workflows/discussion-reply/trigger`, { method: "POST", body: JSON.stringify({ recipients: ["1"] }) });
