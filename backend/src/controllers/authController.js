import { environment } from "../config/env.js";

/**
 * Every decision here is about *transport*, not authentication -- the actual login/refresh/
 * logout behavior (including the single generic error for a wrong password, an unknown
 * email, and a deactivated account) lives entirely in services/authService.js and is not
 * reimplemented or second-guessed here. This file only decides how tokens travel over HTTP.
 *
 * The refresh token is never placed in a JSON response body. A response body is readable by
 * any JavaScript running on the page, so an XSS bug anywhere in the frontend would hand an
 * attacker a long-lived (14-day default) credential. Instead it travels as an httpOnly,
 * SameSite=Strict cookie scoped to /api/v1/auth: httpOnly keeps it unreadable to JavaScript
 * entirely (the standard mitigation for exactly this class of XSS token theft), and the
 * narrow path means the browser never attaches it to any other endpoint. The access token
 * stays in the response body -- it has to be readable by the frontend's own JS to be sent as
 * an Authorization header, but it is short-lived (15 minutes by default), so the exposure
 * window if it is ever stolen is much smaller.
 */
const REFRESH_TOKEN_COOKIE_NAME = "refresh_token";
const REFRESH_TOKEN_COOKIE_PATH = "/api/v1/auth";

function refreshTokenCookieOptions(maxAgeSeconds) {
  return {
    httpOnly: true,
    // http:// is normal for local dev; requiring secure there would silently drop the
    // cookie. Only enforced once NODE_ENV=production, matching the enforcement pattern
    // migrate.js/import-firestore.js already use for their own production guards.
    secure: environment.nodeEnv === "production",
    sameSite: "strict",
    path: REFRESH_TOKEN_COOKIE_PATH,
    ...(maxAgeSeconds !== undefined ? { maxAge: maxAgeSeconds * 1000 } : {}),
  };
}

/** Reads the refresh token cookie without adding the cookie-parser dependency for one value. */
function readRefreshTokenCookie(req) {
  const header = req.headers.cookie;
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) continue;
    const name = part.slice(0, separatorIndex).trim();
    if (name !== REFRESH_TOKEN_COOKIE_NAME) continue;
    try {
      return decodeURIComponent(part.slice(separatorIndex + 1).trim());
    } catch {
      return null; // malformed percent-encoding: treat as no cookie, not a crash
    }
  }
  return null;
}

export function createAuthController(getAuthService) {
  return {
    async login(req, res, next) {
      try {
        const authService = getAuthService();
        // Coerced, never rejected here with a validation-specific status: a malformed or
        // missing field is just handed to authService.login as an empty string, which
        // already produces the same generic unauthenticated error a wrong password does --
        // adding a separate 400 path here would be a second place that decision could drift.
        const email = typeof req.body?.email === "string" ? req.body.email : "";
        const password = typeof req.body?.password === "string" ? req.body.password : "";

        const { principal, accessToken, refreshToken, expiresIn } = await authService.login({ email, password });

        res.cookie(REFRESH_TOKEN_COOKIE_NAME, refreshToken, refreshTokenCookieOptions(authService.tokens.refreshTokenTtlSeconds));
        res.json({ data: { accessToken, expiresIn, principal } });
      } catch (error) {
        next(error);
      }
    },

    async refresh(req, res, next) {
      try {
        const authService = getAuthService();
        const refreshToken = readRefreshTokenCookie(req);

        const result = await authService.refresh({ refreshToken });

        res.cookie(REFRESH_TOKEN_COOKIE_NAME, result.refreshToken, refreshTokenCookieOptions(authService.tokens.refreshTokenTtlSeconds));
        res.json({ data: { accessToken: result.accessToken, expiresIn: result.expiresIn, principal: result.principal } });
      } catch (error) {
        next(error);
      }
    },

    async logout(req, res, next) {
      try {
        const authService = getAuthService();
        const refreshToken = readRefreshTokenCookie(req);

        await authService.logout({ refreshToken });

        res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, refreshTokenCookieOptions());
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  };
}
