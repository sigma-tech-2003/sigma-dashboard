import { z } from "zod";

// A length floor only, no composition rules -- this is the one place a brand new credential
// is actually chosen, unlike login (which just tries a string against an existing hash).
export const setPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(200),
}).strict();
