import { z } from "zod";

export const ignoredTestSchema = z.object({
  path: z.string().min(1)
});

export const blocklistMatchSchema = z.object({
  guid: z.string().optional(),
  title: z.string().min(1)
});
