import { HttpError } from "../utils/httpError.js";

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
      next();
    } catch (error) {
      next(error instanceof HttpError
        ? error
        : new HttpError(401, "unauthenticated", "Authentication is required."));
    }
  };
}
