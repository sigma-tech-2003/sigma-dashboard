import { z } from "zod";
import { USER_ROLES } from "../utils/roles.js";

export const userRoleSchema = z.enum(USER_ROLES);
export const uuidSchema = z.string().uuid();
