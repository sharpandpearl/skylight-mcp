/**
 * Skylight authentication: OAuth 2.0 Authorization Code + PKCE, where the
 * credential step is a server-rendered Rails form rather than a JSON endpoint.
 *
 * Flow (per the API notes):
 *   0. GET  /auth/session/new            -> CSRF token + skylightcloud_session cookie
 *   1. GET  /oauth/authorize?...         -> 302 back to the login form, OAuth params preserved
 *   2. POST /auth/session                -> credentials; session cookie rotates
 *   3. 302  -> ourskylight.com/welcome?code=...
 *   4. POST /oauth/token                 -> access_token / refresh_token
 *
 * Redirects are followed MANUALLY throughout: the authorization code only ever
 * exists in a Location header, and fetch's automatic redirect following would
 * chase it to a page that does not exist and lose it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const AUTH_BASE = "https://app.ourskylight.com";
const CLIENT_ID = "skylight-mobile";
const REDIRECT_URI = "https://ourskylight.com/welcome";
const SCOPE = "everything";

export const API_BASE = `${AUTH_BASE}/api`;
export const API_HEADERS = {
  "User-Agent": "SkylightMobile (web)",
  "Skylight-Api-Version": "2026-05-01",
  Accept: "application/json",
};

const TOKEN_PATH =
  process.env.SKYLIGHT_TOKEN_PATH ||
  path.join(os.homedir(), ".skylight-mcp", "token.json");

const b64url = (buf) => buf.toString("base64url");

function makePkce() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge, state: b64url(crypto.randomBytes(16)) };
}

/** Accumulates Set-Cookie across the redirect chain; Skylight rotates the session mid-flow. */
class CookieJar {
  constructor() {
    this.jar = new Map();
  }
  absorb(res) {
    const raw = res.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) this.jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  header() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

function csrfFrom(html) {
  const m = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/i);
  if (!m) throw new Error("Could not find <meta name=csrf-token> on the login page");
  return m[1];
}

/** Performs a full interactive-style login and returns a token bundle. */
export async function login(email, password) {
  if (!email || !password) throw new Error("Missing Skylight email or password");
  const jar = new CookieJar();
  const { verifier, challenge, state } = makePkce();

  // Step 0 — login page, for the CSRF token and the initial session cookie.
  const loginPage = await fetch(`${AUTH_BASE}/auth/session/new`, {
    headers: { "User-Agent": API_HEADERS["User-Agent"] },
    redirect: "manual",
  });
  jar.absorb(loginPage);
  const csrf = csrfFrom(await loginPage.text());

  // Step 1 — start the OAuth dance so the server associates the PKCE challenge
  // with this session. The 302 goes back to the login form; we only need the cookie.
  const authorizeUrl =
    `${AUTH_BASE}/oauth/authorize?client_id=${CLIENT_ID}&response_type=code` +
    `&scope=${SCOPE}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;
  const authorize = await fetch(authorizeUrl, {
    headers: { Cookie: jar.header(), "User-Agent": API_HEADERS["User-Agent"] },
    redirect: "manual",
  });
  jar.absorb(authorize);

  // Step 2 — submit credentials to the Rails form.
  const form = new URLSearchParams({ authenticity_token: csrf, email, password });
  const submit = await fetch(`${AUTH_BASE}/auth/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: jar.header(),
      "User-Agent": API_HEADERS["User-Agent"],
    },
    body: form,
    redirect: "manual",
  });
  jar.absorb(submit);
  if (submit.status >= 400) {
    throw new Error(`Credential submission failed (HTTP ${submit.status}) — check email/password`);
  }

  // Step 3 — follow redirects by hand until a ?code= appears.
  let location = submit.headers.get("location");
  let code = null;
  for (let hop = 0; hop < 10 && location && !code; hop++) {
    const next = new URL(location, AUTH_BASE);
    const got = next.searchParams.get("code");
    if (got) {
      const returned = next.searchParams.get("state");
      if (returned && returned !== state) throw new Error("OAuth state mismatch — aborting");
      code = got;
      break;
    }
    // Never send session cookies off the Skylight auth origin.
    const sameOrigin = next.origin === AUTH_BASE;
    const res = await fetch(next, {
      headers: {
        ...(sameOrigin ? { Cookie: jar.header() } : {}),
        "User-Agent": API_HEADERS["User-Agent"],
      },
      redirect: "manual",
    });
    if (sameOrigin) jar.absorb(res);
    location = res.headers.get("location");
    if (!location && res.status === 200) {
      // Landed on a rendered page instead of a redirect: almost always the login
      // form re-served with an error, which means the credentials were rejected.
      const body = await res.text();
      if (/csrf-token/i.test(body)) {
        throw new Error("Login bounced back to the sign-in form — credentials likely rejected");
      }
    }
  }
  if (!code) throw new Error("Never received an authorization code from Skylight");

  // Step 4 — exchange the code.
  const tokenRes = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": API_HEADERS["User-Agent"],
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Token exchange failed (HTTP ${tokenRes.status}): ${await tokenRes.text()}`);
  }
  const tok = await tokenRes.json();
  return {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000,
  };
}

export async function refresh(refresh_token) {
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": API_HEADERS["User-Agent"],
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token,
    }),
  });
  if (!res.ok) throw new Error(`Refresh failed (HTTP ${res.status})`);
  const tok = await res.json();
  return {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? refresh_token,
    expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000,
  };
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(tok) {
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  // Tokens are credentials: keep the file owner-only.
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tok, null, 1), { mode: 0o600 });
}

/**
 * Returns a usable access token, reusing the cached one when it is still valid,
 * refreshing when it is not, and falling back to a full login.
 */
export async function getAccessToken({ email, password } = {}) {
  const cached = readCache();
  if (cached?.access_token && cached.expires_at > Date.now() + 60_000) {
    return cached.access_token;
  }
  if (cached?.refresh_token) {
    try {
      const tok = await refresh(cached.refresh_token);
      writeCache(tok);
      return tok.access_token;
    } catch {
      /* fall through to a fresh login */
    }
  }
  const tok = await login(
    email ?? process.env.SKYLIGHT_EMAIL,
    password ?? process.env.SKYLIGHT_PASSWORD,
  );
  writeCache(tok);
  return tok.access_token;
}
