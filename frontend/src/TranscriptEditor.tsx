import { useCallback, useEffect, useRef, useState } from "react";
import {
  FORMAT_TEXT_COMMAND,
  $getSelection,
  $isRangeSelection,
  type LexicalEditor,
} from "lexical";
import { $setBlocksType } from "@lexical/selection";
import { $createHeadingNode } from "@lexical/rich-text";
import { $createParagraphNode } from "lexical";
import { api, ApiError, time } from "./api";
import { readDrafts, writeDraft, deleteDraft, type Draft } from "./drafts";
import { RichBlock } from "./RichBlock";
import type { Block, Transcript, Preferences, Lecture } from "./types";
import { defaultShortcuts } from "./types";

type Revision = { revision: number; reason: string; created_at: string };
type Props = {
  lecture: Lecture;
  preferences: Preferences;
  onError: (message: string) => void;
  seekMs?: number | null;
};
export function TranscriptEditor({
  lecture,
  preferences,
  onError,
  seekMs,
}: Props) {
  const [document, setDocument] = useState<Transcript | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const base = useRef(0);
  const sequence = useRef(0);
  const dirty = useRef(false);
  const saving = useRef(false);
  const pendingSave = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState("Loading");
  const [mode, setMode] = useState<"synced" | "document">("synced");
  const [recovery, setRecovery] = useState<Draft | null>(null);
  const [draftChoices, setDraftChoices] = useState<Draft[]>([]);
  const draftOwner = useRef(crypto.randomUUID());
  const recoveredDraft = useRef<Draft | null>(null);
  const draftWarning = useRef(false);
  const [conflict, setConflict] = useState<Transcript | null>(null);
  const blocked = useRef(false);
  const [duration, setDuration] = useState(lecture.duration_ms);
  const [mediaId, setMediaId] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [follow, setFollow] = useState(true);
  const [loop, setLoop] = useState<{ start: number; end: number } | null>(null);
  const [help, setHelp] = useState(false);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [exportTimestamps, setExportTimestamps] = useState(false);
  const [exportSpeakers, setExportSpeakers] = useState(false);
  const [exporting, setExporting] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const activeEditor = useRef<LexicalEditor | null>(null);
  const documentRef = useRef(document);
  documentRef.current = document;
  const [activeBlock, setActiveBlock] = useState<string | null>(null);
  const shortcuts = preferences.shortcuts ?? defaultShortcuts;
  const forwardSeconds =
    preferences.skip_forward_seconds ?? preferences.skip_seconds;
  const persist = useCallback(
    async (next: Block[]) => {
      if (!lecture.transcript_id) return;
      try {
        await writeDraft({
          id: lecture.transcript_id,
          base_revision: base.current,
          blocks: next,
          at: Date.now(),
          owner: draftOwner.current,
        });
      } catch {
        if (!draftWarning.current)
          onError(
            "Browser draft storage is unavailable. Server autosave continues; keep this tab open until saved.",
          );
        draftWarning.current = true;
      }
    },
    [lecture.transcript_id, onError],
  );
  const saveRef = useRef<(reason?: string) => Promise<void>>(async () => {});
  const performSave = useCallback(
    async (reason = "autosave") => {
      const current = documentRef.current;
      if (
        !current ||
        saving.current ||
        blocked.current ||
        (!dirty.current && reason === "autosave")
      )
        return;
      saving.current = true;
      const seq = sequence.current;
      const sent = blocksRef.current;
      setStatus("Saving…");
      try {
        const result = await api<Transcript>(
          "/transcripts/" + current.id,
          "PATCH",
          { base_revision: base.current, blocks: sent, reason },
        );
        base.current = result.revision;
        if (!mounted.current) return;
        setDocument(result);
        if (seq === sequence.current) {
          dirty.current = false;
          setBlocks(result.blocks);
          blocksRef.current = result.blocks;
          await deleteDraft(current.id, draftOwner.current).catch(() => {});
          if (recoveredDraft.current) {
            const draft = recoveredDraft.current;
            await deleteDraft(current.id, draft.owner, draft.at).catch(
              () => {},
            );
            recoveredDraft.current = null;
          }
          if (seq === sequence.current)
            setStatus("Saved · revision " + result.revision);
        } else {
          await persist(blocksRef.current);
          setStatus("Saving recent changes…");
          timer.current = setTimeout(() => void saveRef.current(), 400);
        }
      } catch (error) {
        if (!mounted.current) return;
        if (error instanceof ApiError && error.category === "editor_conflict") {
          blocked.current = true;
          setStatus("Conflict · draft retained");
          try {
            setConflict(await api<Transcript>("/transcripts/" + current.id));
          } catch {
            onError(
              "Could not load the conflicting server revision. Your local draft remains available; reload when the service returns.",
            );
          }
        } else {
          setStatus("Save failed · draft retained");
          onError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        saving.current = false;
      }
    },
    [onError, persist],
  );
  const save = useCallback(
    (reason = "autosave") => {
      if (pendingSave.current) return pendingSave.current;
      const request = performSave(reason);
      pendingSave.current = request;
      const clear = () => {
        if (pendingSave.current === request) pendingSave.current = null;
      };
      void request.then(clear, clear);
      return request;
    },
    [performSave],
  );
  saveRef.current = save;
  async function flush() {
    if (timer.current) clearTimeout(timer.current);
    for (let i = 0; i < 3; i++) {
      await saveRef.current();
      if (blocked.current || !mounted.current) return false;
      if (!dirty.current && !saving.current) return true;
    }
    onError(
      "Recent edits are still unsaved. Keep the draft and retry after the save finishes.",
    );
    return false;
  }
  async function download(format: "txt" | "md") {
    setExporting(true);
    try {
      if (!(await flush())) return;
      const response = await fetch(
        "/api/v1/lectures/" +
          lecture.id +
          "/export?format=" +
          format +
          "&timestamps=" +
          exportTimestamps +
          "&speakers=" +
          exportSpeakers,
      );
      if (!response.ok)
        throw new Error(
          "Export failed. Your saved transcript remains available.",
        );
      const url = URL.createObjectURL(await response.blob());
      const link = documentGlobal.createElement("a");
      link.href = url;
      link.download = "lecture." + format;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      onError(String(error));
    } finally {
      setExporting(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const id = lecture.transcript_id;
    if (!id) {
      setStatus("No transcript");
      return;
    }
    void Promise.all([
      api<Transcript>("/transcripts/" + id),
      readDrafts(id).catch(() => {
        draftWarning.current = true;
        onError(
          "Browser draft storage is unavailable. Server autosave continues; keep this tab open until saved.",
        );
        return [] as Draft[];
      }),
    ])
      .then(([server, drafts]) => {
        if (cancelled) return;
        base.current = server.revision;
        setDocument(server);
        setBlocks(server.blocks);
        setStatus("Saved · revision " + server.revision);
        const choices = drafts.filter(
          (draft) =>
            JSON.stringify(draft.blocks) !== JSON.stringify(server.blocks),
        );
        setDraftChoices(choices);
        if (choices.length) {
          setRecovery(choices[0]);
          blocked.current = true;
          setStatus("Recovery available");
        }
      })
      .catch((e) => onError(String(e)));
    void api<{ id: string; duration_ms: number }>(
      "/transcripts/" + id + "/playback",
      "POST",
    )
      .then((result) => {
        if (!cancelled) {
          setMediaId(result.id);
          setDuration(result.duration_ms);
        }
      })
      .catch((e) => onError(String(e)));
    return () => {
      cancelled = true;
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      if (dirty.current) void persist(blocksRef.current);
    };
  }, [lecture.transcript_id, onError, persist]);
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => {
      if (dirty.current) {
        event.preventDefault();
        void persist(blocksRef.current);
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [persist]);
  const changed = useCallback(
    (next: Block[]) => {
      blocksRef.current = next;
      setBlocks(next);
      dirty.current = true;
      sequence.current++;
      setStatus("Unsaved · local draft");
      void persist(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void saveRef.current(), 800);
    },
    [persist],
  );
  const update = useCallback(
    (id: string, patch: Partial<Block>) => {
      const next = blocksRef.current.map((b) =>
        b.id !== id
          ? b
          : ({
              ...b,
              ...patch,
              alignment_status:
                patch.text !== undefined && patch.text !== b.text
                  ? b.start_ms !== null
                    ? "edited_anchor"
                    : "unaligned"
                  : b.alignment_status,
            } as Block),
      );
      changed(next);
    },
    [changed],
  );
  const focus = useCallback((editor: LexicalEditor) => {
    activeEditor.current = editor;
  }, []);
  const seek = useCallback((ms: number) => {
    if (audio.current) audio.current.currentTime = Math.max(0, ms / 1000);
  }, []);
  useEffect(() => {
    if (mediaId && seekMs !== null && seekMs !== undefined) {
      const el = audio.current;
      if (!el) return;
      const move = () => seek(seekMs);
      if (el.readyState) move();
      else {
        el.addEventListener("loadedmetadata", move, { once: true });
        return () => el.removeEventListener("loadedmetadata", move);
      }
    }
  }, [mediaId, seekMs, seek]);
  const toggle = useCallback(() => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) {
      if (preferences.rewind_on_resume)
        el.currentTime = Math.max(0, el.currentTime - 2);
      void el.play().catch(() => onError("Audio playback could not start."));
    } else el.pause();
  }, [preferences.rewind_on_resume, onError]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.isComposing || e.metaKey) return;
      const target = e.target as HTMLElement;
      const editing =
        target.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      const binding =
        (e.ctrlKey ? "Ctrl+" : "") +
        (e.altKey ? "Alt+" : "") +
        (e.code === "Space"
          ? "Space"
          : e.key.startsWith("Arrow")
            ? e.key
            : e.key.toUpperCase());
      if (
        (e.code === "Space" &&
          !editing &&
          !e.ctrlKey &&
          !e.altKey &&
          !e.metaKey) ||
        binding === shortcuts.play_pause
      ) {
        e.preventDefault();
        toggle();
      } else if (
        binding === shortcuts.backward ||
        binding === shortcuts.forward
      ) {
        e.preventDefault();
        seek(
          (audio.current?.currentTime ?? 0) * 1000 +
            (binding === shortcuts.backward
              ? -preferences.skip_seconds
              : forwardSeconds) *
              1000,
        );
      } else if (
        shortcuts.help === "?"
          ? e.key === "?" && !editing
          : binding === shortcuts.help
      ) {
        e.preventDefault();
        setHelp((v) => !v);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [
    toggle,
    seek,
    preferences.skip_seconds,
    forwardSeconds,
    shortcuts.play_pause,
    shortcuts.backward,
    shortcuts.forward,
    shortcuts.help,
  ]);
  useEffect(() => {
    const active = blocks.find(
      (b) =>
        b.start_ms !== null &&
        b.end_ms !== null &&
        position >= b.start_ms &&
        position < b.end_ms,
    );
    setActiveBlock(active?.id ?? null);
  }, [position, blocks]);
  useEffect(() => {
    if (
      follow &&
      activeBlock &&
      mode === "synced" &&
      !window.getSelection()?.isCollapsed
    )
      return;
    if (follow && activeBlock && mode === "synced")
      documentGlobal
        .getElementById("block-" + activeBlock)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [activeBlock, follow, mode]);
  async function recover() {
    if (!recovery || !document) return;
    const draft = recovery;
    recoveredDraft.current = draft;
    setRecovery(null);
    setBlocks(draft.blocks);
    blocksRef.current = draft.blocks;
    dirty.current = true;
    sequence.current++;
    if (draft.base_revision !== document.revision) {
      setConflict(document);
      blocked.current = true;
      setStatus("Review recovered draft against server");
    } else {
      blocked.current = false;
      void persist(draft.blocks);
      void saveRef.current();
    }
  }
  async function useServer(server: Transcript) {
    blocked.current = false;
    dirty.current = false;
    base.current = server.revision;
    setDocument(server);
    setBlocks(server.blocks);
    blocksRef.current = server.blocks;
    setConflict(null);
    setRecovery(null);
    await deleteDraft(server.id, draftOwner.current).catch(() => {});
    const discarded = recovery ?? recoveredDraft.current;
    if (discarded)
      await deleteDraft(server.id, discarded.owner, discarded.at).catch(
        () => {},
      );
    recoveredDraft.current = null;
    setStatus("Saved · revision " + server.revision);
  }
  async function history() {
    if (!document) return;
    setRevisions(await api("/transcripts/" + document.id + "/revisions"));
    setShowHistory((v) => !v);
  }
  async function restore(revision: number) {
    if (
      !document ||
      !confirm(
        "Restore revision " +
          revision +
          "? A new revision preserves the current history.",
      )
    )
      return;
    try {
      const result = await api<Transcript>(
        "/transcripts/" +
          document.id +
          "/revisions/" +
          revision +
          "/restore?base_revision=" +
          base.current,
        "POST",
      );
      await useServer(result);
      setShowHistory(false);
    } catch (e) {
      onError(String(e));
    }
  }
  function format(style: "bold" | "italic" | "code") {
    activeEditor.current?.dispatchCommand(FORMAT_TEXT_COMMAND, style);
  }
  function heading(type: "paragraph" | "h1" | "h2") {
    activeEditor.current?.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection))
        $setBlocksType(selection, () =>
          type === "paragraph"
            ? $createParagraphNode()
            : $createHeadingNode(type),
        );
    });
  }
  if (!lecture.transcript_id)
    return (
      <section className="empty">
        <h1>No transcript yet</h1>
        <p>
          Prepare the audio, review the settings, and queue this lecture.
          Completed chunks appear as they become available.
        </p>
      </section>
    );
  if (!document) return <p role="status">Loading transcript…</p>;
  return (
    <section className={"editor " + mode}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">TRANSCRIPT EDITOR</p>
          <h1>{lecture.title}</h1>
          <p>
            <bdi>{lecture.course ?? "Unfiled"}</bdi> · {lecture.date}
          </p>
          {draftChoices.length > 1 && (
            <label>
              Choose a browser draft
              <select
                value={draftChoices.findIndex(
                  (draft) =>
                    draft.owner === recovery?.owner &&
                    draft.at === recovery?.at,
                )}
                onChange={(e) =>
                  setRecovery(draftChoices[Number(e.target.value)])
                }
              >
                {draftChoices.map((draft, i) => (
                  <option key={draft.owner ?? "legacy"} value={i}>
                    {new Date(draft.at).toLocaleString()} ·{" "}
                    {draft.blocks
                      .map((b) => b.text)
                      .join(" ")
                      .slice(0, 70)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <span role="status" className="save-status">
          {status}
        </span>
      </div>
      {recovery && (
        <div className="notice">
          <strong>A browser draft is available</strong>
          <p>
            Recent edits from {new Date(recovery.at).toLocaleString()} may not
            have reached the server.
          </p>
          <button onClick={() => void recover()}>Recover local draft</button>
          <button onClick={() => void useServer(document)}>
            Use saved transcript
          </button>
        </div>
      )}
      {conflict && (
        <div className="notice warning">
          <h2>Another tab or the worker saved a newer revision</h2>
          <p>
            Your draft is retained. Compare the versions before choosing how to
            recover.
          </p>
          <div className="compare">
            <div>
              <h3>Your draft</h3>
              <pre dir="auto">{blocks.map((b) => b.text).join("\n\n")}</pre>
            </div>
            <div>
              <h3>Server · revision {conflict.revision}</h3>
              <pre dir="auto">
                {conflict.blocks.map((b) => b.text).join("\n\n")}
              </pre>
            </div>
          </div>
          <button onClick={() => void useServer(conflict)}>
            Use server version
          </button>
          <button
            onClick={() => {
              base.current = conflict.revision;
              setConflict(null);
              blocked.current = false;
              dirty.current = true;
              void persist(blocksRef.current);
              void saveRef.current("conflict recovery");
            }}
          >
            Save my reviewed draft as a new revision
          </button>
        </div>
      )}
      <div className="editor-tools">
        <div className="segmented">
          <button
            aria-pressed={mode === "synced"}
            onClick={() => setMode("synced")}
          >
            Audio-synced
          </button>
          <button
            aria-pressed={mode === "document"}
            onClick={() => setMode("document")}
          >
            Document
          </button>
        </div>
        <div className="toolbar">
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => format("bold")}
          >
            <strong>Bold</strong>
          </button>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => format("italic")}
          >
            <em>Italic</em>
          </button>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => format("code")}
          >
            Code
          </button>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => heading("h2")}
          >
            Heading
          </button>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => heading("paragraph")}
          >
            Paragraph
          </button>
        </div>
      </div>
      {mode === "synced" && (
        <div className="playback sticky">
          <div className="toolbar">
            <button
              onClick={() =>
                seek(
                  (audio.current?.currentTime ?? 0) * 1000 -
                    preferences.skip_seconds * 1000,
                )
              }
            >
              ← {preferences.skip_seconds}s
            </button>
            <button className="primary" onClick={toggle}>
              Play / pause
            </button>
            <button
              onClick={() =>
                seek(
                  (audio.current?.currentTime ?? 0) * 1000 +
                    forwardSeconds * 1000,
                )
              }
            >
              {forwardSeconds}s →
            </button>
            <bdi>
              {time(position)} / {time(duration)}
            </bdi>
            <label>
              Speed
              <select
                value={speed}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setSpeed(v);
                  if (audio.current) audio.current.playbackRate = v;
                }}
              >
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => (
                  <option key={v} value={v}>
                    {v}×
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
              />
              Follow audio
            </label>
            <button onClick={() => setHelp((v) => !v)}>Shortcuts</button>
            {loop && (
              <button onClick={() => setLoop(null)}>Stop passage loop</button>
            )}
          </div>
          <input
            aria-label="Audio position"
            type="range"
            min="0"
            max={duration}
            value={Math.min(position, duration)}
            onChange={(e) => seek(Number(e.target.value))}
          />
        </div>
      )}
      <audio
        ref={audio}
        src={mediaId ? "/api/v1/media/" + mediaId : undefined}
        onLoadedMetadata={() => {
          if (audio.current) audio.current.playbackRate = speed;
        }}
        onTimeUpdate={() => {
          const el = audio.current;
          if (!el) return;
          if (loop && el.currentTime * 1000 >= loop.end)
            el.currentTime = loop.start / 1000;
          setPosition(el.currentTime * 1000);
        }}
      />
      {help && (
        <div className="notice">
          Space: play/pause outside the editor · {shortcuts.play_pause}:
          play/pause while typing · {shortcuts.backward} / {shortcuts.forward}:
          skip · {shortcuts.help}: toggle this help. Skip distances, shortcuts
          and rewind on resume are configurable in Settings.
        </div>
      )}
      <div className="canonical-document">
        {blocks.map((block) => (
          <article
            id={"block-" + block.id}
            key={block.id}
            className={"passage " + (activeBlock === block.id ? "current" : "")}
          >
            <div className="passage-meta">
              {block.start_ms !== null ? (
                <button
                  className="timestamp"
                  onClick={() => seek(block.start_ms!)}
                >
                  {time(block.start_ms)}
                </button>
              ) : (
                <span className="hint">Untimed</span>
              )}
              <span className="alignment">
                {block.alignment_status === "provider_exact"
                  ? "Provider timing"
                  : block.alignment_status === "edited_anchor"
                    ? "Edited · broad anchor"
                    : "Unaligned"}
              </span>
              {block.speaker_key && (
                <button
                  className="speaker"
                  onClick={() => {
                    const label = prompt(
                      "Display name for this chunk-scoped speaker",
                      document.speakers[block.speaker_key!] ?? "",
                    );
                    if (label !== null)
                      void (async () => {
                        if (!(await flush())) return;
                        return api<Transcript>(
                          "/transcripts/" + document.id + "/speakers",
                          "PUT",
                          {
                            base_revision: base.current,
                            labels: { [block.speaker_key!]: label },
                          },
                        )
                          .then(async (result) => {
                            if (dirty.current) {
                              setConflict(result);
                              blocked.current = true;
                            } else await useServer(result);
                          })
                          .catch((e) => onError(String(e)));
                      })();
                  }}
                >
                  <bdi>
                    {document.speakers[block.speaker_key] ??
                      block.speaker_key.split(":").at(-1)}
                  </bdi>
                </button>
              )}
              {block.start_ms !== null && block.end_ms !== null && (
                <button
                  onClick={() => {
                    setLoop({ start: block.start_ms!, end: block.end_ms! });
                    seek(block.start_ms!);
                    void audio.current?.play();
                  }}
                >
                  Loop passage
                </button>
              )}
            </div>
            <RichBlock
              block={block}
              onChange={(text, marks_json) => {
                if (
                  text !== block.text ||
                  JSON.stringify(marks_json) !==
                    JSON.stringify(block.marks_json)
                )
                  update(block.id, { text, marks_json });
              }}
              onFocus={focus}
              onError={onError}
            />
            <div className="block-tools">
              <label>
                Text direction
                <select
                  aria-label="Text direction"
                  value={block.direction_override ?? "auto"}
                  onChange={(e) =>
                    update(block.id, {
                      direction_override:
                        e.target.value === "auto"
                          ? null
                          : (e.target.value as "rtl" | "ltr"),
                    })
                  }
                >
                  <option value="auto">Auto</option>
                  <option value="rtl">RTL</option>
                  <option value="ltr">LTR</option>
                </select>
              </label>
              <button
                onClick={() => {
                  const next = blocksRef.current.filter(
                    (b) => b.id !== block.id,
                  );
                  changed(next);
                }}
              >
                Remove block
              </button>
            </div>
          </article>
        ))}
      </div>
      <button
        onClick={() => {
          const next = [
            ...blocksRef.current,
            {
              id: crypto.randomUUID(),
              text: "",
              start_ms: null,
              end_ms: null,
              speaker_key: null,
              direction_override: null,
              alignment_status: "unaligned" as const,
              ordinal: blocksRef.current.length,
              marks_json: {},
            },
          ];
          changed(next);
        }}
      >
        + Add paragraph
      </button>
      <div className="page-actions">
        <button onClick={() => void save("checkpoint")}>Save checkpoint</button>
        <button onClick={() => void history().catch((e) => onError(String(e)))}>
          Revision history
        </button>
        <label className="check">
          <input
            type="checkbox"
            checked={exportTimestamps}
            onChange={(e) => setExportTimestamps(e.target.checked)}
          />
          Export timestamps
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={exportSpeakers}
            onChange={(e) => setExportSpeakers(e.target.checked)}
          />
          Export speakers
        </label>
        {(["txt", "md"] as const).map((format) => (
          <button
            className="button"
            key={format}
            disabled={exporting || blocked.current}
            onClick={() => void download(format)}
          >
            Export {format.toUpperCase()}
          </button>
        ))}
      </div>
      {showHistory && (
        <div className="revision-list">
          <h2>Immutable revision history</h2>
          {revisions.map((r) => (
            <div key={r.revision}>
              <span>
                Revision {r.revision} · {r.reason} ·{" "}
                {new Date(r.created_at).toLocaleString()}
              </span>
              <button onClick={() => void restore(r.revision)}>
                Restore as new revision
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
const documentGlobal = window.document;
