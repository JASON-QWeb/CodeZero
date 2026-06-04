import { afterEach, describe, expect, it } from "vitest";
import {
  CircuitBreakerOpenError,
  getCircuitBreaker,
  resetCircuitBreakersForTests,
} from "@agent/shared";

describe("circuit breaker", () => {
  afterEach(() => {
    resetCircuitBreakersForTests();
  });

  it("opens after repeated trip-worthy failures and recovers after reset", async () => {
    const breaker = getCircuitBreaker("test-service", {
      failureThreshold: 2,
      resetTimeoutMs: 10,
      shouldTrip: () => true,
    });

    await expect(
      breaker.run(() => Promise.reject(new Error("down"))),
    ).rejects.toThrow("down");
    await expect(
      breaker.run(() => Promise.reject(new Error("down"))),
    ).rejects.toThrow("down");
    await expect(
      breaker.run(() => Promise.resolve("ok")),
    ).rejects.toBeInstanceOf(CircuitBreakerOpenError);

    await new Promise((resolve) => setTimeout(resolve, 15));
    await expect(breaker.run(() => Promise.resolve("ok"))).resolves.toBe("ok");
    expect(breaker.snapshot().state).toBe("closed");
  });

  it("does not trip on failures marked non-transient", async () => {
    const breaker = getCircuitBreaker("validation-service", {
      failureThreshold: 1,
      shouldTrip: () => false,
    });

    await expect(
      breaker.run(() => Promise.reject(new Error("validation"))),
    ).rejects.toThrow("validation");
    await expect(breaker.run(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });
});
