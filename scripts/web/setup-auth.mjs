import { randomBytes, timingSafeEqual } from "node:crypto";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const FAILED_ATTEMPT_LIMIT = 5;
const FAILED_ATTEMPT_WINDOW_MS = 60 * 1000;
const RETRY_AFTER_SECONDS = 30;
export const SESSION_COOKIE = "web_installer_session";

export const parseCookies = (header = "") => Object.fromEntries(header.split(";").flatMap((part) => {
  const separator = part.indexOf("=");
  if (separator < 1) return [];
  return [[part.slice(0, separator).trim(), part.slice(separator + 1).trim()]];
}));

export const equalTokens = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

export const createSetupAuthentication = ({ setupToken, now = Date.now } = {}) => {
  const required = typeof setupToken === "string" && setupToken.length > 0;
  const sessions = new Map();
  let pendingToken = required ? setupToken : null;
  let failedAttempts = [];
  let blockedUntil = 0;

  const prune = () => {
    const currentTime = now();
    for (const [session, expiresAt] of sessions) {
      if (expiresAt <= currentTime) sessions.delete(session);
    }
  };

  return {
    required,

    exchange(candidate) {
      const currentTime = now();
      if (pendingToken && equalTokens(candidate, pendingToken)) {
        pendingToken = null;
        failedAttempts = [];
        blockedUntil = 0;
        const session = randomBytes(32).toString("base64url");
        sessions.set(session, currentTime + SESSION_TTL_MS);
        return { status: "authenticated", session };
      }

      if (blockedUntil > currentTime) {
        return {
          status: "throttled",
          retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - currentTime) / 1000)),
        };
      }
      failedAttempts = failedAttempts.filter((attemptedAt) => (
        attemptedAt > currentTime - FAILED_ATTEMPT_WINDOW_MS
      ));
      failedAttempts.push(currentTime);
      if (failedAttempts.length >= FAILED_ATTEMPT_LIMIT) {
        failedAttempts = [];
        blockedUntil = currentTime + RETRY_AFTER_SECONDS * 1000;
        return { status: "throttled", retryAfterSeconds: RETRY_AFTER_SECONDS };
      }

      return { status: "invalid" };
    },

    isAuthenticated(cookieHeader) {
      if (!required) return true;
      prune();
      const session = parseCookies(cookieHeader)[SESSION_COOKIE];
      return typeof session === "string" && sessions.has(session);
    },
  };
};

export const createSessionCookie = (session) => (
  `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`
);
