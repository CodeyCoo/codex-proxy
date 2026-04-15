import { useState, useEffect, useCallback } from "preact/hooks";
import { extractErrorMessage } from "../utils/extract-error";

export type RotationStrategy =
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

export interface RotationSettingsData {
  rotation_strategy: RotationStrategy;
  smart_weights?: SmartWeights;
}

export function useRotationSettings(apiKey: string | null) {
  const [data, setData] = useState<RotationSettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const resp = await fetch("/admin/rotation-settings");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result: RotationSettingsData = await resp.json();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const save = useCallback(async (patch: Partial<RotationSettingsData>) => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      const resp = await fetch("/admin/rotation-settings", {
        method: "POST",
        headers,
        body: JSON.stringify(patch),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => null);
        throw new Error(extractErrorMessage(body, `HTTP ${resp.status}`));
      }
      const result = await resp.json() as { success: boolean } & RotationSettingsData;
      setData({ rotation_strategy: result.rotation_strategy });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [apiKey]);

  useEffect(() => { load(); }, [load]);

  return { data, saving, saved, error, save, load };
}
