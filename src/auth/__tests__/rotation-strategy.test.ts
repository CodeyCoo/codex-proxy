import { describe, it, expect } from "vitest";
import { getRotationStrategy } from "../rotation-strategy.js";
import type { RotationState } from "../rotation-strategy.js";
import type { AccountEntry } from "../types.js";

import type { CodexQuota } from "../types.js";

function makeEntry(
  id: string,
  overrides?: Partial<AccountEntry["usage"]>,
  quota?: Partial<CodexQuota> | null,
): AccountEntry {
  return {
    id,
    token: `tok-${id}`,
    refreshToken: null,
    email: `${id}@test.com`,
    accountId: `acct-${id}`,
    userId: `user-${id}`,
    label: null,
    planType: "free",
    proxyApiKey: `key-${id}`,
    status: "active",
    usage: {
      request_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      empty_response_count: 0,
      last_used: null,
      rate_limit_until: null,
      window_request_count: 0,
      window_input_tokens: 0,
      window_output_tokens: 0,
      window_counters_reset_at: null,
      limit_window_seconds: null,
      ...overrides,
    },
    addedAt: new Date().toISOString(),
    cachedQuota: quota ? {
      plan_type: "free",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        used_percent: null,
        reset_at: null,
        limit_window_seconds: null,
        ...quota.rate_limit,
      },
      secondary_rate_limit: null,
      code_review_rate_limit: null,
      ...quota,
    } as CodexQuota : null,
    quotaFetchedAt: null,
  };
}

describe("rotation-strategy", () => {
  describe("least_used", () => {
    const strategy = getRotationStrategy("least_used");
    const state: RotationState = { roundRobinIndex: 0, lastSelectedId: null };

    it("prefers account with earliest window_reset_at (use-before-refresh)", () => {
      // B resets in 1 day, A resets in 7 days — should pick B even though A has fewer requests
      const a = makeEntry("a", { request_count: 2, window_reset_at: Date.now() + 7 * 86400_000 });
      const b = makeEntry("b", { request_count: 8, window_reset_at: Date.now() + 1 * 86400_000 });
      expect(strategy.select([a, b], state).id).toBe("b");
    });

    it("does not penalize new accounts without window_reset_at — falls through to request_count", () => {
      // Account A is brand-new (no window info yet), account B has a known window.
      // A has fewer requests so it should win: null window must not count as Infinity.
      const a = makeEntry("a", { request_count: 1 }); // no window info
      const b = makeEntry("b", { request_count: 5, window_reset_at: Date.now() + 86400_000 });
      expect(strategy.select([a, b], state).id).toBe("a");
    });

    it("falls through to request_count when both accounts have no window_reset_at", () => {
      const a = makeEntry("a", { request_count: 3 });
      const b = makeEntry("b", { request_count: 1 });
      expect(strategy.select([a, b], state).id).toBe("b");
    });

    it("prefers fewer active sessions over all other metrics", () => {
      // A has better used_percent but more active sessions
      const a = makeEntry("a", { window_request_count: 5 },
        { rate_limit: { allowed: true, limit_reached: false, used_percent: 10, reset_at: null, limit_window_seconds: null } });
      const b = makeEntry("b", { window_request_count: 50 },
        { rate_limit: { allowed: true, limit_reached: false, used_percent: 80, reset_at: null, limit_window_seconds: null } });
      const sessionCounts = new Map([["a", 5], ["b", 0]]);
      expect(strategy.select([a, b], state, sessionCounts).id).toBe("b");
    });

    it("falls through to used_percent when session counts are equal", () => {
      const a = makeEntry("a", {},
        { rate_limit: { allowed: true, limit_reached: false, used_percent: 60, reset_at: null, limit_window_seconds: null } });
      const b = makeEntry("b", {},
        { rate_limit: { allowed: true, limit_reached: false, used_percent: 20, reset_at: null, limit_window_seconds: null } });
      const sessionCounts = new Map([["a", 2], ["b", 2]]);
      expect(strategy.select([a, b], state, sessionCounts).id).toBe("b");
    });

    it("ignores session counts when not provided (existing conversation)", () => {
      // Without sessionCounts, should fall through to used_percent
      const a = makeEntry("a", {},
        { rate_limit: { allowed: true, limit_reached: false, used_percent: 10, reset_at: null, limit_window_seconds: null } });
      const b = makeEntry("b", {},
        { rate_limit: { allowed: true, limit_reached: false, used_percent: 80, reset_at: null, limit_window_seconds: null } });
      // No sessionCounts passed — should pick a (lower used_percent)
      expect(strategy.select([a, b], state).id).toBe("a");
    });

    it("prefers lower window_request_count over lower cumulative request_count", () => {
      // A has fewer cumulative requests but more in the current window
      const a = makeEntry("a", { request_count: 10, window_request_count: 80 });
      const b = makeEntry("b", { request_count: 200, window_request_count: 5 });
      expect(strategy.select([a, b], state).id).toBe("b");
    });

    it("prefers lower used_percent even with more window requests (sync-exhaust)", () => {
      // A has fewer window requests but higher used_percent (small quota)
      const a = makeEntry("a", { window_request_count: 10 },
        { rate_limit: { allowed: true, limit_reached: false, used_percent: 60, reset_at: null, limit_window_seconds: null } });
      const b = makeEntry("b", { window_request_count: 50 },
        { rate_limit: { allowed: true, limit_reached: false, used_percent: 15, reset_at: null, limit_window_seconds: null } });
      expect(strategy.select([a, b], state).id).toBe("b");
    });

    it("does not penalize accounts without quota data", () => {
      const noQuota = makeEntry("a", { window_request_count: 5 }); // no cachedQuota
      const withQuota = makeEntry("b", { window_request_count: 5 },
        { rate_limit: { allowed: true, limit_reached: false, used_percent: 30, reset_at: null, limit_window_seconds: null } });
      // a has no quota → used_percent defaults to 0, so it should win over b with used_percent=30
      expect(strategy.select([noQuota, withQuota], state).id).toBe("a");
    });

    it("falls back to request_count when window_request_count is unavailable", () => {
      const a = makeEntry("a", { request_count: 50 }); // no window data
      const b = makeEntry("b", { request_count: 10 }); // no window data
      expect(strategy.select([a, b], state).id).toBe("b");
    });

    it("breaks reset ties by request_count (fewer wins)", () => {
      const reset = Date.now() + 86400_000;
      const a = makeEntry("a", { request_count: 5, window_reset_at: reset });
      const b = makeEntry("b", { request_count: 2, window_reset_at: reset });
      expect(strategy.select([a, b], state).id).toBe("b");
    });

    it("breaks further ties by last_used (LRU)", () => {
      const reset = Date.now() + 86400_000;
      const a = makeEntry("a", { request_count: 3, window_reset_at: reset, last_used: "2026-01-02T00:00:00Z" });
      const b = makeEntry("b", { request_count: 3, window_reset_at: reset, last_used: "2026-01-01T00:00:00Z" });
      expect(strategy.select([a, b], state).id).toBe("b");
    });

    it("deprioritizes exhausted accounts (limit_reached) even with earlier reset", () => {
      const exhausted = makeEntry(
        "exhausted",
        { request_count: 0, window_reset_at: Date.now() + 1 * 86400_000 },
        { rate_limit: { allowed: true, limit_reached: true, used_percent: 100, reset_at: null, limit_window_seconds: null } },
      );
      const healthy = makeEntry(
        "healthy",
        { request_count: 5, window_reset_at: Date.now() + 7 * 86400_000 },
        { rate_limit: { allowed: true, limit_reached: false, used_percent: 30, reset_at: null, limit_window_seconds: null } },
      );
      expect(strategy.select([exhausted, healthy], state).id).toBe("healthy");
    });

    it("sorts exhausted accounts among themselves by reset time", () => {
      const a = makeEntry(
        "a",
        { window_reset_at: Date.now() + 3 * 86400_000 },
        { rate_limit: { allowed: true, limit_reached: true, used_percent: 100, reset_at: null, limit_window_seconds: null } },
      );
      const b = makeEntry(
        "b",
        { window_reset_at: Date.now() + 1 * 86400_000 },
        { rate_limit: { allowed: true, limit_reached: true, used_percent: 100, reset_at: null, limit_window_seconds: null } },
      );
      expect(strategy.select([a, b], state).id).toBe("b");
    });

    it("treats accounts without cached quota as non-exhausted", () => {
      const noQuota = makeEntry("noQuota", { request_count: 2, window_reset_at: Date.now() + 7 * 86400_000 });
      const exhausted = makeEntry(
        "exhausted",
        { request_count: 0, window_reset_at: Date.now() + 1 * 86400_000 },
        { rate_limit: { allowed: true, limit_reached: true, used_percent: 100, reset_at: null, limit_window_seconds: null } },
      );
      expect(strategy.select([exhausted, noQuota], state).id).toBe("noQuota");
    });
  });

  describe("round_robin", () => {
    const strategy = getRotationStrategy("round_robin");

    it("cycles through candidates in sorted ID order", () => {
      const state: RotationState = { roundRobinIndex: 0, lastSelectedId: null };
      const a = makeEntry("a");
      const b = makeEntry("b");
      const c = makeEntry("c");
      // Pass in unsorted order to verify sorting
      const candidates = [c, a, b];

      expect(strategy.select(candidates, state).id).toBe("a");
      expect(strategy.select(candidates, state).id).toBe("b");
      expect(strategy.select(candidates, state).id).toBe("c");
      expect(strategy.select(candidates, state).id).toBe("a"); // wraps
    });

    it("skips to next when last selected is removed from pool", () => {
      const state: RotationState = { roundRobinIndex: 0, lastSelectedId: null };
      const a = makeEntry("a");
      const b = makeEntry("b");
      const c = makeEntry("c");

      expect(strategy.select([a, b, c], state).id).toBe("a");
      expect(strategy.select([a, b, c], state).id).toBe("b");
      // B is removed — should pick C (next after B), not A
      expect(strategy.select([a, c], state).id).toBe("c");
      expect(strategy.select([a, c], state).id).toBe("a"); // wraps
    });

    it("wraps around when last selected was the final entry", () => {
      const state: RotationState = { roundRobinIndex: 0, lastSelectedId: "c" };
      const a = makeEntry("a");
      const b = makeEntry("b");
      // last was "c", no ID > "c" → wraps to "a"
      expect(strategy.select([a, b], state).id).toBe("a");
    });
  });

  describe("sticky (delegates to least_used)", () => {
    const strategy = getRotationStrategy("sticky");
    const state: RotationState = { roundRobinIndex: 0, lastSelectedId: null };

    it("behaves like least_used — prefers fewer window requests", () => {
      const a = makeEntry("a", { request_count: 10, window_request_count: 50 });
      const b = makeEntry("b", { request_count: 100, window_request_count: 5 });
      expect(strategy.select([a, b], state).id).toBe("b");
    });

    it("behaves like least_used — LRU as tiebreaker", () => {
      const a = makeEntry("a", { last_used: "2026-01-03T00:00:00Z" });
      const b = makeEntry("b", { last_used: "2026-01-01T00:00:00Z" });
      expect(strategy.select([a, b], state).id).toBe("b");
    });
  });

  it("getRotationStrategy returns distinct strategy objects per name", () => {
    const lu = getRotationStrategy("least_used");
    const rr = getRotationStrategy("round_robin");
    const st = getRotationStrategy("sticky");
    expect(lu).not.toBe(rr);
    expect(rr).not.toBe(st);
  });

  it("select does not mutate the input candidates array", () => {
    const strategy = getRotationStrategy("least_used");
    const state: RotationState = { roundRobinIndex: 0, lastSelectedId: null };
    const a = makeEntry("a", { request_count: 5 });
    const b = makeEntry("b", { request_count: 2 });
    const c = makeEntry("c", { request_count: 8 });
    const candidates = [a, b, c];
    strategy.select(candidates, state);
    // Original order preserved
    expect(candidates.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });
});
