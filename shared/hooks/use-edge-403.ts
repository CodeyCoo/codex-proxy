import { useCallback, useEffect, useRef, useState } from "preact/hooks";

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
  account_email: string | null;
  account_label: string | null;
  proxy_mode: "account proxy" | "global proxy" | "direct" | "unknown";
  proxy_url: string | null;
}

export interface Edge403Event {
  id: string;
  ts: string;
  status: 403;
  endpoint: string;
  egress_ip: string | null;
  ray_id: string | null;
  account_entry_id: string | null;
  account_id: string | null;
  account_email: string | null;
  account_label: string | null;
  proxy_mode: "account proxy" | "global proxy" | "direct" | "unknown";
  proxy_url: string | null;
}

export interface Edge403State {
  total: number;
  groups: Edge403Group[];
  recent: Edge403Event[];
}

const POLL_MS = 30_000;

export function useEdge403Events() {
  const [data, setData] = useState<Edge403State>({ total: 0, groups: [], recent: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/admin/edge-403?limit=500");
      if (!res.ok) {
        setError("Failed to load Edge 403 events");
        return;
      }
      setData((await res.json()) as Edge403State);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load Edge 403 events");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    timerRef.current = setInterval(() => void refresh(), POLL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [refresh]);

  return { ...data, loading, error, refresh };
}

export function formatEdge403RelativeTime(ts: string, now: number = Date.now()): string {
  const time = new Date(ts).getTime();
  if (Number.isNaN(time)) return ts;
  const diffSec = Math.floor((now - time) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}
