import { toPublicRelease } from "../services/releases/public.js";

export function publicProvider(provider: Record<string, unknown> | null | undefined) {
  if (!provider) return provider;
  const { apiKey, ...safeProvider } = provider;
  void apiKey;
  return safeProvider;
}

export function publicRequest<T>(request: T): T {
  if (!request || typeof request !== "object") return request;
  const typed = request as { provider?: Record<string, unknown>; selectedRelease?: unknown };
  return {
    ...request,
    provider: publicProvider(typed.provider),
    selectedRelease:
      typed.selectedRelease && typeof typed.selectedRelease === "object"
        ? toPublicRelease(typed.selectedRelease as Parameters<typeof toPublicRelease>[0])
        : typed.selectedRelease
  };
}

export function publicResult<T>(value: T): T {
  if (Array.isArray(value)) return value.map(publicResult) as T;
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = key === "release" && item && typeof item === "object" ? toPublicRelease(item as Parameters<typeof toPublicRelease>[0]) : publicResult(item);
  }
  return output as T;
}
