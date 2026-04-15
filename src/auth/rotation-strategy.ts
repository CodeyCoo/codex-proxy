/**
 * Rotation strategy — selection logic for AccountPool.
 *
 * "smart" strategy uses weighted scoring across 7 normalized dimensions.
 * Each single-dimension strategy uses only one dimension for selection.
 * "round_robin" cycles through accounts in stable ID order.
 * "sticky" and "least_used" are aliases for "smart" (backward compat).
 */

import type { AccountEntry } from "./types.js";

export type RotationStrategyName =
  | "smart"
  | "least_used"
  | "round_robin"
  | "sticky"
  | "by_sessions"
  | "by_exhausted"
  | "by_used_percent"
  | "by_reset_time"
  | "by_window_requests"
  | "by_request_count"
  | "by_lru";

export interface SmartWeights {
  sessions: number;
  exhausted: number;
  used_percent: number;
  reset_time: number;
  window_requests: number;
  request_count: number;
  lru: number;
}

export const DEFAULT_SMART_WEIGHTS: SmartWeights = {
  sessions: 30,
  exhausted: 25,
  used_percent: 20,
  reset_time: 5,
  window_requests: 10,
  request_count: 2,
  lru: 8,
};

export interface RotationState {
  roundRobinIndex: number;
  lastSelectedId: string | null;
}

export interface RotationStrategy {
  select(candidates: AccountEntry[], state: RotationState, sessionCounts?: Map<string, number>): AccountEntry;
}

// ─── Scoring helpers ───

interface PoolStats {
  maxSessions: number;
  maxWindowRequests: number;
  maxRequestCount: number;
  maxResetTime: number;
  minResetTime: number;
  maxLastUsed: number;
  minLastUsed: number;
}

function computePoolStats(candidates: AccountEntry[], sessionCounts?: Map<string, number>): PoolStats {
  let maxSessions = 0;
  let maxWindowRequests = 0;
  let maxRequestCount = 0;
  let maxResetTime = 0;
  let minResetTime = Infinity;
  let maxLastUsed = 0;
  let minLastUsed = Infinity;

  for (const c of candidates) {
    if (sessionCounts) {
      const s = sessionCounts.get(c.id) ?? 0;
      if (s > maxSessions) maxSessions = s;
    }
    const wReq = c.usage.window_request_count ?? 0;
    if (wReq > maxWindowRequests) maxWindowRequests = wReq;
    if (c.usage.request_count > maxRequestCount) maxRequestCount = c.usage.request_count;
    const reset = c.usage.window_reset_at;
    if (reset != null) {
      if (reset > maxResetTime) maxResetTime = reset;
      if (reset < minResetTime) minResetTime = reset;
    }
    const lu = c.usage.last_used ? new Date(c.usage.last_used).getTime() : 0;
    if (lu > maxLastUsed) maxLastUsed = lu;
    if (lu < minLastUsed) minLastUsed = lu;
  }
  if (minResetTime === Infinity) minResetTime = 0;
  if (minLastUsed === Infinity) minLastUsed = 0;

  return { maxSessions, maxWindowRequests, maxRequestCount, maxResetTime, minResetTime, maxLastUsed, minLastUsed };
}

/** Normalize a value to 0~1. Returns 0 when range is zero. */
function norm(value: number, max: number): number {
  return max > 0 ? value / max : 0;
}

/** Normalize a value to 0~1 within a min-max range. */
function normRange(value: number, min: number, max: number): number {
  const range = max - min;
  return range > 0 ? (value - min) / range : 0;
}

/** Compute a single dimension score for an account (0 = best, 1 = worst). */
function dimensionScores(
  entry: AccountEntry,
  stats: PoolStats,
  sessionCounts?: Map<string, number>,
): Record<keyof SmartWeights, number> {
  const sessions = sessionCounts ? norm(sessionCounts.get(entry.id) ?? 0, stats.maxSessions) : 0;
  const exhausted = entry.cachedQuota?.rate_limit?.limit_reached ? 1 : 0;
  const used_percent = (entry.cachedQuota?.rate_limit?.used_percent ?? 0) / 100;
  // Lower reset time = resets sooner = should be used first → lower normRange = lower score = better
  const resetRaw = entry.usage.window_reset_at;
  const reset_time = resetRaw != null
    ? normRange(resetRaw, stats.minResetTime, stats.maxResetTime)
    : 0; // unknown → assume best (benefit of the doubt, don't penalize new accounts)
  const window_requests = norm(entry.usage.window_request_count ?? 0, stats.maxWindowRequests);
  const request_count = norm(entry.usage.request_count, stats.maxRequestCount);
  // More recently used = higher score (worse) → we want LRU
  const lu = entry.usage.last_used ? new Date(entry.usage.last_used).getTime() : 0;
  const lru = normRange(lu, stats.minLastUsed, stats.maxLastUsed);

  return { sessions, exhausted, used_percent, reset_time, window_requests, request_count, lru };
}

function weightedScore(
  scores: Record<keyof SmartWeights, number>,
  weights: SmartWeights,
): number {
  let total = 0;
  for (const key of Object.keys(weights) as Array<keyof SmartWeights>) {
    total += scores[key] * weights[key];
  }
  return total;
}

// ─── Strategies ───

function createSmartStrategy(weights: SmartWeights): RotationStrategy {
  return {
    select(candidates, _state, sessionCounts) {
      const stats = computePoolStats(candidates, sessionCounts);
      let best = candidates[0];
      let bestScore = Infinity;
      for (const c of candidates) {
        const scores = dimensionScores(c, stats, sessionCounts);
        const score = weightedScore(scores, weights);
        if (score < bestScore) {
          bestScore = score;
          best = c;
        }
      }
      return best;
    },
  };
}

/** Create a single-dimension strategy: only one weight is non-zero. */
function createSingleDimensionStrategy(dimension: keyof SmartWeights): RotationStrategy {
  const weights: SmartWeights = {
    sessions: 0, exhausted: 0, used_percent: 0,
    reset_time: 0, window_requests: 0, request_count: 0, lru: 0,
  };
  weights[dimension] = 1;
  return createSmartStrategy(weights);
}

const roundRobin: RotationStrategy = {
  select(candidates, state) {
    // Sort by ID for stable ordering regardless of pool changes
    const sorted = [...candidates].sort((a, b) => a.id.localeCompare(b.id));

    let nextIdx = 0;
    if (state.lastSelectedId) {
      const idx = sorted.findIndex(a => a.id > state.lastSelectedId!);
      nextIdx = idx >= 0 ? idx : 0;
    }

    const selected = sorted[nextIdx];
    state.lastSelectedId = selected.id;
    return selected;
  },
};

// Default smart strategy with default weights
let smartStrategy = createSmartStrategy(DEFAULT_SMART_WEIGHTS);

const strategies: Record<RotationStrategyName, RotationStrategy> = {
  smart: { select: (c, s, sc) => smartStrategy.select(c, s, sc) },
  least_used: { select: (c, s, sc) => smartStrategy.select(c, s, sc) },
  sticky: { select: (c, s, sc) => smartStrategy.select(c, s, sc) },
  round_robin: roundRobin,
  by_sessions: createSingleDimensionStrategy("sessions"),
  by_exhausted: createSingleDimensionStrategy("exhausted"),
  by_used_percent: createSingleDimensionStrategy("used_percent"),
  by_reset_time: createSingleDimensionStrategy("reset_time"),
  by_window_requests: createSingleDimensionStrategy("window_requests"),
  by_request_count: createSingleDimensionStrategy("request_count"),
  by_lru: createSingleDimensionStrategy("lru"),
};

export function getRotationStrategy(name: RotationStrategyName): RotationStrategy {
  return strategies[name] ?? strategies.smart;
}

/** Update the weights used by the smart/least_used/sticky strategies. */
export function setSmartWeights(weights: SmartWeights): void {
  smartStrategy = createSmartStrategy(weights);
}

/** @deprecated Use getRotationStrategy instead */
export const createRotationStrategy = getRotationStrategy;
