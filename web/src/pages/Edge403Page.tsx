import { useState } from "preact/hooks";
import {
  formatEdge403RelativeTime,
  useEdge403Events,
  type Edge403Group,
} from "../../../shared/hooks/use-edge-403";
import { useT } from "../../../shared/i18n/context";

function accountLabel(group: Edge403Group): string {
  return group.account_label || group.account_email || group.account_entry_id || "-";
}

function proxyLabel(group: Edge403Group): string {
  if (group.proxy_mode === "direct") return "direct";
  if (group.proxy_url) return `${group.proxy_mode}: ${group.proxy_url}`;
  return group.proxy_mode;
}

function Edge403Row({ group }: { group: Edge403Group }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <div class="border-b border-slate-100 dark:border-border-dark last:border-b-0">
      <button
        class="w-full grid grid-cols-12 gap-3 px-3 py-2.5 text-left text-xs hover:bg-slate-50 dark:hover:bg-border-dark transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <div class="col-span-3 min-w-0">
          <div class="font-mono text-slate-800 dark:text-text-main truncate">
            {group.egress_ip ?? t("edge403UnknownIp")}
          </div>
          <div class="text-[11px] text-slate-400 mt-0.5">
            {formatEdge403RelativeTime(group.last_seen)}
          </div>
        </div>
        <div class="col-span-1">
          <span class="inline-flex px-1.5 py-0.5 rounded-full bg-danger-container text-danger font-semibold">
            {group.count}
          </span>
        </div>
        <div class="col-span-2 truncate text-slate-600 dark:text-text-dim">
          {accountLabel(group)}
        </div>
        <div class="col-span-2 truncate text-slate-600 dark:text-text-dim">
          {proxyLabel(group)}
        </div>
        <div class="col-span-2 truncate text-slate-600 dark:text-text-dim">
          {group.endpoint}
        </div>
        <div class="col-span-2 min-w-0 flex items-center justify-between gap-2">
          <span class="font-mono truncate text-slate-500 dark:text-text-dim">
            {group.ray_id ?? "-"}
          </span>
          <svg
            class={`size-3.5 shrink-0 text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </div>
      </button>
      {open && (
        <div class="px-3 pb-3">
          <pre class="text-[11px] font-mono whitespace-pre-wrap break-all text-slate-600 dark:text-text-dim leading-relaxed bg-slate-50 dark:bg-bg-dark/40 rounded-lg p-3 overflow-x-auto">
            {JSON.stringify(group, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export function Edge403Page() {
  const t = useT();
  const edge = useEdge403Events();

  return (
    <section class="flex flex-col gap-4">
      <div class="flex items-center justify-between gap-3">
        <div>
          <h2 class="text-lg font-bold text-slate-800 dark:text-text-main">
            {t("edge403Tab")}
          </h2>
          <p class="text-xs text-slate-500 dark:text-text-dim mt-0.5">
            {t("edge403Desc")}
          </p>
        </div>
        <button
          onClick={() => void edge.refresh()}
          class="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-border-dark text-xs font-medium text-slate-600 dark:text-text-dim hover:bg-slate-50 dark:hover:bg-border-dark transition-colors"
        >
          {t("errorsRefresh")}
        </button>
      </div>

      {edge.error && (
        <div class="px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-red-700 dark:bg-red-900/20 dark:border-red-700/30 dark:text-red-400 text-xs">
          {edge.error}
        </div>
      )}

      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div class="rounded-lg border border-slate-200 dark:border-border-dark bg-white dark:bg-card-dark p-3">
          <div class="text-[11px] text-slate-500 dark:text-text-dim">{t("edge403TotalEvents")}</div>
          <div class="text-xl font-semibold text-slate-800 dark:text-text-main mt-1">{edge.total}</div>
        </div>
        <div class="rounded-lg border border-slate-200 dark:border-border-dark bg-white dark:bg-card-dark p-3">
          <div class="text-[11px] text-slate-500 dark:text-text-dim">{t("edge403BlockedIps")}</div>
          <div class="text-xl font-semibold text-slate-800 dark:text-text-main mt-1">{edge.groups.length}</div>
        </div>
        <div class="rounded-lg border border-slate-200 dark:border-border-dark bg-white dark:bg-card-dark p-3">
          <div class="text-[11px] text-slate-500 dark:text-text-dim">{t("edge403Latest")}</div>
          <div class="text-sm font-medium text-slate-800 dark:text-text-main mt-1">
            {edge.groups[0] ? formatEdge403RelativeTime(edge.groups[0].last_seen) : "-"}
          </div>
        </div>
      </div>

      <div class="border border-slate-200 dark:border-border-dark rounded-lg overflow-hidden bg-white dark:bg-card-dark">
        <div class="overflow-x-auto">
          <div class="min-w-[820px]">
            <div class="grid grid-cols-12 gap-3 text-xs text-slate-500 px-3 py-2 border-b border-slate-200 dark:border-border-dark">
              <div class="col-span-3">{t("edge403EgressIp")}</div>
              <div class="col-span-1">{t("edge403Count")}</div>
              <div class="col-span-2">{t("edge403Account")}</div>
              <div class="col-span-2">{t("edge403Proxy")}</div>
              <div class="col-span-2">{t("edge403Endpoint")}</div>
              <div class="col-span-2">{t("edge403RayId")}</div>
            </div>
            {edge.loading && edge.groups.length === 0 && (
              <div class="p-4 text-xs text-slate-500">{t("loading")}</div>
            )}
            {!edge.loading && edge.groups.length === 0 && (
              <div class="p-6 text-center text-xs text-slate-500 dark:text-text-dim">
                {t("edge403Empty")}
              </div>
            )}
            {edge.groups.map((group) => (
              <Edge403Row key={group.key} group={group} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
