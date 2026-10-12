import { useEffect, useState } from "react";
import { api, bytes, money } from "./api";
import type { Preferences, Snapshot, ProviderStatus } from "./types";
import { defaultShortcuts, type Shortcuts } from "./types";
import { NumberField } from "./NumberField";

export function Backups({
  preferences,
  onError,
}: {
  preferences: Preferences;
  onError: (message: string) => void;
}) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [include, setInclude] = useState(preferences.include_audio);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function load() {
    setSnapshots(await api("/backups"));
  }
  useEffect(() => {
    void load().catch((e) => onError(String(e)));
  }, [onError]);
  async function command(path: string, body?: unknown) {
    setBusy(true);
    try {
      const result = await api<{
        missing_originals?: number;
        pre_restore_warning?: string | null;
      }>(path, "POST", body);
      setNotice(
        path.endsWith("/restore")
          ? "Restored. Queue remains paused. Missing omitted originals: " +
              (result.missing_originals ?? 0) +
              (result.pre_restore_warning
                ? ". Pre-restore backup failed: " + result.pre_restore_warning
                : "")
          : "Snapshot verified.",
      );
      await load();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <div className="page-heading">
        <div>
          <p className="eyebrow">LOCAL BACKUPS</p>
          <h1>A recoverable history</h1>
          <p>
            Versioned snapshots use SQLite’s online backup and verified
            checksums.
          </p>
        </div>
        <button
          className="primary"
          disabled={busy}
          onClick={() => void command("/backups", { include_audio: include })}
        >
          Back up now
        </button>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={include}
          onChange={(e) => setInclude(e.target.checked)}
        />
        Include original recordings in this snapshot
      </label>
      <p className="hint">
        Playback proxies and provider artifacts are included. Originals are
        optional. Environment credentials and .env are never included. Automatic
        policy is configured in Settings.
      </p>
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {!snapshots.length && (
        <div className="empty">
          <h2>No snapshots yet</h2>
          <p>Create one now, or let the worker make its scheduled backup.</p>
        </div>
      )}
      <div className="snapshot-list">
        {snapshots.map((s) => (
          <article key={s.id}>
            <div>
              <h2>
                {s.created_at
                  ? new Date(s.created_at).toLocaleString()
                  : "Invalid snapshot"}
              </h2>
              <p>
                {s.status} · {bytes(s.size)} ·{" "}
                {s.include_audio
                  ? "Original audio included"
                  : "Original audio omitted"}
              </p>
              <code>{s.id}</code>
            </div>
            <div className="toolbar">
              <button
                disabled={busy}
                onClick={() => void command("/backups/" + s.id + "/verify")}
              >
                Verify
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  if (
                    confirm(
                      "Restore this snapshot? The app will attempt a pre-restore backup and report any failure. The queue pauses; in-flight calls block restoration. Omitted originals can only be retained if they still exist locally.",
                    )
                  )
                    void command("/backups/" + s.id + "/restore");
                }}
              >
                Restore
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

type Budget = {
  budget: { monthly_micros: number | null; currency: string };
  ledger: {
    currency: string | null;
    charge_status: string;
    estimated_cost: number | null;
    attempts: number;
    unknown_estimates: number;
  }[];
};
export function Settings({
  preferences,
  refresh,
  onError,
}: {
  preferences: Preferences;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [prefs, setPrefs] = useState(preferences);
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [monthly, setMonthly] = useState("");
  const [rate, setRate] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [surcharge, setSurcharge] = useState(20);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    void api<ProviderStatus>("/provider/status")
      .then(setProvider)
      .catch((e) => onError(String(e)));
    void api<Budget>("/budget")
      .then((b) => {
        setBudget(b);
        setMonthly(
          b.budget.monthly_micros === null
            ? ""
            : String(b.budget.monthly_micros / 1e6),
        );
        setCurrency(b.budget.currency);
      })
      .catch((e) => onError(String(e)));
  }, [onError]);
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    try {
      await work();
      await refresh();
      setNotice("Settings saved.");
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function checkProvider() {
    setBusy(true);
    setNotice("");
    try {
      setProvider(await api<ProviderStatus>("/provider/test", "POST"));
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings">
      <div className="page-heading">
        <div>
          <p className="eyebrow">SETTINGS</p>
          <h1>Local by design</h1>
          <p>Only nonsecret preferences live here.</p>
        </div>
      </div>
      <section>
        <h2>ElevenLabs Scribe v2</h2>
        <div className="provider-checks">
          <div>
            <span>Credential loaded</span>
            <strong>
              {provider
                ? provider.key_configured
                  ? "Yes"
                  : "No"
                : "Checking…"}
            </strong>
          </div>
          <div>
            <span>ElevenLabs connection</span>
            <strong>
              {provider?.http_status
                ? "Reachable · HTTP " + provider.http_status
                : "Not checked"}
            </strong>
          </div>
          <div>
            <span>Account access · optional</span>
            <strong>
              {provider?.status === "Configured"
                ? "Not checked"
                : (provider?.status ?? "Checking…")}
            </strong>
          </div>
          <div>
            <span>Last transcription request</span>
            <strong>
              {provider?.last_transcription
                ? provider.last_transcription.state.replaceAll("_", " ") +
                  (provider.last_transcription.diagnostic?.http_status
                    ? " · HTTP " +
                      provider.last_transcription.diagnostic.http_status
                    : "")
                : "Not tested"}
            </strong>
          </div>
        </div>
        {provider?.last_transcription?.diagnostic && (
          <div className="provider-failure" role="status">
            {provider.last_transcription.diagnostic.error_message && (
              <p>{provider.last_transcription.diagnostic.error_message}</p>
            )}
            <p>{provider.last_transcription.diagnostic.help}</p>
          </div>
        )}
        {provider && (
          <p>
            Credential loaded:{" "}
            <strong>{provider.key_configured ? "Yes" : "No"}</strong>
          </p>
        )}
        {provider?.message && <p role="status">{provider.message}</p>}
        <p className="hint">
          Credential source: ELEVENLABS_API_KEY environment variable.
          <br />
          Set it in the project .env next to compose.yaml and recreate API and
          worker containers.
        </p>
        <button disabled={busy} onClick={() => void checkProvider()}>
          {busy ? "Checking account access…" : "Check account access"}
        </button>
        <p className="hint">
          This read-only check contacts ElevenLabs without sending audio. A
          reachable service or connected account does not verify transcription.
          Enable Speech to Text → Access for transcription. User → Access is
          optional for connection and account usage checks; other endpoint
          permissions are not needed.
        </p>
        <p>
          Audio is processed locally for preparation, then sent to ElevenLabs
          for transcription. This application is not fully offline.
        </p>
      </section>
      <section>
        <h2>Playback and automatic backups</h2>
        <div className="form-grid">
          <NumberField
            label="Skip backward (seconds)"
            min="1"
            max="60"
            value={prefs.skip_seconds}
            onValueChange={(value) =>
              setPrefs({ ...prefs, skip_seconds: Number(value) })
            }
          />
          <NumberField
            label="Skip forward (seconds)"
            min="1"
            max="60"
            value={prefs.skip_forward_seconds ?? prefs.skip_seconds}
            onValueChange={(value) =>
              setPrefs({
                ...prefs,
                skip_forward_seconds: Number(value),
              })
            }
          />
          <NumberField
            label="Automatic backup interval (hours)"
            min="1"
            value={prefs.backup_interval_hours}
            onValueChange={(value) =>
              setPrefs({
                ...prefs,
                backup_interval_hours: Number(value),
              })
            }
          />
        </div>
        <h3>Keyboard shortcuts</h3>
        <div className="form-grid">
          {(
            [
              ["play_pause", "Play / pause shortcut", ["Ctrl+Space", "Alt+P"]],
              [
                "backward",
                "Skip backward shortcut",
                ["Alt+ArrowLeft", "Alt+J"],
              ],
              ["forward", "Skip forward shortcut", ["Alt+ArrowRight", "Alt+L"]],
              ["help", "Shortcut help key", ["?", "Alt+H"]],
            ] as const
          ).map(([key, label, choices]) => (
            <label key={key}>
              {label}
              <select
                aria-label={label}
                value={(prefs.shortcuts ?? defaultShortcuts)[key]}
                onChange={(e) =>
                  setPrefs({
                    ...prefs,
                    shortcuts: {
                      ...(prefs.shortcuts ?? defaultShortcuts),
                      [key]: e.target.value,
                    } as Shortcuts,
                  })
                }
              >
                {choices.map((choice) => (
                  <option key={choice}>{choice}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={prefs.rewind_on_resume}
            onChange={(e) =>
              setPrefs({ ...prefs, rewind_on_resume: e.target.checked })
            }
          />
          Rewind two seconds when resuming playback
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={prefs.include_audio}
            onChange={(e) =>
              setPrefs({ ...prefs, include_audio: e.target.checked })
            }
          />
          Include original audio in automatic backups
        </label>
        <button
          disabled={busy}
          onClick={() => void action(() => api("/settings", "PATCH", prefs))}
        >
          Save preferences
        </button>
      </section>
      <section>
        <h2>Advisory monthly budget</h2>
        <p className="hint">
          Warnings help you decide. They never pretend to enforce your vendor’s
          billing limit.
        </p>
        <div className="form-grid">
          <NumberField
            label="Monthly budget (leave blank for none)"
            min="0"
            step="0.01"
            value={monthly}
            onValueChange={setMonthly}
          />
          <label>
            Currency
            <input
              value={currency}
              maxLength={3}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </label>
        </div>
        <button
          disabled={busy}
          onClick={() =>
            void action(async () => {
              const b = await api<Budget>("/budget", "PATCH", {
                monthly_micros: monthly
                  ? Math.round(Number(monthly) * 1e6)
                  : null,
                currency,
              });
              setBudget(b);
            })
          }
        >
          Save budget
        </button>
        {budget?.ledger.map((l, i) => (
          <p key={i}>
            This month: {l.attempts} {l.charge_status.replaceAll("_", " ")}{" "}
            attempts · {money(l.estimated_cost, l.currency)} app estimate ·{" "}
            {l.unknown_estimates} unknown estimates. Actual charges are
            unconfirmed.
          </p>
        ))}
      </section>
      <section>
        <h2>Versioned pricing</h2>
        <p className="hint">
          No base rate is assumed. Enter your current account’s rate and source.
          Historical jobs retain their pricing version.
        </p>
        <div className="form-grid">
          <NumberField
            label={"Base " + currency + " per audio hour"}
            min="0"
            step="0.000001"
            value={rate}
            onValueChange={setRate}
          />
          <NumberField
            label="Keyterm surcharge (%)"
            min="0"
            value={surcharge}
            onValueChange={(value) => setSurcharge(Number(value))}
          />
        </div>
        <label>
          Pricing source note
          <input
            placeholder="Account plan and date checked"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
        </label>
        <p className="hint">
          Current documented keyterm adjustment is 20%; over 100 keyterms has a
          20-second minimum per request. Recheck vendor pricing before creating
          a new rule.
        </p>
        <button
          disabled={busy || rate === "" || !source}
          onClick={() =>
            void action(() =>
              api("/pricing", "POST", {
                effective_from: new Date().toISOString(),
                currency,
                base_micros_per_hour: Math.round(Number(rate) * 1e6),
                keyterms_basis_points: Math.round(surcharge * 100),
                many_keyterms_min_ms: 20000,
                source_note: source,
              }),
            )
          }
        >
          Create pricing version
        </button>
      </section>
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
    </section>
  );
}
