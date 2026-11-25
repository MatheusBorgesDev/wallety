import { createHmac, timingSafeEqual } from "node:crypto";

// Signature header: `t=<unix seconds>,v1=<hex>`, where the hex value is
// HMAC-SHA256(secret, "<t>.<body>"). The timestamp is signed together with the body,
// so a receiver can refuse an old delivery replayed by someone who captured it.
const HEADER_PATTERN = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/;

export const SIGNATURE_TOLERANCE_SECONDS = 300;

function hmac(secret: string, timestampSeconds: number, body: string): Buffer {
  return createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest();
}

export function signPayload(secret: string, timestampSeconds: number, body: string): string {
  return `t=${timestampSeconds},v1=${hmac(secret, timestampSeconds, body).toString("hex")}`;
}

export type SignatureCheck = { valid: true } | { valid: false; reason: string };

export function verifySignature(input: {
  secret: string;
  header: string | undefined;
  body: string;
  nowSeconds: number;
  toleranceSeconds?: number;
}): SignatureCheck {
  const match = HEADER_PATTERN.exec(input.header ?? "");
  if (!match) {
    return { valid: false, reason: "malformed signature header" };
  }
  const timestampSeconds = Number(match[1]);
  const received = Buffer.from(match[2]!, "hex");
  const expected = hmac(input.secret, timestampSeconds, input.body);
  // Constant-time comparison: the time taken must not reveal how many bytes matched.
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return { valid: false, reason: "signature mismatch" };
  }
  const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(input.nowSeconds - timestampSeconds) > tolerance) {
    return { valid: false, reason: "timestamp outside tolerance" };
  }
  return { valid: true };
}
