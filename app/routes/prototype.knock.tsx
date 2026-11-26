// PROTOTYPE — throwaway spike for "Does Knock hold up against Cadence?" (#35).
// Lives on the prototype/knock-spike branch only. Never merge.
// Open /prototype/knock, switch users in the DevUI panel, and work the four checks.
import { useCallback, useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Route } from "./+types/prototype.knock";
import { db } from "~/db";
import { comments, courses, lessons, modules, users } from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";
import {
  knock,
  knockPublicConfig,
  knockUserId,
  signTokenFor,
} from "~/lib/knock-prototype.server";

const API = "https://api.knock.app/v1";

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) {
    throw new Response("Select a user from the DevUI panel", { status: 401 });
  }
  const me = db.select().from(users).where(eq(users.id, userId)).get()!;
  const others = db
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .all()
    .filter((u) => u.id !== userId)
    .slice(0, 8);

  // Make sure the selected user exists as a Knock recipient.
  await knock.users.update(knockUserId(me.id), {
    name: me.name,
    email: me.email,
  });

  const questions = db
    .select({
      id: comments.id,
      body: comments.body,
      authorId: users.id,
      authorName: users.name,
      lessonTitle: lessons.title,
      courseTitle: courses.title,
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.userId))
    .innerJoin(lessons, eq(lessons.id, comments.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(and(isNull(comments.parentId), isNull(comments.deletedAt)))
    .orderBy(desc(comments.createdAt))
    .limit(6)
    .all();

  return {
    me: { id: me.id, name: me.name, role: me.role },
    knockUserId: knockUserId(me.id),
    userToken: await signTokenFor(me.id),
    others: others.map((o) => ({ ...o, knockUserId: knockUserId(o.id) })),
    questions,
    ...knockPublicConfig(),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) throw new Response("No user", { status: 401 });
  const me = db.select().from(users).where(eq(users.id, userId)).get()!;
  const form = await request.formData();
  const intent = form.get("intent");

  try {
    if (intent === "discussion-reply") {
      const questionId = Number(form.get("questionId"));
      const q = db
        .select({
          id: comments.id,
          body: comments.body,
          authorId: users.id,
          authorName: users.name,
          authorEmail: users.email,
          lessonTitle: lessons.title,
        })
        .from(comments)
        .innerJoin(users, eq(users.id, comments.userId))
        .innerJoin(lessons, eq(lessons.id, comments.lessonId))
        .where(eq(comments.id, questionId))
        .get()!;
      if (q.authorId === me.id) {
        return { ok: false, result: "Skipped: you wrote this question (Notifications are only caused by someone else)." };
      }
      const res = await knock.workflows.trigger("discussion-reply", {
        actor: { id: knockUserId(me.id), name: me.name, email: me.email },
        recipients: [
          { id: knockUserId(q.authorId), name: q.authorName, email: q.authorEmail },
        ],
        data: {
          replierName: me.name,
          lessonTitle: q.lessonTitle,
          questionExcerpt: q.body.slice(0, 120),
          questionId: q.id,
        },
      });
      return { ok: true, result: { recipient: q.authorName, ...res } };
    }

    if (intent === "new-enrollment") {
      const res = await knock.workflows.trigger("new-enrollment", {
        recipients: [knockUserId(me.id)],
        data: { studentName: "Prototype Student", courseTitle: "Prototype Course" },
      });
      return { ok: true, result: res };
    }
  } catch (err) {
    return { ok: false, result: String(err) };
  }
  return { ok: false, result: `unknown intent ${intent}` };
}

type FeedEntry = {
  id: string;
  inserted_at: string;
  seen_at: string | null;
  read_at: string | null;
  source: { key: string; categories?: string[] };
  data: Record<string, unknown>;
  blocks: { name: string; rendered?: string; content?: string }[];
};
type FeedResponse = {
  entries: FeedEntry[];
  meta: { unread_count: number; unseen_count: number; total_count: number };
};

export default function KnockPrototype({ loaderData }: Route.ComponentProps) {
  const d = loaderData;
  const fetcher = useFetcher<typeof action>();
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  const [log, setLog] = useState<{ label: string; status: number; body: unknown }[]>([]);
  const [prefs, setPrefs] = useState<unknown>(null);

  // Headless client calls: public key + signed user token, exactly what the browser would do.
  const call = useCallback(
    async (label: string, path: string, init?: RequestInit, token = d.userToken) => {
      const res = await fetch(`${API}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${d.publicApiKey}`,
          "X-Knock-User-Token": token,
          "Content-Type": "application/json",
        },
      });
      const body = await res.json().catch(() => null);
      setLog((l) => [{ label, status: res.status, body }, ...l].slice(0, 12));
      return { status: res.status, body };
    },
    [d.userToken, d.publicApiKey]
  );

  const loadFeed = useCallback(async () => {
    const r = await call(
      "GET feed",
      `/users/${d.knockUserId}/feeds/${d.feedChannelId}?page_size=20`
    );
    if (r.status === 200) setFeed(r.body as FeedResponse);
  }, [call, d.knockUserId, d.feedChannelId]);

  const loadPrefs = useCallback(async () => {
    const r = await call("GET preferences", `/users/${d.knockUserId}/preferences/default`);
    setPrefs(r.body);
  }, [call, d.knockUserId]);

  // Reload whenever the DevUI switches user (new token) or an action finishes.
  useEffect(() => {
    setFeed(null);
    loadFeed();
    loadPrefs();
  }, [loadFeed, loadPrefs]);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      const t = setTimeout(loadFeed, 2000); // workflow runs are async
      return () => clearTimeout(t);
    }
  }, [fetcher.state, fetcher.data, loadFeed]);

  const mark = (status: "seen" | "read" | "unread", ids: string[]) =>
    call(`mark ${status}`, `/messages/batch/${status}`, {
      method: "POST",
      body: JSON.stringify({ message_ids: ids }),
    }).then(loadFeed);

  const markAllSeen = () =>
    call("mark all seen (bulk)", `/channels/${d.feedChannelId}/messages/bulk/seen`, {
      method: "POST",
      body: JSON.stringify({ user_ids: [d.knockUserId] }),
    }).then(() => setTimeout(loadFeed, 1500));

  const setEnrollmentOptIn = (on: boolean) =>
    call(`set new-enrollment in_app_feed=${on}`, `/users/${d.knockUserId}/preferences/default`, {
      method: "PUT",
      body: JSON.stringify({
        __persistence_strategy__: "merge",
        categories: { "new-enrollment": { channel_types: { in_app_feed: on } } },
      }),
    }).then(loadPrefs);

  const tryOtherFeed = (otherId: string) =>
    call(
      `GET feed of user ${otherId} with MY token (expect rejection)`,
      `/users/${otherId}/feeds/${d.feedChannelId}`
    );

  const tokenSub = JSON.parse(atob(d.userToken.split(".")[1])).sub;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6 text-sm">
      <div className="rounded border-2 border-dashed border-amber-500 bg-amber-50 p-3 dark:bg-amber-950">
        <strong>PROTOTYPE</strong> — Knock spike for #35. Throwaway. Switch users in the DevUI panel.
      </div>

      <section className="space-y-1">
        <h2 className="text-lg font-semibold">1. Signed user token</h2>
        <div>
          Signed in as <b>{d.me.name}</b> ({d.me.role}) → Knock user <code>{d.knockUserId}</code>, token
          sub <code>{tokenSub}</code>
        </div>
        <div className="flex flex-wrap gap-2">
          {d.others.slice(0, 3).map((o) => (
            <button key={o.id} className="rounded border px-2 py-1" onClick={() => tryOtherFeed(o.knockUserId)}>
              Read {o.name}'s feed with my token
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">2. Trigger Discussion Reply → question author</h2>
        {d.questions.map((q) => (
          <fetcher.Form method="post" key={q.id} className="flex items-center gap-2">
            <input type="hidden" name="intent" value="discussion-reply" />
            <input type="hidden" name="questionId" value={q.id} />
            <button className="rounded border px-2 py-1">Reply as me</button>
            <span>
              <b>{q.authorName}</b> asked on “{q.lessonTitle}”: {q.body.slice(0, 70)}
            </span>
          </fetcher.Form>
        ))}
        {fetcher.data && (
          <pre className="overflow-auto rounded bg-muted p-2">{JSON.stringify(fetcher.data, null, 2)}</pre>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">3. Headless feed</h2>
        <div className="flex flex-wrap gap-2">
          <button className="rounded border px-2 py-1" onClick={loadFeed}>Refresh</button>
          <button className="rounded border px-2 py-1" onClick={markAllSeen}>Mark all seen</button>
        </div>
        {feed ? (
          <>
            <div>
              unread <b>{feed.meta.unread_count}</b> · unseen <b>{feed.meta.unseen_count}</b> · total{" "}
              <b>{feed.meta.total_count}</b>
            </div>
            <ul className="space-y-1">
              {feed.entries.map((e) => (
                <li key={e.id} className={`rounded border p-2 ${e.read_at ? "opacity-60" : ""}`}>
                  <div>
                    <code>{e.source.key}</code> {e.seen_at ? "seen" : "UNSEEN"} · {e.read_at ? "read" : "UNREAD"} ·{" "}
                    {e.inserted_at}
                  </div>
                  <div>{e.blocks.map((b) => b.rendered ?? b.content).join(" | ")}</div>
                  <div className="text-muted-foreground">{JSON.stringify(e.data)}</div>
                  <div className="flex gap-2">
                    <button className="underline" onClick={() => mark("seen", [e.id])}>seen</button>
                    <button className="underline" onClick={() => mark("read", [e.id])}>read</button>
                    <button className="underline" onClick={() => mark("unread", [e.id])}>unread</button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div>no feed loaded</div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">4. Preferences: new Enrollment (off by default, opt-in)</h2>
        <div className="flex flex-wrap gap-2">
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="new-enrollment" />
            <button className="rounded border px-2 py-1">Trigger new Enrollment to me</button>
          </fetcher.Form>
          <button className="rounded border px-2 py-1" onClick={() => setEnrollmentOptIn(true)}>Opt in</button>
          <button className="rounded border px-2 py-1" onClick={() => setEnrollmentOptIn(false)}>Opt out</button>
        </div>
        <pre className="overflow-auto rounded bg-muted p-2">{JSON.stringify(prefs, null, 2)}</pre>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Raw Knock calls (newest first)</h2>
        <pre className="max-h-96 overflow-auto rounded bg-muted p-2">{JSON.stringify(log, null, 2)}</pre>
      </section>
    </div>
  );
}
