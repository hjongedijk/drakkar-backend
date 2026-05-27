import type { FastifyReply, FastifyRequest } from "fastify";

export function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (request.authUser?.isAdmin) return true;
  void reply.status(403).send({ message: "Admin access required." });
  return false;
}
