import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { Hono } from "hono";
import type { AccountPool } from "../../auth/account-pool.js";

let tmpDataDir = "";

const mockConfig = {
  observability: { local_error_log: true, max_log_bytes: 10 * 1024 * 1024 },
};

vi.mock("../../paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../paths.js")>();
  return {
    ...actual,
    getDataDir: () => tmpDataDir,
  };
});

vi.mock("../../config.js", () => ({
  getConfig: () => mockConfig,
}));

beforeEach(() => {
  tmpDataDir = mkdtempSync(resolve(tmpdir(), "edge403-routes-"));
  process.env.VITEST_FORCE_APPEND_EDGE_403_LOG = "1";
  vi.resetModules();
});

afterEach(() => {
  if (existsSync(tmpDataDir)) {
    rmSync(tmpDataDir, { recursive: true, force: true });
  }
  delete process.env.VITEST_FORCE_APPEND_EDGE_403_LOG;
  vi.clearAllMocks();
});

function mockPool(): AccountPool {
  return {
    getEntry: (id: string) => id === "entry-1"
      ? { email: "user@example.com", label: "Team A" }
      : undefined,
  } as unknown as AccountPool;
}

async function buildApp() {
  const { createEdge403Routes } = await import("./edge-403.js");
  const app = new Hono();
  app.route("/", createEdge403Routes(mockPool()));
  return app;
}

describe("GET /admin/edge-403", () => {
  it("returns grouped Edge 403 events enriched with account info", async () => {
    const { appendEdge403Event } = await import("../../logs/edge-403.js");
    appendEdge403Event({
      body: "<html>[IP:87.232.98.13 | Ray ID: abcdef1234567890]</html>",
      endpoint: "POST /codex/responses",
      accountEntryId: "entry-1",
      accountId: "acct-1",
      proxyMode: "account proxy",
      proxyUrl: "http://u:p@proxy.local:8080",
    });

    const app = await buildApp();
    const res = await app.request("/admin/edge-403");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      total: number;
      groups: Array<{ egress_ip: string; account_email: string; account_label: string; proxy_url: string }>;
      recent: Array<{ egress_ip: string; account_email: string }>;
    };

    expect(body.total).toBe(1);
    expect(body.groups[0]).toMatchObject({
      egress_ip: "87.232.98.13",
      account_email: "user@example.com",
      account_label: "Team A",
      proxy_url: "http://***:***@proxy.local:8080/",
    });
    expect(body.recent[0]).toMatchObject({
      egress_ip: "87.232.98.13",
      account_email: "user@example.com",
    });
  });

  it("rejects invalid limits", async () => {
    const app = await buildApp();
    const res = await app.request("/admin/edge-403?limit=9999");
    expect(res.status).toBe(400);
  });
});
