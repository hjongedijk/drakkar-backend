import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { fetchReleaseCalendar } from "../services/releaseCalendarService.js";

const querySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  compact: z.coerce.boolean().optional()
});

export async function calendarRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/release-calendar", async (request) => {
    const query = querySchema.parse(request.query ?? {});
    return fetchReleaseCalendar(query.month, { compact: query.compact });
  });
}
