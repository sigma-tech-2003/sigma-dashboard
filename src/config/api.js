// The one place that knows where the API is (D36). It is a RELATIVE path: in production Vercel rewrites /api/*
// to the API host, and in development Vite proxies /api to the local backend, so the browser only ever talks to
// its own origin and the SameSite=Strict refresh cookie (Path=/api/v1/auth) keeps working. When the rewrite
// destination is decided it goes in vercel.json, not here.
export const API_BASE_URL = "/api/v1";
