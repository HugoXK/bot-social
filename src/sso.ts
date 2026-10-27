import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

/**
 * HUGOXK shared sign-in cookie.
 *
 * The portal (behind Cloudflare Access / GitHub) signs a small JSON payload with a local HMAC secret.
 * Bot Social only verifies it and maps it to one configured owner. The cookie is HttpOnly, so page
 * scripts cannot read it; the SSO endpoint exchanges it for the normal owner login token.
 */
export const SSO_COOKIE = "hugoxk_sso";
const MAX_AGE_SECONDS = 7 * 24 * 3600;

export interface SsoPayload { v: 1; sub: string; email: string; name?: string; exp: number }

export interface SsoConfig {
  secret: string;
  ownerId: string;
  portal: string;
  cookieDomain: string;
}

const env = (name: string) => String(process.env[name] ?? "").trim();

export function ssoConfig(): SsoConfig | null {
  const ownerId = env("BOTSOCIAL_SSO_OWNER_ID");
  const file = env("BOTSOCIAL_SSO_SECRET_FILE");
  const inline = env("BOTSOCIAL_SSO_SECRET");
  let secret = inline;
  if (!secret && file && existsSync(file)) {
    try { secret = readFileSync(file, "utf8").trim(); } catch { secret = ""; }
  }
  if (!secret || !ownerId) return null;
  return {
    secret,
    ownerId,
    portal: env("BOTSOCIAL_SSO_PORTAL") || "https://portal.hugoxk.online",
    cookieDomain: env("BOTSOCIAL_SSO_COOKIE_DOMAIN"),
  };
}

export function signSsoCookie(secret: string, payload: Omit<SsoPayload, "v" | "exp"> & { exp?: number }, nowMs = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ v: 1, ...payload, exp: payload.exp ?? Math.floor(nowMs / 1000) + MAX_AGE_SECONDS })).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySsoCookie(secret: string, value: string | undefined, nowMs = Date.now()): SsoPayload | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const body = value.slice(0, dot);
  const got = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("base64url"));
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  let payload: any;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (!payload || payload.v !== 1 || typeof payload.sub !== "string" || !payload.sub || typeof payload.email !== "string" || !payload.email) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= nowMs) return null;
  return { v: 1, sub: payload.sub, email: payload.email, name: typeof payload.name === "string" ? payload.name : undefined, exp: payload.exp };
}

export function readCookie(header: string | undefined, name = SSO_COOKIE): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return part.slice(i + 1).trim(); }
    }
  }
  return undefined;
}

/** Clear the parent-domain cookie from a Bot Social response (logout). */
export function clearSsoCookie(domain: string): string | undefined {
  if (!domain) return undefined;
  return `${SSO_COOKIE}=; Domain=${domain}; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

export function ssoStartUrl(portal: string, returnTo: string): string {
  return `${portal.replace(/\/$/, "")}/?return=${encodeURIComponent(returnTo)}`;
}
