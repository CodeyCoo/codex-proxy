/**
 * Structured Edge HTML 403 event log.
 *
 * This deliberately stores only a safe summary extracted from upstream HTML
 * block/challenge pages. The raw HTML body is never persisted.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "crypto";
import { resolve } from "path";
import { getConfig } from "../config.js";
import { getDataDir } from "../paths.js";
import { extractEdgeHtml403Details } from "../proxy/error-classification.js";

export type Edge403ProxyMode = "account proxy" | "global proxy" | "direct" | "unknown";

export interface Edge403Event {
  id: string;
  ts: string;
  status: 403;
  endpoint: string;
  egress_ip: string | null;
  ray_id: string | null;
  account_entry_id: string | null;
  account_id: string | null;
  proxy_mode: Edge403ProxyMode;
  proxy_url: string | null;
}

export interface AppendEdge403EventInput {
  body: string;
  endpoint: string;
  accountEntryId?: string | null;
  accountId?: string | null;
  proxyMode?: string | null;
  proxyUrl?: string | null;
}

export interface Edge403Group {
  key: string;
  egress_ip: string | null;
  ray_id: string | null;
  count: number;
  first_seen: string;
  last_seen: string;
  endpoint: string;
  account_entry_id: string | null;
  account_id: string | null;
  proxy_mode: Edge403ProxyMode;
  proxy_url: string | null;
}

const LOG_FILE = "edge-403-log.jsonl";
const BACKUP_FILE = "edge-403-log.1.jsonl";
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

interface ObservabilityConfig {
  local_error_log: boolean;
  max_log_bytes: number;
}

function readObservabilityConfig(): ObservabilityConfig {
  const cfg = getConfig() as { observability?: Partial<ObservabilityConfig> };
  return {
    local_error_log: cfg.observability?.local_error_log ?? true,
    max_log_bytes: cfg.observability?.max_log_bytes ?? DEFAULT_MAX_BYTES,
  };
}

function ensureDataDir(): string {
  const dir = getDataDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function logPath(): string {
  return resolve(ensureDataDir(), LOG_FILE);
}

function backupPath(): string {
  return resolve(ensureDataDir(), BACKUP_FILE);
}

function rotateIfNeeded(maxBytes: number): void {
  const current = logPath();
  if (!existsSync(current)) return;
  if (statSync(current).size <= maxBytes) return;
  const backup = backupPath();
  if (existsSync(backup) && process.platform === "win32") {
    try {
      writeFileSync(backup, "");
    } catch {
      /* renameSync will surface the real failure */
    }
  }
  renameSync(current, backup);
}

function normalizeProxyMode(value: string | null | undefined): Edge403ProxyMode {
  if (value === "account proxy" || value === "global proxy" || value === "direct") return value;
  return "unknown";
}

function maskProxyUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return url.replace(/\/\/([^:@/]+):([^@/]+)@/, "//***:***@");
  }
}

export function appendEdge403Event(input: AppendEdge403EventInput): void {
  if (process.env.VITEST && !process.env.VITEST_FORCE_APPEND_EDGE_403_LOG) return;

  let cfg: ObservabilityConfig;
  try {
    cfg = readObservabilityConfig();
  } catch {
    cfg = { local_error_log: true, max_log_bytes: DEFAULT_MAX_BYTES };
  }
  if (!cfg.local_error_log) return;

  const details = extractEdgeHtml403Details(input.body);
  const entry: Edge403Event = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    status: 403,
    endpoint: input.endpoint,
    egress_ip: details.egressIp,
    ray_id: details.rayId,
    account_entry_id: input.accountEntryId ?? null,
    account_id: input.accountId ?? null,
    proxy_mode: normalizeProxyMode(input.proxyMode),
    proxy_url: maskProxyUrl(input.proxyUrl),
  };

  try {
    rotateIfNeeded(cfg.max_log_bytes);
    appendFileSync(logPath(), JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Logging failures must not affect upstream request handling.
  }
}

function readJsonlFile(path: string): Edge403Event[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const out: Edge403Event[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Edge403Event;
      if (parsed && parsed.status === 403 && typeof parsed.ts === "string") {
        out.push(parsed);
      }
    } catch {
      // Skip corrupted lines.
    }
  }
  return out;
}

export function readEdge403Events(limit?: number): Edge403Event[] {
  const oldest = readJsonlFile(backupPath());
  const newest = readJsonlFile(logPath());
  const combined = [...oldest, ...newest];
  combined.reverse();
  return limit === undefined ? combined : combined.slice(0, limit);
}

function groupKey(entry: Edge403Event): string {
  return [
    entry.egress_ip ?? "unknown-ip",
    entry.account_entry_id ?? "unknown-account",
    entry.proxy_mode,
    entry.proxy_url ?? "no-proxy-url",
  ].join("|");
}

export function groupEdge403Events(entries: Edge403Event[]): Edge403Group[] {
  const groups = new Map<string, Edge403Group>();
  for (const entry of entries) {
    const key = groupKey(entry);
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (entry.ts > existing.last_seen) {
        existing.last_seen = entry.ts;
        existing.ray_id = entry.ray_id;
        existing.endpoint = entry.endpoint;
        existing.account_id = entry.account_id;
      }
      if (entry.ts < existing.first_seen) existing.first_seen = entry.ts;
      continue;
    }
    groups.set(key, {
      key,
      egress_ip: entry.egress_ip,
      ray_id: entry.ray_id,
      count: 1,
      first_seen: entry.ts,
      last_seen: entry.ts,
      endpoint: entry.endpoint,
      account_entry_id: entry.account_entry_id,
      account_id: entry.account_id,
      proxy_mode: entry.proxy_mode,
      proxy_url: entry.proxy_url,
    });
  }
  return Array.from(groups.values()).sort((a, b) =>
    a.last_seen < b.last_seen ? 1 : a.last_seen > b.last_seen ? -1 : 0,
  );
}
