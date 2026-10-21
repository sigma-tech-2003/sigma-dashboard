import { z } from "zod";

// D41: temporary passwords and the forced first change. One rule for every password the API accepts, so the creator's
// temporary password, an admin's reset and the employee's own new password cannot disagree about what is allowed.
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

// Deliberately NOT trimmed or otherwise altered: a password is whatever was typed, spaces included.
export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

/** POST /auth/change-password. The current password is required even though the caller holds a token. */
export const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  new_password: passwordSchema,
}).strict();

/** POST /employees/:id/temporary-password. */
export const resetPasswordSchema = z.object({
  temporary_password: passwordSchema,
}).strict();
