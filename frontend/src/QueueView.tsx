import { useState } from "react";
import { api, money, time } from "./api";
import type { Job, Queue, Chunk } from "./types";
export function QueueView({
  queue,
  refresh,
  open,
  onError,
}: {
  queue: Queue;
  refresh: () => Promise<void>;
  open: (id: string) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState<{
    job: Job;
    chunk: Chunk;
    local: boolean;
    preparation: boolean;
  } | null>(null);
  async function command(path: string, body?: unknown, method = "POST") {
    setBusy(true);
    try {
      await api(path, method, body);
      await refresh();
      setRetry(null);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function move(job: Job, direction: number) {
    const ids = queue.jobs.filter((j) => j.state === "queued").map((j) => j.id);
    const i = ids.indexOf(job.id);
    const other = i + direction;
    if (other < 0 || other >= ids.length) return;
    [ids[i], ids[other]] = [ids[other], ids[i]];
    void command("/queue/order", { job_ids: ids }, "PATCH");
  }
  return (
    <section>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PERSISTENT QUEUE</p>
          <h1>{queue.paused ? "Queue paused" : "One lecture at a time"}</h1>
          <p>
            Closing the browser does not stop the worker. Pause waits for an
            in-flight request to finish.
          </p>
        </div>
        <button
          disabled={busy}
          className="primary"
          onClick={() =>
            void command("/queue/" + (queue.paused ? "resume" : "pause"))
          }
        >
          {queue.paused ? "Resume queue" : "Pause queue"}
        </button>
      </div>
      {!queue.jobs.length && (
        <div className="empty">
          <h2>The queue is clear</h2>
          <p>Prepare a lecture and review its settings to begin.</p>
        </div>
      )}
      <div className="job-list">
        {queue.jobs.map((job, index) => (
          <article
            className={
              "job " + (job.state === "unknown_outcome" ? "attention" : "")
            }
            key={job.id}
          >
            <div className="job-heading">
              <span className="job-number">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <button
                  className="text-button"
                  onClick={() => open(job.lecture_id)}
                >
                  <h2>{job.title}</h2>
                </button>
                <p>
                  {job.state.replaceAll("_", " ")} · {time(job.duration_ms)} ·{" "}
                  {job.chunks.filter((c) => c.state === "succeeded").length}/
                  {job.chunks.length} chunks complete
                </p>
              </div>
              <span className="pill">
                {money(job.estimated_cost, job.currency)} estimate
              </span>
            </div>
            <div className="chunk-progress" aria-label="Chunk progress">
              {job.chunks.map((c) => (
                <span
                  title={"Chunk " + (c.ordinal + 1) + ": " + c.state}
                  className={c.state}
                  key={c.id}
                >
                  {c.ordinal + 1} · {c.state.replaceAll("_", " ")}
                </span>
              ))}
            </div>
            {(job.state === "unknown_outcome" ||
              job.state === "needs_retry_approval") && (
              <div className="notice warning">
                <strong>Billing outcome unknown</strong>
                <p>
                  A request may already have been processed and billed. The
                  queue is paused. Another request may incur another charge.
                </p>
              </div>
            )}
            <div className="toolbar">
              {job.state === "queued" && (
                <>
                  <button disabled={busy} onClick={() => move(job, -1)}>
                    Move up
                  </button>
                  <button disabled={busy} onClick={() => move(job, 1)}>
                    Move down
                  </button>
                </>
              )}
              {job.chunks
                .filter((c) =>
                  [
                    "unknown_outcome",
                    "failed_local",
                    "failed_provider",
                    "needs_retry_approval",
                  ].includes(c.state),
                )
                .map((chunk) => {
                  const attempt = job.attempts
                    .filter((a) => a.chunk_id === chunk.id)
                    .at(-1);
                  const preparation =
                    chunk.state === "failed_local" && !attempt;
                  const local =
                    preparation ||
                    (chunk.state === "failed_local" &&
                      Boolean(attempt?.response_persisted_at));
                  return (
                    <button
                      key={chunk.id}
                      disabled={busy}
                      onClick={() =>
                        setRetry({ job, chunk, local, preparation })
                      }
                    >
                      {preparation
                        ? "Retry local preparation"
                        : local
                          ? "Reprocess saved response"
                          : "Review paid retry"}{" "}
                      · chunk {chunk.ordinal + 1}
                    </button>
                  );
                })}
              {!["succeeded", "canceled"].includes(job.state) && (
                <button
                  disabled={busy}
                  onClick={() => void command("/jobs/" + job.id + "/cancel")}
                >
                  Cancel / leave unresolved
                </button>
              )}
            </div>
            <details>
              <summary>
                Attempt evidence and billing audit · {job.attempts.length}{" "}
                attempts
              </summary>
              {job.attempts.length === 0 ? (
                <p className="hint">No provider requests have started.</p>
              ) : (
                job.attempts.map((a) => (
                  <div className="audit-row" key={a.id}>
                    <p>
                      Attempt {a.attempt_no} · {a.state.replaceAll("_", " ")} ·
                      charge: {a.charge_status.replaceAll("_", " ")} ·{" "}
                      {money(a.estimated_cost, a.currency)} estimate
                    </p>
                    <code>{a.id}</code>
                    <p className="hint">
                      Audio SHA-256: <bdi>{a.audio_sha256}</bdi>
                      <br />
                      Request hash: <bdi>{a.request_hash}</bdi>
                      {a.retry_of_attempt_id && (
                        <>
                          <br />
                          Retry of {a.retry_of_attempt_id}
                        </>
                      )}
                    </p>
                  </div>
                ))
              )}
            </details>
          </article>
        ))}
      </div>
      {retry && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="retry-title"
            className="modal"
          >
            <h2 id="retry-title">
              {retry.local
                ? "Recover from saved evidence"
                : "Authorize another provider request?"}
            </h2>
            <p>
              {retry.preparation
                ? "No provider request started for this chunk. Retry local preparation, then continue the transcription already approved at preflight."
                : retry.local
                  ? "The successful raw response is already stored. This retries local normalization and sends no audio."
                  : "The previous attempt remains in the ledger. If it was processed, retrying can charge you again."}
            </p>
            {!retry.local && (
              <p>
                Estimated incremental cost:{" "}
                {money(
                  retry.job.attempts
                    .filter((a) => a.chunk_id === retry.chunk.id)
                    .at(-1)?.estimated_cost ?? null,
                  retry.job.currency,
                )}
                . Actual payment remains unconfirmed.
              </p>
            )}
            <div className="page-actions">
              <button disabled={busy} onClick={() => setRetry(null)}>
                Go back
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void command("/jobs/" + retry.job.id + "/retry", {
                    chunk_id: retry.chunk.id,
                    authorize_charge: !retry.local,
                    reason: retry.local
                      ? retry.preparation
                        ? "Local preparation recovery"
                        : "Local normalization recovery"
                      : "User explicitly accepted another-charge risk",
                  })
                }
              >
                {retry.local
                  ? "Reprocess locally"
                  : "I accept the risk — retry"}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
