import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useRotationSettings, type RotationStrategy, type SmartWeights } from "../../../shared/hooks/use-rotation-settings";
import { useSettings } from "../../../shared/hooks/use-settings";

const STRATEGY_OPTIONS: RotationStrategy[] = [
  "smart",
  "round_robin",
  "by_sessions",
  "by_exhausted",
  "by_used_percent",
  "by_reset_time",
  "by_window_requests",
  "by_request_count",
  "by_lru",
];

const DEFAULT_WEIGHTS: SmartWeights = {
  sessions: 30,
  exhausted: 25,
  used_percent: 20,
  reset_time: 5,
  window_requests: 10,
  request_count: 2,
  lru: 8,
};

const WEIGHT_KEYS: Array<keyof SmartWeights> = [
  "sessions", "exhausted", "used_percent", "reset_time",
  "window_requests", "request_count", "lru",
];

export function RotationSettings() {
  const t = useT();
  const settings = useSettings();
  const rs = useRotationSettings(settings.apiKey);

  const currentStrategy = rs.data?.rotation_strategy ?? "smart";
  const currentWeights = rs.data?.smart_weights ?? DEFAULT_WEIGHTS;

  const [draftStrategy, setDraftStrategy] = useState<RotationStrategy | null>(null);
  const [draftWeights, setDraftWeights] = useState<SmartWeights | null>(null);
  const [collapsed, setCollapsed] = useState(true);

  const displayStrategy = draftStrategy ?? currentStrategy;
  // Normalize legacy values to "smart"
  const effectiveStrategy = (displayStrategy === "least_used" || displayStrategy === "sticky")
    ? "smart" : displayStrategy;
  const displayWeights = draftWeights ?? currentWeights;
  const isSmartSelected = effectiveStrategy === "smart";

  const isDirty =
    effectiveStrategy !== (currentStrategy === "least_used" || currentStrategy === "sticky" ? "smart" : currentStrategy) ||
    (isSmartSelected && JSON.stringify(displayWeights) !== JSON.stringify(currentWeights));

  const handleSave = useCallback(async () => {
    if (!isDirty) return;
    await rs.save({
      rotation_strategy: effectiveStrategy,
      ...(isSmartSelected ? { smart_weights: displayWeights } : {}),
    });
    setDraftStrategy(null);
    setDraftWeights(null);
  }, [isDirty, effectiveStrategy, displayWeights, isSmartSelected, rs]);

  const handleWeightChange = useCallback((key: keyof SmartWeights, value: number) => {
    const base = draftWeights ?? currentWeights;
    setDraftWeights({ ...base, [key]: value });
  }, [draftWeights, currentWeights]);

  const handleResetWeights = useCallback(() => {
    setDraftWeights({ ...DEFAULT_WEIGHTS });
  }, []);

  const radioCls = "w-4 h-4 text-primary focus:ring-primary cursor-pointer";
  const labelCls = "text-[0.8rem] font-medium text-slate-700 dark:text-text-main cursor-pointer";

  return (
    <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl shadow-sm transition-colors">
      <button
        onClick={() => setCollapsed(!collapsed)}
        class="w-full flex items-center justify-between p-5 cursor-pointer select-none"
      >
        <div class="flex items-center gap-2">
          <svg class="size-5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3l-3 3" />
          </svg>
          <h2 class="text-[0.95rem] font-bold">{t("rotationSettings")}</h2>
        </div>
        <svg class={`size-5 text-slate-400 dark:text-text-dim transition-transform ${collapsed ? "" : "rotate-180"}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {!collapsed && (
        <div class="px-5 pb-5 border-t border-slate-100 dark:border-border-dark pt-4 space-y-4">
          <p class="text-xs text-slate-400 dark:text-text-dim">{t("rotationStrategyHint")}</p>

          <div class="space-y-2">
            {STRATEGY_OPTIONS.map((strat) => (
              <label key={strat} class="flex items-center gap-3 p-2.5 rounded-lg border border-gray-200 dark:border-border-dark cursor-pointer hover:bg-slate-50 dark:hover:bg-bg-dark transition-colors">
                <input
                  type="radio"
                  name="rotation-strategy"
                  checked={effectiveStrategy === strat}
                  onChange={() => setDraftStrategy(strat)}
                  class={radioCls}
                />
                <div>
                  <span class={labelCls}>{t(`rotation_${strat}` as any)}</span>
                  <span class="text-xs text-slate-400 dark:text-text-dim ml-1.5">{t(`rotation_${strat}_desc` as any)}</span>
                </div>
              </label>
            ))}
          </div>

          {/* Smart weights editor */}
          {isSmartSelected && (
            <div class="mt-3 p-3 rounded-lg border border-gray-200 dark:border-border-dark space-y-3">
              <div class="flex items-center justify-between">
                <span class="text-xs font-semibold text-slate-600 dark:text-text-main">{t("rotationSmartWeights")}</span>
                <button
                  onClick={handleResetWeights}
                  class="text-xs text-primary hover:underline cursor-pointer"
                >
                  {t("rotationResetWeights")}
                </button>
              </div>
              {WEIGHT_KEYS.map((key) => (
                <div key={key} class="flex items-center gap-3">
                  <span class="text-xs text-slate-500 dark:text-text-dim w-32 shrink-0">{t(`rotation_weight_${key}` as any)}</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={displayWeights[key]}
                    onInput={(e) => handleWeightChange(key, Number((e.target as HTMLInputElement).value))}
                    class="flex-1 h-1.5 accent-primary cursor-pointer"
                  />
                  <span class="text-xs text-slate-500 dark:text-text-dim w-8 text-right">{displayWeights[key]}</span>
                </div>
              ))}
            </div>
          )}

          {/* Save button */}
          <div class="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={rs.saving || !isDirty}
              class={`px-4 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                isDirty && !rs.saving
                  ? "bg-primary text-white hover:bg-primary/90 cursor-pointer"
                  : "bg-slate-100 dark:bg-[#21262d] text-slate-400 dark:text-text-dim cursor-not-allowed"
              }`}
            >
              {rs.saving ? "..." : t("submit")}
            </button>
            {rs.saved && (
              <span class="text-xs font-medium text-green-600 dark:text-green-400">{t("rotationSaved")}</span>
            )}
            {rs.error && (
              <span class="text-xs font-medium text-red-500">{rs.error}</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
