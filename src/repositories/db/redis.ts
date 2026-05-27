import { Redis } from "ioredis";
import { env } from "../../services/config/env.js";

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true
});
redis.on("error", () => {});
