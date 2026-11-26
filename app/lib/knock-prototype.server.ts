// PROTOTYPE — throwaway spike for "Does Knock hold up against Cadence?" (#35).
// Lives on the prototype/knock-spike branch only. Never merge.
import Knock, { signUserToken } from "@knocklabs/node";

try {
  process.loadEnvFile(".env");
} catch {
  // already loaded, or no .env — the checks below will say so
}

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`PROTOTYPE: ${name} missing from .env`);
  return value;
}

export const knock = new Knock({ apiKey: env("KNOCK_API_KEY") });

export function knockPublicConfig() {
  return {
    publicApiKey: env("KNOCK_PUBLIC_API_KEY"),
    feedChannelId: env("KNOCK_FEED_CHANNEL_ID"),
  };
}

// Knock recipient id for a Cadence user.
export const knockUserId = (userId: number) => String(userId);

export async function signTokenFor(userId: number) {
  return signUserToken(knockUserId(userId), {
    signingKey: env("KNOCK_SIGNING_KEY"),
    expiresInSeconds: 60 * 60,
  });
}
