import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, KEY_LENGTH);
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

export function verifyPassword(password: string, passwordHash?: string | null) {
  if (!passwordHash) return false;
  const [scheme, salt, stored] = passwordHash.split(":");
  if (scheme !== "scrypt" || !salt || !stored) return false;
  const expected = Buffer.from(stored, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
