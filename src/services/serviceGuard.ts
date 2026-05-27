import { redis } from "../repositories/db/redis.js";

const DEFAULT_FAILURE_LIMIT = 3;
const DEFAULT_COOLDOWN_SECONDS = 10 * 60;

function failureKey(service: string) {
  return `service-guard:${service}:failures`;
}

function cooldownKey(service: string) {
  return `service-guard:${service}:cooldown`;
}

export async function assertServiceConfigured(service: string, configured: boolean, message: string) {
  if (configured) return;
  await redis.set(cooldownKey(service), message, "EX", DEFAULT_COOLDOWN_SECONDS).catch(() => undefined);
  throw new Error(message);
}

export async function assertServiceAllowed(service: string, configured: boolean, message: string) {
  await assertServiceConfigured(service, configured, message);
  const cooldown = await redis.get(cooldownKey(service)).catch(() => null);
  if (cooldown) throw new Error(`${service} temporarily disabled after repeated failures: ${cooldown}`);
}

export async function recordServiceSuccess(service: string) {
  await Promise.all([
    redis.del(failureKey(service)).catch(() => undefined),
    redis.del(cooldownKey(service)).catch(() => undefined)
  ]);
}

export async function recordServiceFailure(
  service: string,
  error: unknown,
  options: { failureLimit?: number; cooldownSeconds?: number } = {}
) {
  const message = error instanceof Error ? error.message : String(error);
  const failures = await redis.incr(failureKey(service)).catch(() => 1);
  await redis.expire(failureKey(service), options.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS).catch(() => undefined);
  if (failures >= (options.failureLimit ?? DEFAULT_FAILURE_LIMIT)) {
    await redis.set(cooldownKey(service), message, "EX", options.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS).catch(() => undefined);
  }
}

export async function guardedExternalCall<T>(
  service: string,
  configured: boolean,
  notConfiguredMessage: string,
  operation: () => Promise<T>,
  options: { failureLimit?: number; cooldownSeconds?: number } = {}
) {
  await assertServiceAllowed(service, configured, notConfiguredMessage);
  try {
    const result = await operation();
    await recordServiceSuccess(service);
    return result;
  } catch (error) {
    await recordServiceFailure(service, error, options);
    throw error;
  }
}
