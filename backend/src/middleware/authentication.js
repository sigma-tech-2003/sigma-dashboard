import { HttpError } from "../utils/httpError.js";

/**
 * D41: while an account is on a TEMPORARY password (principal.mustChangePassword) it may do exactly two things: read its
 * own profile (so the client can show who is signing in) and change the password. Everything else is refused. This is
 * enforced HERE, on the server, because a redirect in the browser enforces nothing: the temporary password yields an
 * ordinary token, and whoever set it would otherwise keep using the employee's account with it indefinitely.
 */
function allowedWhileChangeRequired(req) {
  const path = req.path.length > 1 ? req.path.replace(/\/+$/, "") : req.path;
  return (req.method === "POST" && path === "/auth/change-password")
    || (req.method === "GET" && path === "/auth/me");
}

export function createAuthenticationMiddleware({ verifyAccessToken }) {
  if (typeof verifyAccessToken !== "function") {
    throw new TypeError("A future access-token verifier is required.");
  }

  return async (req, _res, next) => {
    try {
      const authorization = req.get("authorization");
      if (!authorization?.startsWith("Bearer ")) {
        throw new HttpError(401, "unauthenticated", "Authentication is required.");
      }
      req.principal = await verifyAccessToken(authorization.slice(7));
      if (req.principal?.mustChangePassword === true && !allowedWhileChangeRequired(req)) {
        throw new HttpError(
          403,
          "password_change_required",
          "You must choose a new password before you can continue.",
        );
      }
      next();
    } catch (error) {
      next(error instanceof HttpError
        ? error
        : new HttpError(401, "unauthenticated", "Authentication is required."));
    }
  };
}
