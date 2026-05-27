import { z } from "zod";

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

export const profileSchema = z.object({
  username: z.string().min(1),
  displayName: z.string().optional()
});

export const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8)
});

export const apiKeySchema = z.object({
  name: z.string().min(1)
});

export const adminUserCreateSchema = z.object({
  username: z.string().min(1),
  displayName: z.string().optional(),
  password: z.string().min(8),
  isAdmin: z.boolean().default(false),
  mustChangePassword: z.boolean().default(true)
});

export const adminUserUpdateSchema = z.object({
  username: z.string().min(1).optional(),
  displayName: z.string().optional(),
  isAdmin: z.boolean().optional(),
  mustChangePassword: z.boolean().optional()
});

export const adminPasswordResetSchema = z.object({
  newPassword: z.string().min(8)
});
