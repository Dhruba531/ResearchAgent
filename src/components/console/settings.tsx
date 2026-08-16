// LLM provider API keys and spend-against-budget.
//
// Keys are write-only: the server returns only the last four characters, so
// a saved key can be identified but never read back.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  deleteProviderKey,
  previewRevision,
  getUsage,
  listProviderKeys,
  saveProviderKey,
  testProviderKey,
  type ProviderId,
  type ProviderKeyOut,
  type CapabilitiesOut,
  type UsageOut,
} from "@/lib/api";
import { BentoHead, Dot, MetaChip, SectionHeader, StatTile, friendlyError } from "./primitives";
import { ProviderKeysGate } from "./gating";
import { RunSetupCard } from "./gates";

export interface ProviderDef {
  id: ProviderId;
  title: string;
  label: string;
  placeholder: string;
  modelLabel: string;
  models: string[]; // dropdown options; last selected freeform allowed
  helper: string;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: "anthropic",
    title: "Claude / Anthropic",
    label: "Paste Claude API key",
    placeholder: "sk-ant-...",
    modelLabel: "model",
    models: [
      "claude-opus-4-8",
      "claude-fable-5",
      "claude-3-5-sonnet-latest",
      "claude-3-5-haiku-latest",
      "claude-3-opus-latest",
    ],
    helper: "Drives brief + draft generation on real runs.",
  },
  {
    id: "openai",
    title: "OpenAI / ChatGPT",
    label: "Paste OpenAI API key",
    placeholder: "sk-...",
    modelLabel: "model",
    models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "o4-mini"],
    helper: "Alternate LLM for real runs.",
  },
  {
    id: "runpod",
    title: "RunPod (code execution)",
    label: "Paste RunPod API key",
    placeholder: "rpa_...",
    modelLabel: "endpoint id",
    models: ["your-endpoint-id"],
    helper: 'Required when "Execute on RunPod" is enabled. Endpoint id is stored as model name.',
  },
  {
    id: "gemini",
    title: "Gemini (figures)",
    label: "Paste Gemini API key",
    placeholder: "AIza...",
    modelLabel: "model",
    models: ["gemini-2.5-flash-image", "gemini-2.0-flash", "gemini-1.5-pro"],
    helper: 'Required when "Generate figures" is enabled.',
  },
];

export type ProviderDraft = { apiKey: string; modelName: string; enabled: boolean };

/**
 * Manage the user's LLM provider API keys.
 *
 * ⚠ SECURITY-RELEVANT. Keys are WRITE-ONLY: once submitted, the server never
 * returns one again, and `ProviderKeyOut` (lib/api.ts) exposes only
 * `masked_key` and `key_last4`. So a leaked API response cannot leak a
 * credential, and this panel can never display a full key even to its owner.
 *
 * `testProviderKey` exists because a stored key may still be invalid — expired,
 * revoked, or out of quota. It makes a live call to the provider so the user
 * finds out here rather than when a run fails halfway through.
 *
 * Reached through `ProviderKeysGate`, which hides this panel entirely from
 * roles without `keys:manage`.
 */
export function ProviderKeysPanel() {
  const [keys, setKeys] = useState<ProviderKeyOut[]>([]);
  const [drafts, setDrafts] = useState<Record<ProviderId, ProviderDraft>>({
    openai: { apiKey: "", modelName: "gpt-4.1-mini", enabled: false },
    anthropic: { apiKey: "", modelName: "claude-3-5-sonnet-latest", enabled: false },
    runpod: { apiKey: "", modelName: "", enabled: false },
    gemini: { apiKey: "", modelName: "gemini-2.5-flash-image", enabled: false },
  });
  const [visible, setVisible] = useState<Record<ProviderId, boolean>>({
    openai: false,
    anthropic: false,
    runpod: false,
    gemini: false,
  });

  const [busy, setBusy] = useState("");

  useEffect(() => {
    listProviderKeys()
      .then((rows) => {
        setKeys(rows);
        setDrafts((current) => {
          const next = { ...current };
          for (const row of rows) {
            next[row.provider] = {
              apiKey: "",
              modelName: row.model_name || current[row.provider].modelName,
              enabled: row.is_enabled,
            };
          }
          return next;
        });
      })
      .catch(() => {
        /* backend may not have provider-keys yet — that's fine, don't spam */
      });
  }, []);

  const upsertKey = (row: ProviderKeyOut) =>
    setKeys((items) => [row, ...items.filter((item) => item.provider !== row.provider)]);

  const savedFor = (provider: ProviderId) => keys.find((item) => item.provider === provider);
  const updateDraft = (provider: ProviderId, patch: Partial<(typeof drafts)[ProviderId]>) =>
    setDrafts((current) => ({ ...current, [provider]: { ...current[provider], ...patch } }));

  const saveKey = async (provider: ProviderId) => {
    const draft = drafts[provider];
    if (!draft.apiKey.trim()) {
      toast.error("Paste an API key before saving.");
      return;
    }
    setBusy(`save-${provider}`);
    try {
      const row = await saveProviderKey({
        provider,
        api_key: draft.apiKey.trim(),
        model_name: draft.modelName.trim(),
        is_enabled: draft.enabled,
      });
      upsertKey(row);
      updateDraft(provider, { apiKey: "" });
      toast.success(`${provider === "openai" ? "OpenAI" : "Claude"} key saved`, {
        description: `Stored as ${row.masked_key}. Raw key never leaves the server.`,
      });
    } catch (e) {
      toast.error(friendlyError(e, "Could not save provider key"));
    } finally {
      setBusy("");
    }
  };

  const clearKey = async (provider: ProviderId) => {
    setBusy(`clear-${provider}`);
    try {
      await deleteProviderKey(provider);
      setKeys((items) => items.filter((item) => item.provider !== provider));
      updateDraft(provider, { apiKey: "", enabled: false });
      toast.success("Provider key cleared");
    } catch (e) {
      toast.error(friendlyError(e, "Could not clear provider key"));
    } finally {
      setBusy("");
    }
  };

  const testKey = async (provider: ProviderId) => {
    setBusy(`test-${provider}`);
    try {
      const result = await testProviderKey(provider);
      const notify = result.ok ? toast.success : toast.warning;
      notify(result.status.replace("_", " "), { description: result.detail });
      setKeys((items) =>
        items.map((item) =>
          item.provider === provider
            ? { ...item, test_status: result.status, last_tested_at: result.tested_at }
            : item,
        ),
      );
    } catch (e) {
      toast.error(friendlyError(e, "Could not test provider key"));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="panel overflow-hidden">
      <SectionHeader icon="⌘">PROVIDER KEYS</SectionHeader>
      <div className="grid gap-5 p-5 xl:grid-cols-2">
        {PROVIDERS.map((provider) => {
          const saved = savedFor(provider.id);
          const draft = drafts[provider.id];
          return (
            <div
              key={provider.id}
              className="rounded-md border border-panel-border bg-background/40 p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-serif text-2xl text-foreground">{provider.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {provider.helper}
                  </p>
                </div>
                <span className="inline-flex items-center gap-2 rounded-full border border-panel-border px-3 py-1 font-mono text-[10px] tracking-[0.12em] text-muted-foreground">
                  <Dot tone={saved ? "success" : "muted"} pulse={Boolean(saved)} />
                  {saved ? saved.masked_key : "NOT SET"}
                </span>
              </div>

              <div className="mt-4 grid gap-3">
                <label>
                  <span className="mono-label">{provider.label}</span>
                  <div className="mt-2 flex gap-2">
                    <input
                      value={draft.apiKey}
                      onChange={(event) => updateDraft(provider.id, { apiKey: event.target.value })}
                      type={visible[provider.id] ? "text" : "password"}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={provider.placeholder}
                      className="min-w-0 flex-1 rounded-md border border-panel-border bg-background/60 px-3 py-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setVisible((state) => ({ ...state, [provider.id]: !state[provider.id] }))
                      }
                      className="rounded-md border border-panel-border px-3 py-2 font-mono text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      {visible[provider.id] ? "Hide" : "Show"}
                    </button>
                  </div>
                </label>

                <label>
                  <span className="mono-label">{provider.modelLabel}</span>
                  {provider.id === "runpod" ? (
                    <input
                      value={draft.modelName}
                      onChange={(event) =>
                        updateDraft(provider.id, { modelName: event.target.value })
                      }
                      placeholder="endpoint id"
                      className="mt-2 w-full rounded-md border border-panel-border bg-background/60 px-3 py-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none"
                    />
                  ) : (
                    <div className="mt-2 flex gap-2">
                      <select
                        value={
                          provider.models.includes(draft.modelName) ? draft.modelName : "__custom"
                        }
                        onChange={(event) => {
                          const v = event.target.value;
                          if (v === "__custom") return;
                          updateDraft(provider.id, { modelName: v });
                        }}
                        className="min-w-0 flex-1 rounded-md border border-panel-border bg-background/60 px-3 py-2.5 font-mono text-xs text-foreground focus:border-primary focus:outline-none"
                      >
                        {provider.models.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                        <option value="__custom">custom…</option>
                      </select>
                      {!provider.models.includes(draft.modelName) && (
                        <input
                          value={draft.modelName}
                          onChange={(event) =>
                            updateDraft(provider.id, { modelName: event.target.value })
                          }
                          placeholder="custom model id"
                          className="min-w-0 flex-1 rounded-md border border-panel-border bg-background/60 px-3 py-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none"
                        />
                      )}
                    </div>
                  )}
                </label>

                <label className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) =>
                      updateDraft(provider.id, { enabled: event.target.checked })
                    }
                  />
                  Enable for real runs
                </label>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => saveKey(provider.id)}
                    disabled={busy === `save-${provider.id}`}
                    className="rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:opacity-95 disabled:opacity-50"
                  >
                    Save key
                  </button>
                  <button
                    type="button"
                    onClick={() => testKey(provider.id)}
                    disabled={!saved || busy === `test-${provider.id}`}
                    className="rounded-md border border-panel-border px-4 py-2 font-mono text-xs text-foreground hover:border-foreground/40 disabled:opacity-50"
                  >
                    Test
                  </button>
                  <button
                    type="button"
                    onClick={() => clearKey(provider.id)}
                    disabled={!saved || busy === `clear-${provider.id}`}
                    className="rounded-md border border-destructive/40 px-4 py-2 font-mono text-xs text-destructive hover:border-destructive disabled:opacity-50"
                  >
                    Clear
                  </button>
                </div>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {saved
                    ? `Configured · last test: ${saved.test_status.replace("_", " ")}`
                    : "Mock runs work without an API key."}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Console page ─────────────────────────────────────────────────────────

// ─── Budget / capability meter ─────────────────────────────────────────────

/**
 * Spend against the monthly budget.
 *
 * Fed by `getUsage()`, polled every 60 seconds from `ConsolePage` and refreshed
 * immediately whenever a run finishes. Exceeding the cap is what produces the
 * HTTP 402 handled in `RunSetupCard.doStart`.
 */
export function UsageBudgetPanel({
  usage,
  capabilities,
  loading,
}: {
  usage: UsageOut | null;
  capabilities: CapabilitiesOut | null;
  loading: boolean;
}) {
  const spend = usage?.monthly_spend ?? 0;
  const limit = usage?.monthly_limit ?? 0;
  const pct = limit > 0 ? Math.min(100, (spend / limit) * 100) : 0;
  const over = Boolean(usage?.over_budget);
  const reasons = capabilities?.reasons ?? {};

  const caps: Array<{ key: string; label: string; ok: boolean }> = [
    { key: "real_run_ready", label: "runs", ok: Boolean(capabilities?.real_run_ready) },
    { key: "execute_ready", label: "code execution", ok: Boolean(capabilities?.execute_ready) },
    { key: "figures_ready", label: "figures", ok: Boolean(capabilities?.figures_ready) },
  ];

  return (
    <div className="panel overflow-hidden">
      <BentoHead
        kicker="spend · capability"
        title="Monthly budget"
        subtitle="Live from the runner. Runs are blocked once the monthly cap is reached."
        meta={
          <>
            <MetaChip tone={over ? "error" : usage ? "success" : "muted"}>
              {loading ? "loading" : over ? "over budget" : usage ? "within budget" : "unavailable"}
            </MetaChip>
            {capabilities?.enabled_providers?.length ? (
              <MetaChip>{capabilities.enabled_providers.join(" · ")}</MetaChip>
            ) : null}
          </>
        }
      />
      <div className="p-5">
        {over && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[11px] text-destructive">
            Monthly spend cap reached — new runs are disabled until the limit resets or is raised.
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile label="spent" value={usage ? `$${spend.toFixed(2)}` : "—"} />
          <StatTile label="limit" value={usage ? `$${limit.toFixed(2)}` : "—"} />
          <StatTile
            label="remaining"
            value={usage ? `$${usage.remaining.toFixed(2)}` : "—"}
            hint={over ? "cap reached" : undefined}
          />
        </div>

        <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-panel-border">
          <div
            className={`h-full rounded-full ${over ? "bg-destructive" : "bg-primary"}`}
            style={{ width: `${over ? 100 : pct}%` }}
          />
        </div>

        <div className="mt-5 grid gap-2 sm:grid-cols-3">
          {caps.map((c) => (
            <div
              key={c.key}
              className="rounded-md border border-panel-border bg-background/40 px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <Dot tone={c.ok ? "success" : "warning"} />
                <span className="font-mono text-[11px] text-foreground">{c.label}</span>
              </div>
              {!c.ok && (
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                  {reasons[c.key] ?? "unavailable on the server"}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Gate G3 · targeted paper revision ─────────────────────────────────────

// ─── Revisions ─────────────────────────────────────────────────────────────

/**
 * GATE G3 — request targeted edits to the finished paper.
 *
 * The alternative to regenerating everything: describe a specific change and
 * have the agent apply just that. Far cheaper than a fresh run, and it keeps
 * the parts that were already approved.
 *
 * Follows the same estimate → preview → apply discipline as gate G2, with one
 * addition — `previewRevision` returns the actual DIFF, so the reviewer sees
 * the exact edit before committing to it, not merely its projected cost. The
 * matching API functions are in the "Targeted paper revisions" section of
 * lib/api.ts.
 */
