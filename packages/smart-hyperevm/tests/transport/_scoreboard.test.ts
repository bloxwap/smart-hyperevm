import { describe, expect, test } from "bun:test";

import { defaultScoreConfig } from "../../src/transport/_score.ts";
import { Scoreboard, blockNumberFromResult } from "../../src/transport/_scoreboard.ts";

function board(ids: readonly string[], clock: { now: number }, maxAhead?: number): Scoreboard {
  return new Scoreboard(
    ids.map((id, index) => ({ id, url: id, weight: 1, index, supports: () => true })),
    {
      perMethod: false,
      headLag: true,
      maxLag: 2,
      staleMs: 30_000,
      maxAhead,
      now: () => clock.now,
      config: defaultScoreConfig,
    },
  );
}

function row(target: Scoreboard, id: string) {
  const found = target.snapshot("eth_call").find((item) => item.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

describe("Scoreboard heads", () => {
  test("one endpoint reporting 0xffffffff does not become the reference head", () => {
    const clock = { now: 1_000 };
    const target = board(["a", "b", "liar"], clock);
    target.noteHead("a", 1_000);
    target.noteHead("b", 999);
    const liar = target.noteHead("liar", 0xffffffff);
    expect(liar.trusted).toBe(false);
    expect(liar.best).toBe(1_000);
    expect(row(target, "a").lag).toBe(0);
    expect(row(target, "b").lag).toBe(1);
    expect(row(target, "liar").lag).toBeNull();
    expect(row(target, "liar").score).toBeGreaterThan(row(target, "a").score * 1_000);
  });

  test("the liar loses every pick, under best and under p2c", () => {
    const clock = { now: 1_000 };
    const target = board(["liar", "a", "b"], clock);
    target.noteHead("liar", 0xffffffff);
    target.noteHead("a", 1_000);
    target.noteHead("b", 1_000);
    const none = new Set<string>();
    expect(target.pick("eth_call", none, "best", () => 0)?.id).not.toBe("liar");
    let seed = 0;
    const random = (): number => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    for (let index = 0; index < 200; index += 1) {
      expect(target.pick("eth_call", none, "p2c", random)?.id).not.toBe("liar");
    }
    expect(target.pick("eth_call", new Set(["a", "b"]), "best", () => 0)?.id).toBe("liar");
  });

  test("two endpoints that disagree by more than maxAhead leave no reference", () => {
    const clock = { now: 1_000 };
    const target = board(["honest", "liar"], clock);
    target.noteHead("honest", 1_000);
    const liar = target.noteHead("liar", 0xffffffff);
    expect(liar.trusted).toBe(false);
    expect(row(target, "honest").lag).toBeNull();
    expect(row(target, "liar").lag).toBeNull();
    expect(row(target, "liar").score).toBe(row(target, "honest").score);
  });

  test("a legitimate lead within maxAhead is still the reference", () => {
    const clock = { now: 1_000 };
    const target = board(["behind", "ahead"], clock);
    target.noteHead("behind", 100);
    const ahead = target.noteHead("ahead", 110);
    expect(ahead.trusted).toBe(true);
    expect(row(target, "behind").lag).toBe(10);
    expect(row(target, "behind").score).toBeGreaterThan(row(target, "ahead").score);
  });

  test("an advancing chain moves the reference as time passes", () => {
    const clock = { now: 0 };
    const target = board(["a", "b", "c"], clock, 5);
    target.noteHead("a", 100);
    target.noteHead("b", 100);
    target.noteHead("c", 100);
    clock.now = 10_000;
    // Ten seconds of blocks is beyond maxAhead, but the older heads are carried forward first.
    const a = target.noteHead("a", 112);
    expect(a.trusted).toBe(true);
    expect(a.best).toBe(112);
    expect(row(target, "b").lag).toBe(12);
    target.noteHead("b", 112);
    target.noteHead("c", 111);
    expect(row(target, "b").lag).toBe(0);
    expect(row(target, "c").lag).toBe(1);
  });

  test("a jump faster than the chain can grow is ignored", () => {
    const clock = { now: 0 };
    const target = board(["a", "b", "c"], clock, 5);
    target.noteHead("a", 100);
    target.noteHead("b", 100);
    clock.now = 1_000;
    const jump = target.noteHead("c", 200);
    expect(jump.trusted).toBe(false);
    expect(jump.best).toBe(100);
    expect(row(target, "a").lag).toBe(0);
  });

  test("a stale liar stops counting once its head ages out", () => {
    const clock = { now: 0 };
    const target = board(["a", "b", "liar"], clock);
    target.noteHead("liar", 0xffffffff);
    clock.now = 31_000;
    target.noteHead("a", 1_000);
    target.noteHead("b", 1_000);
    expect(row(target, "a").lag).toBe(0);
    expect(row(target, "liar").lag).toBe(0);
  });
});

describe("Scoreboard in-flight calls", () => {
  test("expired calls are collected even when a lone endpoint is never scored", () => {
    const clock = { now: 0 };
    const target = board(["only"], clock);
    for (let index = 0; index < 1_000; index += 1) target.begin("only", 100);
    clock.now += 200;
    for (let index = 0; index < 1_000; index += 1) {
      expect(target.pick("eth_call", new Set(), "best", Math.random)?.id).toBe("only");
      target.begin("only", 100)();
    }
    expect(target.held("only")).toBe(0);
  });
});

describe("blockNumberFromResult", () => {
  test("reads eth_blockNumber and a latest eth_getBlockByNumber", () => {
    expect(blockNumberFromResult("eth_blockNumber", "0x10")).toBe(16);
    expect(blockNumberFromResult("eth_getBlockByNumber", { number: "0x20" }, ["latest", false])).toBe(32);
  });

  test("ignores historical blocks and blocks by hash", () => {
    expect(blockNumberFromResult("eth_getBlockByNumber", { number: "0x10" }, ["0x10", false])).toBeNull();
    expect(blockNumberFromResult("eth_getBlockByNumber", { number: "0x10" }, ["earliest", false])).toBeNull();
    expect(blockNumberFromResult("eth_getBlockByNumber", { number: "0x10" }, ["finalized", false])).toBeNull();
    expect(blockNumberFromResult("eth_getBlockByNumber", { number: "0x10" })).toBeNull();
    expect(blockNumberFromResult("eth_getBlockByHash", { number: "0x10" }, ["0xabc", false])).toBeNull();
  });
});
