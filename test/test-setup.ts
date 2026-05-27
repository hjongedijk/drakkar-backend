import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

process.env.NODE_ENV ??= "test";
process.env.CONFIG_DIR ??= join(tmpdir(), `drakkar-test-config-${process.pid}`);
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:5432/drakkar";
process.env.REDIS_URL ??= "redis://127.0.0.1:6379";

const { prisma } = await import("../src/repositories/db/prisma.js");
const { redis } = await import("../src/repositories/db/redis.js");

after(async () => {
  await prisma.$disconnect().catch(() => undefined);
  if (redis.status === "end" || redis.status === "wait") {
    redis.disconnect();
    return;
  }
  await redis.quit().catch(() => {
    redis.disconnect();
  });
});
