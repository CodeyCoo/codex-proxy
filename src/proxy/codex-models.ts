/**
 * Codex model discovery — probes backend endpoints for available models.
 */

import { getConfig } from "../config.js";
import { getTransport, type TlsTransport } from "../tls/transport.js";
import type { BackendModelEntry } from "../models/model-store.js";
import { isEdgeHtml403Body } from "./error-classification.js";
import { buildOfficialProxyAttempts } from "./official-edge-fallback.js";
import { appendEdge403Event } from "../logs/edge-403.js";

let _firstModelFetchLogged = false;

export async function fetchModels(
  headers: Record<string, string>,
  proxyUrl?: string | null,
  apiConfig?: { base_url: string; app_version: string },
  injectedTransport?: TlsTransport,
  context?: { accountEntryId?: string | null; accountId?: string | null },
): Promise<BackendModelEntry[] | null> {
  const config = apiConfig ? undefined : getConfig();
  const transport = injectedTransport ?? getTransport();
  const baseUrl = apiConfig?.base_url ?? config!.api.base_url;

  const clientVersion = apiConfig?.app_version ?? config!.client.app_version;
  const endpoints = [
    `${baseUrl}/codex/models?client_version=${clientVersion}`,
    `${baseUrl}/models`,
    `${baseUrl}/sentinel/chat-requirements`,
  ];

  headers["Accept"] = "application/json";
  if (!transport.isImpersonate()) {
    headers["Accept-Encoding"] = "gzip, deflate";
  }

  const attempts = buildOfficialProxyAttempts(proxyUrl);
  for (const url of endpoints) {
    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i];
      try {
        const result = await transport.get(url, headers, 15, attempt.proxyUrl);
        const edgeHtml403 = isEdgeHtml403Body(result.status, result.body);
        if (edgeHtml403) {
          appendEdge403Event({
            body: result.body,
            endpoint: "GET Codex models",
            accountEntryId: context?.accountEntryId,
            accountId: context?.accountId,
            proxyMode: attempt.label,
            proxyUrl: attempt.proxyUrl,
          });
        }
        if (edgeHtml403 && i + 1 < attempts.length) {
          continue;
        }
        const parsed = JSON.parse(result.body) as Record<string, unknown>;

        const sentinel = parsed.chat_models as Record<string, unknown> | undefined;
        const models = sentinel?.models ?? parsed.models ?? parsed.data ?? parsed.categories;
        if (Array.isArray(models) && models.length > 0) {
          console.log(`[CodexApi] getModels() found ${models.length} entries from ${url}`);
          if (!_firstModelFetchLogged) {
            console.log(`[CodexApi] Raw response keys: ${Object.keys(parsed).join(", ")}`);
            console.log(`[CodexApi] Raw model sample: ${JSON.stringify(models[0]).slice(0, 500)}`);
            if (models.length > 1) {
              console.log(`[CodexApi] Raw model sample[1]: ${JSON.stringify(models[1]).slice(0, 500)}`);
            }
            _firstModelFetchLogged = true;
          }
          // Flatten nested categories into a single list
          const flattened: BackendModelEntry[] = [];
          for (const item of models) {
            if (item && typeof item === "object") {
              const entry = item as Record<string, unknown>;
              if (Array.isArray(entry.models)) {
                for (const sub of entry.models as BackendModelEntry[]) {
                  flattened.push(sub);
                }
              } else {
                flattened.push(item as BackendModelEntry);
              }
            }
          }
          if (flattened.length > 0) {
            console.log(`[CodexApi] getModels() total after flatten: ${flattened.length} models`);
            return flattened;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[CodexApi] Probe ${url} failed: ${msg}`);
        continue;
      }
    }
  }

  return null;
}

export async function probeEndpoint(
  path: string,
  headers: Record<string, string>,
  proxyUrl?: string | null,
  baseUrl?: string,
  injectedTransport?: TlsTransport,
): Promise<Record<string, unknown> | null> {
  const transport = injectedTransport ?? getTransport();
  const url = `${baseUrl ?? getConfig().api.base_url}${path}`;

  headers["Accept"] = "application/json";
  if (!transport.isImpersonate()) {
    headers["Accept-Encoding"] = "gzip, deflate";
  }

  try {
    const result = await transport.get(url, headers, 15, proxyUrl);
    return JSON.parse(result.body) as Record<string, unknown>;
  } catch {
    return null;
  }
}
