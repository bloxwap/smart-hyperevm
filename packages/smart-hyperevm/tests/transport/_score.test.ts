import { describe, expect, test } from "bun:test";

import { Scoreboard } from "../../src/transport/_scoreboard.ts";
import {
  defaultScoreConfig,
  emptyStat,
  endpointScore,
  inflation,
  observe,
  serviceMs,
} from "../../src/transport/_score.ts";

describe("endpointScore", () => {
  test("inflation grows with in-flight calls and includes a squared queue term", () => {
    expect(inflation(0)).toBe(1);
    expect(inflation(1)).toBeCloseTo(2.25);
    expect(inflation(2)).toBeGreaterThan(inflation(1));
    expect(inflation(4) - inflation(2)).toBeGreaterThan(inflation(2) - inflation(0));
  });

  test("a slower sample, an error, lag, and lower weight each worsen the score", () => {
    const fast = emptyStat();
    const slow = emptyStat();
    observe(fast, 40, true);
    observe(slow, 400, true);
    const base = { perMethod: false, inflight: 0, lagPenalty: 1, weight: 1 };
    expect(endpointScore({ ...base, global: slow, method: undefined })).toBeGreaterThan(
      endpointScore({ ...base, global: fast, method: undefined }),
    );

    const failing = emptyStat();
    observe(failing, 40, false);
    expect(endpointScore({ ...base, global: failing, method: undefined })).toBeGreaterThan(
      endpointScore({ ...base, global: fast, method: undefined }),
    );

    expect(endpointScore({ ...base, global: fast, method: undefined, inflight: 3 })).toBeGreaterThan(
      endpointScore({ ...base, global: fast, method: undefined, inflight: 0 }),
    );
    expect(endpointScore({ ...base, global: fast, method: undefined, lagPenalty: 4 })).toBeGreaterThan(
      endpointScore({ ...base, global: fast, method: undefined, lagPenalty: 1 }),
    );
    expect(endpointScore({ ...base, global: fast, method: undefined, weight: 1 })).toBeGreaterThan(
      endpointScore({ ...base, global: fast, method: undefined, weight: 2 }),
    );
  });

  test("per-method stats take over once they have enough samples", () => {
    const global = emptyStat();
    observe(global, 50, true);
    const method = emptyStat();
    observe(method, 20, true);
    observe(method, 20, true);
    observe(method, 20, true);
    const shared = { global, perMethod: true, inflight: 0, lagPenalty: 1, weight: 1 };
    const blended = endpointScore({ ...shared, method });
    const onlyGlobal = endpointScore({ ...shared, method: undefined, perMethod: false });
    expect(blended).toBeLessThan(onlyGlobal);
    expect(serviceMs(method)).toBeLessThan(serviceMs(global));
  });

  test("the default alphas match a call that omits the config", () => {
    const implied = emptyStat();
    const explicit = emptyStat();
    observe(implied, 30, true);
    observe(explicit, 30, true, defaultScoreConfig);
    observe(implied, 90, true);
    observe(explicit, 90, true, defaultScoreConfig);
    expect(explicit).toEqual(implied);
  });

  test("a larger upward alpha moves the mean further", () => {
    const gentle = emptyStat();
    const sharp = emptyStat();
    observe(gentle, 40, true);
    observe(sharp, 40, true);
    observe(gentle, 200, true, { ...defaultScoreConfig, ewmaAlphaUp: 0.1 });
    observe(sharp, 200, true, { ...defaultScoreConfig, ewmaAlphaUp: 0.9 });
    expect(sharp.ewma).toBeGreaterThan(gentle.ewma);
  });

  test("lagWeight scales the penalty past maxLag", () => {
    const make = (lagWeight: number): number => {
      const board = new Scoreboard(
        [
          { id: "ahead", url: "ahead", weight: 1, index: 0, supports: () => true },
          { id: "behind", url: "behind", weight: 1, index: 1, supports: () => true },
        ],
        {
          perMethod: false,
          headLag: true,
          maxLag: 2,
          staleMs: 30_000,
          now: () => 1_000,
          config: { ...defaultScoreConfig, lagWeight },
        },
      );
      board.noteHead("ahead", 100);
      board.noteHead("behind", 90);
      const behind = board.snapshot("eth_call").find((row) => row.id === "behind");
      return behind?.score ?? 0;
    };
    expect(make(2)).toBeGreaterThan(make(1));
  });

  test("the tail remembers a slow sample longer than the mean", () => {
    const stat = emptyStat();
    observe(stat, 50, true);
    observe(stat, 50, true);
    observe(stat, 50, true);
    const before = stat.tail;
    observe(stat, 500, true);
    const spiked = stat.tail;
    observe(stat, 50, true);
    expect(spiked).toBeGreaterThan(before);
    expect(stat.tail).toBeGreaterThan(stat.ewma);
  });
});
