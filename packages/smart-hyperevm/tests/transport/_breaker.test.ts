import { describe, expect, test } from "bun:test";
import { HttpRequestError } from "viem";

import { Breaker, type BreakerConfig, retryAfterMs } from "../../src/transport/_breaker.ts";
import { Scoreboard } from "../../src/transport/_scoreboard.ts";

const config: BreakerConfig = { enabled: true, threshold: 3, cooldownMs: 1_000, maxCooldownMs: 4_000 };

describe("Breaker", () => {
  test("ejects after consecutive failures and doubles the cooldown up to the cap", () => {
    let nowMs = 0;
    const breaker = new Breaker(config, () => nowMs);
    expect(breaker.failure("a")).toBeUndefined();
    expect(breaker.failure("a")).toBeUndefined();
    expect(breaker.failure("a")).toEqual({ failures: 3, cooldownMs: 1_000 });
    expect(breaker.isOpen("a")).toBe(true);
    expect(breaker.remaining("a")).toBe(1_000);
    expect(breaker.failure("a")).toBeUndefined();
    nowMs = 1_000;
    expect(breaker.isOpen("a")).toBe(false);
    expect(breaker.failure("a")).toEqual({ failures: 5, cooldownMs: 2_000 });
    nowMs = 3_000;
    expect(breaker.failure("a")).toEqual({ failures: 6, cooldownMs: 4_000 });
    nowMs = 7_000;
    expect(breaker.failure("a")).toEqual({ failures: 7, cooldownMs: 4_000 });
  });

  test("a success closes the circuit and resets the count", () => {
    const breaker = new Breaker(config, () => 0);
    breaker.failure("a");
    breaker.failure("a");
    expect(breaker.success("a")).toBe(false);
    breaker.failure("a");
    breaker.failure("a");
    expect(breaker.isOpen("a")).toBe(false);
    breaker.failure("a");
    expect(breaker.isOpen("a")).toBe(true);
    expect(breaker.success("a")).toBe(true);
    expect(breaker.isOpen("a")).toBe(false);
  });

  test("a probe success clears a streak of probe failures but not one that holds a failed call", () => {
    const breaker = new Breaker(config, () => 0);
    breaker.failure("a", 0, true);
    breaker.failure("a", 0, true);
    expect(breaker.success("a", true)).toBe(false);
    breaker.failure("a", 0, true);
    breaker.failure("a", 0, true);
    expect(breaker.isOpen("a")).toBe(false);

    breaker.failure("b");
    breaker.success("b", true);
    breaker.failure("b", 0, true);
    breaker.success("b", true);
    expect(breaker.failure("b")).toEqual({ failures: 3, cooldownMs: 1_000 });
    expect(breaker.success("b", true)).toBe(false);
    expect(breaker.isOpen("b")).toBe(true);
    expect(breaker.success("b")).toBe(true);
    expect(breaker.isOpen("b")).toBe(false);
  });

  test("Retry-After ejects at once, capped at the max cooldown", () => {
    const breaker = new Breaker(config, () => 0);
    expect(breaker.failure("a", 2_500)).toEqual({ failures: 1, cooldownMs: 2_500 });
    expect(breaker.failure("b", 90_000)).toEqual({ failures: 1, cooldownMs: 4_000 });
  });

  test("disabled never ejects", () => {
    const breaker = new Breaker({ ...config, enabled: false }, () => 0);
    for (let index = 0; index < 10; index += 1) expect(breaker.failure("a", 5_000)).toBeUndefined();
    expect(breaker.isOpen("a")).toBe(false);
    expect(breaker.success("a")).toBe(false);
  });
});

describe("retryAfterMs", () => {
  test("reads seconds and HTTP dates from viem's HttpRequestError", () => {
    const seconds = new HttpRequestError({
      url: "https://a.test",
      status: 429,
      headers: new Headers({ "Retry-After": "7" }),
    });
    expect(retryAfterMs(seconds)).toBe(7_000);
    const now = Date.parse("2026-01-01T00:00:00Z");
    const dated = new HttpRequestError({
      url: "https://a.test",
      status: 429,
      headers: new Headers({ "Retry-After": "Thu, 01 Jan 2026 00:00:12 GMT" }),
    });
    expect(retryAfterMs(dated, now)).toBe(12_000);
    const wrapped = new Error("outer", { cause: seconds });
    expect(retryAfterMs(wrapped)).toBe(7_000);
    expect(retryAfterMs(new HttpRequestError({ url: "https://a.test", status: 429, headers: new Headers() }))).toBe(0);
    expect(retryAfterMs(new Error("plain"))).toBe(0);
  });
});

describe("Scoreboard with ejected endpoints", () => {
  const endpoints = ["a", "b"].map((id, index) => ({ id, url: id, weight: 1, index, supports: (): boolean => true }));

  test("pick skips ejected endpoints unless every candidate is ejected", () => {
    let ejected = new Set(["a"]);
    const board = new Scoreboard(endpoints, {
      perMethod: true,
      headLag: false,
      maxLag: 2,
      staleMs: 30_000,
      now: () => 0,
      ejected: (id: string): boolean => ejected.has(id),
    });
    expect(board.pick("eth_call", new Set(), "best", Math.random)?.id).toBe("b");
    expect(board.pick("eth_call", new Set(), "p2c", () => 0)?.id).toBe("b");
    ejected = new Set(["a", "b"]);
    expect(board.pick("eth_call", new Set(), "best", Math.random)?.id).toBe("a");
    expect(board.pick("eth_call", new Set(["a"]), "best", Math.random)?.id).toBe("b");
  });
});
