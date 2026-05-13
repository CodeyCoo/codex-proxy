import { getProxyUrl } from "../tls/proxy.js";

export interface OfficialProxyAttempt {
  proxyUrl: string | null | undefined;
  label: string;
}

function proxyKey(proxyUrl: string | null | undefined, globalProxyUrl: string | null): string {
  const effective = proxyUrl === undefined ? globalProxyUrl : proxyUrl;
  return effective ?? "direct";
}

export function buildOfficialProxyAttempts(preferredProxyUrl: string | null | undefined): OfficialProxyAttempt[] {
  const globalProxyUrl = getProxyUrl();
  const attempts: OfficialProxyAttempt[] = [];
  const seen = new Set<string>();

  const add = (proxyUrl: string | null | undefined, label: string): void => {
    const key = proxyKey(proxyUrl, globalProxyUrl);
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push({ proxyUrl, label });
  };

  if (preferredProxyUrl === null) {
    add(null, "direct");
    return attempts;
  }

  if (preferredProxyUrl === undefined) {
    add(undefined, globalProxyUrl ? "global proxy" : "direct");
    add(null, "direct");
    return attempts;
  }

  add(preferredProxyUrl, "account proxy");
  if (globalProxyUrl) add(undefined, "global proxy");
  add(null, "direct");
  return attempts;
}
