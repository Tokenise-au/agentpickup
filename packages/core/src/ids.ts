import { randomBytes } from "node:crypto";

export function newId(prefix: string, bytes = 9): string {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

// No 0/O, 1/I/L, so a code read aloud or typed from a phone screen survives.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Six-character code staff can type when a QR won't scan, e.g. "K7P4QX". */
export function newPickupCode(length = 6): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}
