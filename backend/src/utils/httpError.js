export class HttpError extends Error {
  /** `details` is optional structured context for the caller, surfaced by errorHandler. */
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
