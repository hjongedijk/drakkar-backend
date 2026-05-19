import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    authUser?: {
      id: string;
      username: string;
      displayName: string;
      isAdmin: boolean;
    };
  }
}
