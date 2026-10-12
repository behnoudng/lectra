import { useEffect, useState } from "react";
import { api, time, money } from "./api";
import { NumberField } from "./NumberField";
import {
  defaults,
  type Course,
  type Lecture,
  type Options,
  type Estimate,
  type ProviderStatus,
} from "./types";
export function Review({
  lecture,
  courses,
  configured,
  onQueued,
  onError,
}: {
  lecture: Lecture;
  courses: Course[];
  configured: boolean;
  onQueued: () => void;
  onError: (message: string) => void;
}) {
  const course = courses.find((c) => c.id === lecture.course_id);
  const presetKeyterms = course?.preset.keyterms_enabled ?? true;
  const [options, setOptions] = useState<Options>({
    ...defaults,
    ...course?.preset,
    keyterms: presetKeyterms ? (course?.vocabulary ?? []) : [],
    preprocessing: {
      ...defaults.preprocessing,
      ...course?.preset.preprocessing,
      ...lecture.preprocessing,
    },
  });
  const [vocabulary, setVocabulary] = useState(
    (course?.vocabulary ?? []).join("\n"),
  );
  const [keyterms, setKeyterms] = useState(
    presetKeyterms && Boolean(course?.vocabulary.length),
  );
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [reviewVersion, setReviewVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [savePreset, setSavePreset] = useState(false);
  const [retranscribe, setRetranscribe] = useState(false);
  const [account, setAccount] = useState<ProviderStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    setEstimate(null);
    const timer = setTimeout(
      () =>
        void api<Estimate>("/jobs/estimate", "POST", {
          lecture_id: lecture.id,
          settings: options,
        })
          .then((result) => {
            if (!cancelled) setEstimate(result);
          })
          .catch((e) => {
            if (!cancelled) onError(String(e));
          }),
      350,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    options,
    lecture.id,
    JSON.stringify(lecture.edl),
    lecture.title,
    lecture.date,
    lecture.course_id,
    reviewVersion,
    onError,
  ]);
  function terms(value: string, enabled: boolean) {
    setVocabulary(value);
    setKeyterms(enabled);
    setOptions((prior) => ({
      ...prior,
      keyterms_enabled: enabled,
      keyterms: enabled
        ? value
            .split("\n")
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
    }));
  }
  async function enqueue() {
    if (!estimate) return;
    setBusy(true);
    try {
      if (savePreset && course) {
        await api("/courses/" + course.id, "PATCH", {
          name: course.name,
          preset: options,
        });
        await api("/courses/" + course.id + "/vocabulary", "PUT", {
          terms: vocabulary
            .split("\n")
            .map((t) => t.trim())
            .filter(Boolean),
        });
      }
      await api("/jobs", "POST", {
        lecture_id: lecture.id,
        settings: options,
        confirmed: true,
        review_hash: estimate.review_hash,
        retranscribe_completed: retranscribe,
      });
      onQueued();
    } catch (e) {
      setEstimate(null);
      setReviewVersion((v) => v + 1);
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="review">
      <div className="page-heading">
        <div>
          <p className="eyebrow">TRANSCRIPTION REVIEW</p>
          <h1>One final look before sending</h1>
          <p>
            Audio leaves your machine for ElevenLabs. Enqueueing authorizes paid
            transcription.
          </p>
        </div>
      </div>
      <div className="review-layout">
        <div>
          <h2>{lecture.title}</h2>
          <p>
            <bdi>{lecture.course ?? "Unfiled"}</bdi> · {lecture.date} ·{" "}
            {time(lecture.duration_ms)} edited audio
          </p>
          <div className="form-grid">
            <label>
              Provider
              <input readOnly value="ElevenLabs" />
            </label>
            <label>
              Model
              <input readOnly value="Scribe v2" />
            </label>
            <label>
              Language
              <select
                value={options.language_code ?? ""}
                onChange={(e) =>
                  setOptions({
                    ...options,
                    language_code: e.target.value || null,
                  })
                }
              >
                <option value="">Auto-detect</option>
                <option value="fas">Persian</option>
                <option value="eng">English</option>
              </select>
            </label>
            <label>
              Processing
              <select
                value={options.mode}
                onChange={(e) =>
                  setOptions({
                    ...options,
                    mode: e.target.value as Options["mode"],
                  })
                }
              >
                <option value="chunked">
                  Checkpointed chunks (recommended)
                </option>
                <option value="whole">Whole file (advanced)</option>
              </select>
            </label>
            <NumberField
              label="Target chunk duration (minutes)"
              min="1"
              max="60"
              value={options.target_ms / 60000}
              onValueChange={(value) =>
                setOptions({
                  ...options,
                  target_ms: Math.round(Number(value) * 60000),
                })
              }
            />
            <label>
              Transcription audio
              <select
                value={options.preprocessing.enabled ? "enhanced" : "clean"}
                onChange={(e) =>
                  setOptions({
                    ...options,
                    preprocessing: {
                      ...options.preprocessing,
                      enabled: e.target.value === "enhanced",
                    },
                  })
                }
              >
                <option value="clean">Clean edited audio</option>
                <option value="enhanced">Enhanced edited audio</option>
              </select>
            </label>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={options.diarize}
              onChange={(e) =>
                setOptions({
                  ...options,
                  diarize: e.target.checked,
                  num_speakers: e.target.checked ? options.num_speakers : null,
                })
              }
            />
            Label speakers (opt-in; identities are scoped to each chunk)
          </label>
          {options.diarize && (
            <NumberField
              label="Expected speaker count (optional)"
              min="1"
              max="32"
              value={options.num_speakers ?? ""}
              onValueChange={(value) =>
                setOptions({
                  ...options,
                  num_speakers: value ? Number(value) : null,
                })
              }
            />
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={options.tag_audio_events}
              onChange={(e) =>
                setOptions({ ...options, tag_audio_events: e.target.checked })
              }
            />
            Include audio-event labels
          </label>
          <h2>Course vocabulary</h2>
          <label className="check">
            <input
              type="checkbox"
              checked={keyterms}
              onChange={(e) => terms(vocabulary, e.target.checked)}
            />
            Use reviewed keyterms · {options.keyterms.length} selected
          </label>
          <label>
            Keyterms, one per line
            <textarea
              rows={6}
              value={vocabulary}
              dir="auto"
              onChange={(e) => terms(e.target.value, keyterms)}
            />
          </label>
          <p className="hint">
            Up to 1,000 terms. Each term must be under 50 characters and at most
            five words. Current vendor rules include a keyterm surcharge.
          </p>
          {course && (
            <label className="check">
              <input
                type="checkbox"
                checked={savePreset}
                onChange={(e) => setSavePreset(e.target.checked)}
              />
              Save these defaults and vocabulary back to {course.name}
            </label>
          )}
        </div>
        <aside className="cost-review">
          <p className="eyebrow">APP-SIDE ESTIMATE</p>
          <h2>
            {estimate
              ? money(estimate.estimated_cost, estimate.currency)
              : "Calculating…"}
          </h2>
          <dl>
            <div>
              <dt>Edited duration</dt>
              <dd>{time(lecture.duration_ms)}</dd>
            </div>
            <div>
              <dt>Requests</dt>
              <dd>{estimate?.requests ?? "—"}</dd>
            </div>
            <div>
              <dt>Estimated billable audio</dt>
              <dd>{estimate ? time(estimate.estimated_billable_ms) : "—"}</dd>
            </div>
            <div>
              <dt>Feature adjustment</dt>
              <dd>
                {estimate?.feature_adjustment_basis_points != null
                  ? `+${estimate.feature_adjustment_basis_points / 100}%`
                  : "Unknown"}
              </dd>
            </div>
            <div>
              <dt>Incremental payment</dt>
              <dd>Unknown</dd>
            </div>
          </dl>
          <p className="hint">
            An estimate is not a vendor invoice. Account credits, plan
            allowances, and uncertain attempts can affect what you pay.
          </p>
          {estimate?.pricing_rule && (
            <p className="hint">
              Pricing version {estimate.pricing_rule.effective_from}
              <br />
              {estimate.pricing_rule.source_note}
            </p>
          )}
          {estimate?.warnings.map((w) => (
            <p className="review-warning" key={w}>
              {w}
            </p>
          ))}
          <button
            onClick={() =>
              void api<ProviderStatus>("/provider/subscription")
                .then(setAccount)
                .catch((e) => onError(String(e)))
            }
          >
            Check account status
          </button>
          {account && (
            <p>
              {account.status}
              {account.subscription &&
                " · " +
                  String(
                    account.subscription.tier ?? "Plan details unavailable",
                  )}
              . Provider-reported usage is separate from the app ledger.
              {account.subscription &&
                typeof account.subscription.character_count === "number" && (
                  <>
                    {" "}
                    Reported account usage:{" "}
                    {account.subscription.character_count} /{" "}
                    {String(account.subscription.character_limit ?? "unknown")}{" "}
                    credits. This is account-wide usage, not a confirmed charge
                    for this lecture.
                  </>
                )}
            </p>
          )}
          {account?.message && <p className="hint">{account.message}</p>}
          {!configured && (
            <p className="notice warning">
              Transcription is disabled. Set ELEVENLABS_API_KEY in the backend
              environment. You can continue preparing audio locally.
            </p>
          )}
          {lecture.transcript_id && (
            <label className="check">
              <input
                type="checkbox"
                checked={retranscribe}
                onChange={(e) => setRetranscribe(e.target.checked)}
              />
              Create a new transcript and resubmit this lecture. Completed audio
              may be charged again.
            </label>
          )}
          <button
            className="primary wide"
            disabled={
              !configured ||
              busy ||
              !estimate ||
              (Boolean(lecture.transcript_id) && !retranscribe)
            }
            onClick={() => void enqueue()}
          >
            {busy ? "Enqueueing…" : "Confirm and enqueue"}
          </button>
          <p className="hint">
            No transcription request is sent before this confirmation.
          </p>
        </aside>
      </div>
    </section>
  );
}
