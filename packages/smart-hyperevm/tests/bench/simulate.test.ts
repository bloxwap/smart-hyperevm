import { describe, expect, test } from "bun:test";

import { runSimulation, type Series } from "../../.dev/bench/simulate.ts";

function series(rows: Series[], label: string): Series {
  const found = rows.find((row) => row.label === label);
  if (!found) throw new Error(`missing series ${label}`);
  return found;
}

describe("fallback simulation", () => {
  test(
    "virtual clocks stay on the published numbers, and the hedge study keeps its shape",
    async () => {
      const report = await runSimulation();
      expect(report.calls).toBe(120);

      const deadFallback = series(report.deadFirst, "fallback");
      const deadP2c = series(report.deadFirst, "hyperevm p2c");
      const deadBest = series(report.deadFirst, "hyperevm best");
      expect(deadFallback).toMatchObject({ median: 52, p95: 156, p99: 156, errors: 0, failovers: 120, staleRate: 0 });
      expect(deadFallback.busiestShare).toBeCloseTo(0.5, 10);
      expect(deadP2c).toMatchObject({ median: 72, p95: 288, p99: 480, errors: 0, failovers: 0, staleRate: 0 });
      expect(deadP2c.busiestShare).toBeCloseTo(70 / 120, 10);
      expect(deadBest).toMatchObject({
        median: 40,
        p95: 120,
        p99: 120,
        errors: 0,
        failovers: 0,
        staleRate: 0,
        busiestShare: 1,
      });
      expect(seriesMethod(deadBest, "eth_call").median).toBe(40);
      expect(seriesMethod(deadBest, "eth_call batch").median).toBe(120);
      expect(seriesMethod(deadBest, "eth_getLogs").median).toBe(72);

      const staleFallback = series(report.staleHead, "fallback");
      const staleRanked = series(report.staleHead, "fallback after one ping sort");
      const staleP2c = series(report.staleHead, "hyperevm p2c");
      const staleBest = series(report.staleHead, "hyperevm best");
      const lagWeight = series(report.staleHead, "hyperevm p2c lagWeight 2");
      const moreTail = series(report.staleHead, "hyperevm p2c latencyMix 0.4");
      expect(staleFallback).toMatchObject({ median: 34, p99: 102, errors: 0, failovers: 120, staleRate: 1 });
      expect(staleRanked).toMatchObject({
        median: 22,
        p99: 66,
        errors: 0,
        failovers: 0,
        staleRate: 1,
        busiestShare: 1,
      });
      expect(staleP2c).toMatchObject({ median: 85, p95: 255, p99: 390, errors: 0, failovers: 5 });
      expect(staleP2c.staleRate).toBeCloseTo(31 / 120, 10);
      expect(staleP2c.busiestShare).toBeCloseTo(68 / 125, 10);
      expect(staleBest).toMatchObject({ median: 85, p95: 255, p99: 255, errors: 0, failovers: 0, staleRate: 0 });
      expect(staleBest.busiestShare).toBeCloseTo(118 / 120, 10);
      expect(seriesMethod(staleBest, "eth_getLogs").median).toBe(153);
      expect(seriesMethod(staleP2c, "eth_call").staleRate).toBeCloseTo(7 / 48, 10);
      expect(lagWeight.median).toBe(staleP2c.median);
      expect(lagWeight.p99).toBe(staleP2c.p99);
      expect(lagWeight.staleRate).toBe(staleP2c.staleRate);
      expect(moreTail.staleRate).toBeGreaterThan(staleP2c.staleRate);

      expect(report.hedge.off.errors).toBe(0);
      expect(report.hedge.on.errors).toBe(0);
      expect(report.hedge.off.attempts).toBe(20);
      expect(report.hedge.on.attempts).toBeGreaterThan(report.hedge.off.attempts);
      expect(report.hedge.on.attempts).toBeLessThan(report.hedge.off.attempts * 2);
      expect(report.hedge.off.p99).toBeGreaterThan(150);
      expect(report.hedge.on.p99).toBeLessThan(report.hedge.off.p99);
    },
    { timeout: 20_000 },
  );
});

function seriesMethod(row: Series, method: string): { median: number; staleRate: number } {
  const found = row.methods.find((item) => item.method === method);
  if (!found) throw new Error(`missing method ${method}`);
  return found;
}
