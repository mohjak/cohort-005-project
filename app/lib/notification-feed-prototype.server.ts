// PROTOTYPE: throwaway, for "What does the Notification Feed look like in Cadence?" (#43).
// Lives on the prototype/notification-feed branch only. Never merge.
//
// Seeding trick: only the `discussion-reply` workflow is committed in Knock Development,
// so every sample Notification is sent through it. The feed UI renders from `data`
// (`data.kind` names the catalogue entry), never from Knock's rendered blocks, so the
// workflow name doesn't matter for judging the UI.
import Knock, { signUserToken } from "@knocklabs/node";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "~/db";
import { comments, courses, lessons, modules, users, UserRole } from "~/db/schema";

try {
  process.loadEnvFile(".env");
} catch {
  // already loaded
}

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`PROTOTYPE: ${name} missing from .env`);
  return value;
}

let client: Knock | null = null;
const knock = () => (client ??= new Knock({ apiKey: env("KNOCK_API_KEY") }));

export async function feedClientConfig(userId: number) {
  return {
    knockUserId: String(userId),
    userToken: await signUserToken(String(userId), {
      signingKey: env("KNOCK_SIGNING_KEY"),
      expiresInSeconds: 60 * 60,
    }),
    publicApiKey: env("KNOCK_PUBLIC_API_KEY"),
    feedChannelId: env("KNOCK_FEED_CHANNEL_ID"),
  };
}

export type NotificationKind =
  | "refund-approved"
  | "refund-declined"
  | "open-refund-request"
  | "seat-claimed"
  | "new-enrollment"
  | "discussion-question"
  | "discussion-reply";

type Sample = { kind: NotificationKind; actor: { id: number; name: string }; data: Record<string, unknown> };

export async function seedSampleNotifications(userId: number, isTeamAdmin: boolean) {
  const me = db.select().from(users).where(eq(users.id, userId)).get()!;
  const others = db.select().from(users).where(ne(users.id, userId)).all();
  const pick = (i: number) => others[i % others.length];

  const lesson = db
    .select({
      lessonId: lessons.id,
      lessonTitle: lessons.title,
      courseId: courses.id,
      courseTitle: courses.title,
      slug: courses.slug,
    })
    .from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(me.role === UserRole.Instructor ? eq(courses.instructorId, me.id) : undefined)
    .limit(1)
    .get()!;
  const question = db
    .select({ body: comments.body })
    .from(comments)
    .where(and(isNull(comments.parentId), isNull(comments.deletedAt)))
    .limit(1)
    .get();
  const snippet = (question?.body ?? "How does the second exercise handle the empty case?").slice(0, 120);
  const lessonUrl = `/courses/${lesson.slug}/lessons/${lesson.lessonId}`;

  const samples: Sample[] = [];
  const s = (kind: NotificationKind, actorIdx: number, data: Record<string, unknown>) =>
    samples.push({ kind, actor: { id: pick(actorIdx).id, name: pick(actorIdx).name }, data });

  if (me.role === UserRole.Student) {
    s("refund-declined", 0, { courseTitle: lesson.courseTitle, note: "You've completed most of the course.", url: `/courses/${lesson.slug}` });
    s("refund-approved", 0, { courseTitle: lesson.courseTitle, note: "", url: `/courses/${lesson.slug}` });
  }
  if (me.role === UserRole.Admin) {
    s("open-refund-request", 1, { courseTitle: lesson.courseTitle, amount: "$49.00", reason: "The course wasn't what I expected.", url: "/admin/refunds" });
    s("open-refund-request", 2, { courseTitle: lesson.courseTitle, amount: "$129.00", reason: "Bought it twice by mistake.", url: "/admin/refunds" });
  }
  if (isTeamAdmin) {
    s("seat-claimed", 3, { courseTitle: lesson.courseTitle, seatsLeft: 4, url: "/team" });
    s("seat-claimed", 4, { courseTitle: lesson.courseTitle, seatsLeft: 3, url: "/team" });
  }
  if (me.role === UserRole.Instructor) {
    s("new-enrollment", 5, { courseTitle: lesson.courseTitle, url: `/instructor/${lesson.courseId}/students` });
    s("discussion-question", 6, { courseTitle: lesson.courseTitle, lessonTitle: lesson.lessonTitle, snippet, url: lessonUrl });
    s("discussion-question", 7, { courseTitle: lesson.courseTitle, lessonTitle: lesson.lessonTitle, snippet: "Is there a recording of the live session?", url: lessonUrl });
  }
  s("discussion-reply", 8, { courseTitle: lesson.courseTitle, lessonTitle: lesson.lessonTitle, snippet: "Good question! The trick is to check the length first, then…", url: lessonUrl });

  for (const sample of samples) {
    await knock().workflows.trigger("discussion-reply", {
      actor: { id: String(sample.actor.id), name: sample.actor.name },
      recipients: [{ id: String(me.id), name: me.name, email: me.email }],
      data: { kind: sample.kind, actorName: sample.actor.name, ...sample.data },
    });
  }
  return samples.length;
}
