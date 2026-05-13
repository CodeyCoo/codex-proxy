import { Hono } from "hono";
import { z } from "zod";
import type { AccountPool } from "../../auth/account-pool.js";
import {
  groupEdge403Events,
  readEdge403Events,
  type Edge403Event,
  type Edge403Group,
} from "../../logs/edge-403.js";

const QuerySchema = z.object({
  limit: z.preprocess(
    (v) => (v === undefined ? undefined : Number(v)),
    z.number().int().min(1).max(500).optional(),
  ),
});

interface EnrichedEdge403Group extends Edge403Group {
  account_email: string | null;
  account_label: string | null;
}

interface EnrichedEdge403Event extends Edge403Event {
  account_email: string | null;
  account_label: string | null;
}

function enrichGroup(group: Edge403Group, accountPool: AccountPool): EnrichedEdge403Group {
  const entry = group.account_entry_id ? accountPool.getEntry(group.account_entry_id) : undefined;
  return {
    ...group,
    account_email: entry?.email ?? null,
    account_label: entry?.label ?? null,
  };
}

function enrichEvent(event: Edge403Event, accountPool: AccountPool): EnrichedEdge403Event {
  const entry = event.account_entry_id ? accountPool.getEntry(event.account_entry_id) : undefined;
  return {
    ...event,
    account_email: entry?.email ?? null,
    account_label: entry?.label ?? null,
  };
}

export function createEdge403Routes(accountPool: AccountPool): Hono {
  const app = new Hono();

  app.get("/admin/edge-403", (c) => {
    const parsed = QuerySchema.safeParse({ limit: c.req.query("limit") });
    if (!parsed.success) {
      c.status(400);
      return c.json({ error: "Invalid limit", details: parsed.error.issues });
    }

    const events = readEdge403Events(parsed.data.limit);
    const groups = groupEdge403Events(events).map((g) => enrichGroup(g, accountPool));
    const recent = events.slice(0, 50).map((e) => enrichEvent(e, accountPool));
    return c.json({ total: events.length, groups, recent });
  });

  app.get("/admin/edge-403/raw", (c) => {
    const parsed = QuerySchema.safeParse({ limit: c.req.query("limit") });
    if (!parsed.success) {
      c.status(400);
      return c.json({ error: "Invalid limit", details: parsed.error.issues });
    }
    const events = readEdge403Events(parsed.data.limit).map((e) => enrichEvent(e, accountPool));
    return c.json({ events });
  });

  return app;
}
