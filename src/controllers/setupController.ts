import type { FastifyReply, FastifyRequest } from "fastify";
import { completeSetupSchema } from "../models/schemas/setupSchemas.js";
import { completeSetup, getSetupStatus } from "../services/setupService.js";

export async function getSetupStatusHandler() {
  return getSetupStatus();
}

export async function completeSetupHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await completeSetup(completeSetupSchema.parse(request.body ?? {}));
  if (result.conflict) {
    return reply.status(409).send({ message: "Setup is already completed." });
  }
  return { ok: true, status: result.status };
}
