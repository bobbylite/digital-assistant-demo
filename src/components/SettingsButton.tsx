"use client";

import { useEffect, useState } from "react";

interface Settings {
  defaultRegion: string;
  defaultQualifier: string;
  defaultHarnessArn: string;
  agentClientId: string;
  agentScope: string;
  agentExchangeScope: string;
  hasAgentClientSecret: boolean;
}

const inputClass =
  "w-full rounded-lg border border-border bg-canvas px-3 py-1.5 text-sm text-ink placeholder:text-ink-muted/60 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20";
const labelClass = "mb-1 block text-xs font-medium uppercase tracking-wide text-ink-muted";

// Gated on being signed in (see TopBar) — this edits AGENT_CLIENT_ID and,
// via POST, AGENT_CLIENT_SECRET, straight into .env.local on the server.
// Deliberately does NOT cover OIDC_* / SESSION_SECRET: those have to already
// be set correctly for "signed in" to be possible at all, so there's no
// bootstrapping path where this panel could configure them — see CLAUDE.md.
export function SettingsButton({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [form, setForm] = useState({
    defaultRegion: "",
    defaultQualifier: "",
    defaultHarnessArn: "",
    agentClientId: "",
    agentClientSecret: "",
    agentScope: "",
    agentExchangeScope: "",
  });
  const [message, setMessage] = useState<{ text: string; tone: "success" | "warning" | "error" } | null>(null);
  // Derived, not its own state: true exactly while the modal is open and
  // the initial fetch below hasn't resolved (success or failure) yet. Every
  // setState in that fetch happens inside a .then()/.catch() continuation,
  // never synchronously in the effect body, so there's nothing to reset
  // eagerly on open — closeAndReset() below clears `settings`/`message` on
  // close instead, which is what puts this back into a "loading" state the
  // next time the modal opens.
  const loading = open && !settings && !message;

  function closeAndReset() {
    setOpen(false);
    setSettings(null);
    setMessage(null);
  }

  useEffect(() => {
    if (!open) return;
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data: Settings) => {
        setSettings(data);
        setForm({
          defaultRegion: data.defaultRegion,
          defaultQualifier: data.defaultQualifier,
          defaultHarnessArn: data.defaultHarnessArn,
          agentClientId: data.agentClientId,
          agentClientSecret: "",
          agentScope: data.agentScope,
          agentExchangeScope: data.agentExchangeScope,
        });
      })
      .catch(() => setMessage({ text: "Couldn't load current settings.", tone: "error" }));
  }, [open]);

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      const body: Record<string, string> = {
        defaultRegion: form.defaultRegion,
        defaultQualifier: form.defaultQualifier,
        defaultHarnessArn: form.defaultHarnessArn,
        agentClientId: form.agentClientId,
        agentScope: form.agentScope,
        agentExchangeScope: form.agentExchangeScope,
      };
      // Only sent if the operator actually typed a new one — an empty field
      // means "leave the current secret alone," not "clear it."
      if (form.agentClientSecret.trim()) {
        body.agentClientSecret = form.agentClientSecret;
      }

      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      setSettings(data.settings);
      setForm((prev) => ({ ...prev, agentClientSecret: "" }));
      setMessage(
        data.persisted
          ? { text: "Saved — applied now and written to .env.local.", tone: "success" }
          : { text: `Saved, but not persisted: ${data.warning}`, tone: "warning" }
      );
      onSaved();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : "Save failed.", tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Settings"
        aria-label="Settings"
        className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition hover:bg-canvas hover:text-ink"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          <path
            d="M19.4 13.5a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V19.5a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H4.5a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 6.1 8.6a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H10.5a1.65 1.65 0 0 0 1-1.51V2.5a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V8.5a1.65 1.65 0 0 0 1.51 1H19.5a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
          onClick={closeAndReset}
        >
          <div
            className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-lg border border-border bg-surface p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">Settings</h2>
              <button
                type="button"
                onClick={closeAndReset}
                className="text-ink-muted transition hover:text-ink"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {loading ? (
              <p className="text-sm text-ink-muted">Loading…</p>
            ) : (
              <div className="space-y-4">
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                    Connection defaults
                  </p>
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className={labelClass}>Region</label>
                        <input
                          value={form.defaultRegion}
                          onChange={(e) => setForm((f) => ({ ...f, defaultRegion: e.target.value }))}
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label className={labelClass}>Qualifier</label>
                        <input
                          value={form.defaultQualifier}
                          onChange={(e) => setForm((f) => ({ ...f, defaultQualifier: e.target.value }))}
                          className={inputClass}
                        />
                      </div>
                    </div>
                    <div>
                      <label className={labelClass}>Harness ARN</label>
                      <input
                        value={form.defaultHarnessArn}
                        onChange={(e) => setForm((f) => ({ ...f, defaultHarnessArn: e.target.value }))}
                        placeholder="arn:aws:bedrock-agentcore:..."
                        className={`${inputClass} font-mono text-xs`}
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                    Agent identity (RFC 8693)
                  </p>
                  <div className="space-y-3">
                    <div>
                      <label className={labelClass}>Client ID</label>
                      <input
                        value={form.agentClientId}
                        onChange={(e) => setForm((f) => ({ ...f, agentClientId: e.target.value }))}
                        className={`${inputClass} font-mono text-xs`}
                      />
                    </div>
                    <div>
                      <label className={labelClass}>Client secret</label>
                      <input
                        type="password"
                        value={form.agentClientSecret}
                        onChange={(e) => setForm((f) => ({ ...f, agentClientSecret: e.target.value }))}
                        placeholder={settings?.hasAgentClientSecret ? "Unchanged" : "Not set"}
                        className={`${inputClass} font-mono text-xs`}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className={labelClass}>Scope</label>
                        <input
                          value={form.agentScope}
                          onChange={(e) => setForm((f) => ({ ...f, agentScope: e.target.value }))}
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label className={labelClass}>Exchange scope</label>
                        <input
                          value={form.agentExchangeScope}
                          onChange={(e) => setForm((f) => ({ ...f, agentExchangeScope: e.target.value }))}
                          className={inputClass}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {message && (
                  <p
                    className={`text-xs ${
                      message.tone === "success"
                        ? "text-success"
                        : message.tone === "warning"
                          ? "text-brand"
                          : "text-danger"
                    }`}
                  >
                    {message.text}
                  </p>
                )}

                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="w-full rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
