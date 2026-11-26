// PROTOTYPE: sends sample catalogue Notifications to the current user for #43. Never merge.
import { and, eq } from "drizzle-orm";
import type { Route } from "./+types/api.prototype-notifications-seed";
import { db } from "~/db";
import { teamMembers, TeamMemberRole } from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";
import { seedSampleNotifications } from "~/lib/notification-feed-prototype.server";

export async function action({ request }: Route.ActionArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) return { error: "Select a user from the DevUI panel" };
  const isTeamAdmin = !!db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, userId), eq(teamMembers.role, TeamMemberRole.Admin)))
    .get();
  try {
    return { seeded: await seedSampleNotifications(userId, isTeamAdmin) };
  } catch (err) {
    return { error: String(err) };
  }
}
