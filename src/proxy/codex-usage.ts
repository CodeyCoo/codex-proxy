/**
 * Codex usage/quota API query.
 */

import { getConfig } from "../config.js";
import { getTransport, type TlsTransport } from "../tls/transport.js";
import { CodexApiError, type CodexUsageResponse } from "./codex-types.js";
import { isEdgeHtml403Body } from "./error-classification.js";
import { buildOfficialProxyAttempts } from "./official-edge-fallback.js";
import { appendEdge403Event } from "../logs/edge-403.js";

function usageUrls(baseUrl: string): string[] {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.includes("/backend-api")) {
    return [`${trimmed}/wham/usage`, `${trimmed}/codex/usage`];
  }
  return [`${trimmed}/api/codex/usage`, `${trimmed}/codex/usage`];
}

export async function fetchUsage(
  headers: Record<string, string>,
  proxyUrl?: string | null,
  baseUrl?: string,
  injectedTransport?: TlsTransport,
  context?: { accountEntryId?: string | null; accountId?: string | null },
): Promise<CodexUsageResponse> {
  const resolvedBaseUrl = baseUrl ?? getConfig().api.base_url;
  const transport = injectedTransport ?? getTransport();

  headers["Accept"] = "application/json";
  if (!transport.isImpersonate()) {
    headers["Accept-Encoding"] = "gzip, deflate";
  }

  let lastBody = "";
  let lastError: string | null = null;
  let lastEdgeHtml403Body: string | null = null;
  const attempts = buildOfficialProxyAttempts(proxyUrl);
  for (const url of usageUrls(resolvedBaseUrl)) {
    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i];
      let body: string;
      let status = 0;
      try {
        const result = await transport.get(url, headers, 15, attempt.proxyUrl);
        status = result.status;
        body = result.body;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      }
      lastBody = body;

      const edgeHtml403 = isEdgeHtml403Body(status, body);
      if (edgeHtml403) {
        appendEdge403Event({
          body,
          endpoint: "GET Codex usage",
          accountEntryId: context?.accountEntryId,
          accountId: context?.accountId,
          proxyMode: attempt.label,
          proxyUrl: attempt.proxyUrl,
        });
        lastEdgeHtml403Body = body;
        if (i + 1 < attempts.length) {
          continue;
        }
      }

      try {
        const parsed = JSON.parse(body) as CodexUsageResponse;
        if (!parsed.rate_limit) {
          lastError = `Unexpected response from ${url}: ${body.slice(0, 200)}`;
          continue;
        }
        return parsed;
      } catch (e) {
        if (e instanceof CodexApiError) throw e;
        lastError = `Invalid JSON from ${url}: ${body.slice(0, 200)}`;
      }
    }
  }

  if (lastEdgeHtml403Body) throw new CodexApiError(403, lastEdgeHtml403Body);
  if (lastBody) throw new CodexApiError(502, lastError ?? `Invalid usage response: ${lastBody.slice(0, 200)}`);
  throw new CodexApiError(0, `transport GET failed: ${lastError ?? "unknown error"}`);
}
