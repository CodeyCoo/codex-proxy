import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

let tmpDataDir = "";

const mockConfig = {
  observability: { local_error_log: true, max_log_bytes: 10 * 1024 * 1024 },
};

vi.mock("../paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../paths.js")>();
  return {
    ...actual,
    getDataDir: () => tmpDataDir,
  };
});

vi.mock("../config.js", () => ({
  getConfig: () => mockConfig,
}));

async function importEdge403Log() {
  return await import("./edge-403.js");
}

beforeEach(() => {
  tmpDataDir = mkdtempSync(resolve(tmpdir(), "edge403-"));
  mockConfig.observability.local_error_log = true;
  mockConfig.observability.max_log_bytes = 10 * 1024 * 1024;
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

describe("appendEdge403Event", () => {
  it("stores only structured HTML 403 details and masks proxy credentials", async () => {
    const { appendEdge403Event, readEdge403Events } = await importEdge403Log();
    appendEdge403Event({
      body: '<html><body>[IP:87.232.98.13 | Ray ID: abcdef1234567890]</body></html>',
      endpoint: "POST /codex/responses",
      accountEntryId: "entry-1",
      accountId: "acct-1",
      proxyMode: "account proxy",
      proxyUrl: "http://user:secret@proxy.local:8080",
    });

    const file = resolve(tmpDataDir, "edge-403-log.jsonl");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf-8")).not.toContain("<html");

    const events = readEdge403Events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      endpoint: "POST /codex/responses",
      egress_ip: "87.232.98.13",
      ray_id: "abcdef1234567890",
      account_entry_id: "entry-1",
      account_id: "acct-1",
      proxy_mode: "account proxy",
      proxy_url: "http://***:***@proxy.local:8080/",
    });
  });

  it("does not write when local error logging is disabled", async () => {
    mockConfig.observability.local_error_log = false;
    const { appendEdge403Event } = await importEdge403Log();
    appendEdge403Event({
      body: "<html><body>blocked-icon</body></html>",
      endpoint: "GET Codex usage",
    });
    expect(existsSync(resolve(tmpDataDir, "edge-403-log.jsonl"))).toBe(false);
  });
});

describe("groupEdge403Events", () => {
  it("groups by egress IP, account, and proxy exit", async () => {
    const { appendEdge403Event, readEdge403Events, groupEdge403Events } = await importEdge403Log();
    appendEdge403Event({
      body: "<html>[IP:87.232.98.13 | Ray ID: ray111111111111]</html>",
      endpoint: "GET Codex usage",
      accountEntryId: "entry-1",
      proxyMode: "direct",
    });
    await new Promise((r) => setTimeout(r, 5));
    appendEdge403Event({
      body: "<html>[IP:87.232.98.13 | Ray ID: ray222222222222]</html>",
      endpoint: "POST /codex/responses",
      accountEntryId: "entry-1",
      proxyMode: "direct",
    });

    const groups = groupEdge403Events(readEdge403Events());
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      egress_ip: "87.232.98.13",
      count: 2,
      ray_id: "ray222222222222",
      endpoint: "POST /codex/responses",
    });
  });
});
