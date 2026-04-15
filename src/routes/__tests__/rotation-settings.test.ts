/**
 * Tests for rotation settings endpoints.
 * GET  /admin/rotation-settings — read current rotation strategy
 * POST /admin/rotation-settings — update rotation strategy
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks (before any imports) ---

const mockConfig = {
  server: { proxy_api_key: null as string | null },
  auth: { rotation_strategy: "smart" as string, smart_weights: undefined as Record<string, number> | undefined },
  quota: {
    refresh_interval_minutes: 5,
    warning_thresholds: { primary: [80, 90], secondary: [80, 90] },
    skip_exhausted: true,
  },
};

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
  reloadAllConfigs: vi.fn(),
  getLocalConfigPath: vi.fn(() => "/tmp/test/local.yaml"),
  ROTATION_STRATEGIES: ["smart", "least_used", "round_robin", "sticky", "by_sessions", "by_exhausted", "by_used_percent", "by_reset_time", "by_window_requests", "by_request_count", "by_lru"],
}));

vi.mock("../../paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-config"),
  getPublicDir: vi.fn(() => "/tmp/test-public"),
  getDesktopPublicDir: vi.fn(() => "/tmp/test-desktop"),
  getDataDir: vi.fn(() => "/tmp/test-data"),
  getBinDir: vi.fn(() => "/tmp/test-bin"),
  isEmbedded: vi.fn(() => false),
}));

vi.mock("../../utils/yaml-mutate.js", () => ({
  mutateYaml: vi.fn(),
}));

vi.mock("../../tls/transport.js", () => ({
  getTransport: vi.fn(),
  getTransportInfo: vi.fn(() => ({})),
}));

vi.mock("../../fingerprint/manager.js", () => ({
  buildHeaders: vi.fn(() => ({})),
}));

vi.mock("../../update-checker.js", () => ({
  getUpdateState: vi.fn(() => ({})),
  checkForUpdate: vi.fn(),
  isUpdateInProgress: vi.fn(() => false),
}));

vi.mock("../../self-update.js", () => ({
  getProxyInfo: vi.fn(() => ({})),
  canSelfUpdate: vi.fn(() => false),
  checkProxySelfUpdate: vi.fn(),
  applyProxySelfUpdate: vi.fn(),
  isProxyUpdateInProgress: vi.fn(() => false),
  getCachedProxyUpdateResult: vi.fn(() => null),
  getDeployMode: vi.fn(() => "git"),
}));

vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: vi.fn(() => vi.fn()),
}));

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: vi.fn(() => ({ remote: { address: "127.0.0.1" } })),
}));

vi.mock("../../auth/rotation-strategy.js", () => ({
  setSmartWeights: vi.fn(),
  DEFAULT_SMART_WEIGHTS: {
    sessions: 30, exhausted: 25, used_percent: 20,
    reset_time: 5, window_requests: 10, request_count: 2, lru: 8,
  },
}));

import { createWebRoutes } from "../web.js";
import { mutateYaml } from "../../utils/yaml-mutate.js";

const mockPool = {
  getAll: vi.fn(() => []),
  acquire: vi.fn(),
  release: vi.fn(),
} as unknown as Parameters<typeof createWebRoutes>[0];

describe("GET /admin/rotation-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.auth.rotation_strategy = "smart";
    mockConfig.auth.smart_weights = undefined;
  });

  it("returns current rotation strategy with default weights", async () => {
    const app = createWebRoutes(mockPool);
    const res = await app.request("/admin/rotation-settings");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.rotation_strategy).toBe("smart");
    expect(data.smart_weights).toBeDefined();
    expect(data.smart_weights.sessions).toBe(30);
  });

  it("reflects config value", async () => {
    mockConfig.auth.rotation_strategy = "round_robin";
    const app = createWebRoutes(mockPool);
    const res = await app.request("/admin/rotation-settings");
    const data = await res.json();
    expect(data.rotation_strategy).toBe("round_robin");
  });
});

describe("POST /admin/rotation-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.server.proxy_api_key = null;
    mockConfig.auth.rotation_strategy = "smart";
    mockConfig.auth.smart_weights = undefined;
  });

  it("updates strategy to round_robin", async () => {
    const app = createWebRoutes(mockPool);
    const res = await app.request("/admin/rotation-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rotation_strategy: "round_robin" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(mutateYaml).toHaveBeenCalledOnce();
  });

  it("accepts all valid strategies", async () => {
    const app = createWebRoutes(mockPool);
    for (const strategy of ["smart", "round_robin", "by_sessions", "by_used_percent", "by_lru"]) {
      vi.mocked(mutateYaml).mockClear();
      const res = await app.request("/admin/rotation-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rotation_strategy: strategy }),
      });
      expect(res.status).toBe(200);
    }
  });

  it("rejects invalid strategy with 400", async () => {
    const app = createWebRoutes(mockPool);
    const res = await app.request("/admin/rotation-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rotation_strategy: "random" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("rejects missing strategy with 400", async () => {
    const app = createWebRoutes(mockPool);
    const res = await app.request("/admin/rotation-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("requires auth when proxy_api_key is set", async () => {
    mockConfig.server.proxy_api_key = "my-secret";
    const app = createWebRoutes(mockPool);

    // No auth → 401
    const res1 = await app.request("/admin/rotation-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rotation_strategy: "smart" }),
    });
    expect(res1.status).toBe(401);

    // With auth → 200
    const res2 = await app.request("/admin/rotation-settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer my-secret",
      },
      body: JSON.stringify({ rotation_strategy: "smart" }),
    });
    expect(res2.status).toBe(200);
  });
});
