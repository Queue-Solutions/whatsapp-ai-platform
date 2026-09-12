import { createHmac, timingSafeEqual } from "node:crypto";
export function equalSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function validSignature(raw: Uint8Array, signature: string | null, secret: string): boolean {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  return equalSecret(signature, `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`);
}
