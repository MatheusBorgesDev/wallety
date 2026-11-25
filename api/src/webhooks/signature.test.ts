import { describe, it, expect } from "vitest";
import { signPayload, verifySignature } from "./signature.js";

const secret = "test-signing-secret-with-enough-length";
const body = '{"id":"evt-1","type":"transfer.posted"}';
const signedAt = 1_800_000_000;

describe("webhook signature", () => {
  it("produces a header with the timestamp and an HMAC-SHA256 of timestamp.body", () => {
    expect(signPayload(secret, signedAt, body)).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
  });

  it("verifies a payload signed with the same secret", () => {
    const header = signPayload(secret, signedAt, body);
    expect(verifySignature({ secret, header, body, nowSeconds: signedAt + 10 })).toEqual({ valid: true });
  });

  it("rejects a body changed by a single byte", () => {
    const header = signPayload(secret, signedAt, body);
    const tampered = body.replace("evt-1", "evt-2");
    expect(verifySignature({ secret, header, body: tampered, nowSeconds: signedAt })).toEqual({
      valid: false,
      reason: "signature mismatch",
    });
  });

  it("rejects a signature made with another secret", () => {
    const header = signPayload("another-secret-with-enough-length!!", signedAt, body);
    expect(verifySignature({ secret, header, body, nowSeconds: signedAt }).valid).toBe(false);
  });

  it("rejects a delivery replayed outside the tolerance window", () => {
    const header = signPayload(secret, signedAt, body);
    expect(verifySignature({ secret, header, body, nowSeconds: signedAt + 301 })).toEqual({
      valid: false,
      reason: "timestamp outside tolerance",
    });
    expect(verifySignature({ secret, header, body, nowSeconds: signedAt - 301 }).valid).toBe(false);
  });

  it("rejects a timestamp moved without re-signing", () => {
    const header = signPayload(secret, signedAt, body).replace("t=1800000000", "t=1800000100");
    expect(verifySignature({ secret, header, body, nowSeconds: signedAt + 100 })).toEqual({
      valid: false,
      reason: "signature mismatch",
    });
  });

  it.each([undefined, "", "garbage", "t=abc,v1=00", "v1=00", "t=1800000000"])(
    "rejects a malformed header: %s",
    (header) => {
      expect(verifySignature({ secret, header, body, nowSeconds: signedAt })).toEqual({
        valid: false,
        reason: "malformed signature header",
      });
    },
  );
});
