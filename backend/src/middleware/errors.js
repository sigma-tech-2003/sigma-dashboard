import { HttpError } from "../utils/httpError.js";

export function notFound(_req, _res, next) {
  next(new HttpError(404, "not_found", "The requested API resource was not found."));
}

export function errorHandler(error, req, res, _next) {
  void _next;
  const knownError = error instanceof HttpError;
  const statusCode = knownError ? error.statusCode : 500;
  const code = knownError ? error.code : "internal";
  const message = knownError ? error.message : "The request could not be completed.";

  res.status(statusCode).json({
    error: { code, message, requestId: req.requestId },
  });
}
