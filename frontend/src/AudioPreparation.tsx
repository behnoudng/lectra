import { useEffect, useMemo, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import Regions, {
  type Region,
} from "wavesurfer.js/dist/plugins/regions.esm.js";
import Timeline from "wavesurfer.js/dist/plugins/timeline.esm.js";
import Hover from "wavesurfer.js/dist/plugins/hover.esm.js";
import { api, time } from "./api";
import {
  preciseTime,
  parseAudioTime,
  removedRanges,
  removeRange,
  restoreRange,
  editedPosition,
  overviewPath,
} from "./audioEditing";
import type { Lecture, Span, Preprocessing } from "./types";

type Props = {
  lecture: Lecture;
  onUpdate: () => Promise<void>;
  review: () => void;
  onError: (message: string) => void;
};
type Audition = Span & { label: "selection" | "removed audio" };

export function AudioPreparation({
  lecture,
  onUpdate,
  review,
  onError,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const wave = useRef<WaveSurfer | null>(null);
  const regions = useRef<Regions | null>(null);
  const source = lecture.media.find((a) => a.kind === "proxy");
  const sourceDuration =
    lecture.media.find((a) => a.kind === "original")?.duration_ms ??
    source?.duration_ms ??
    0;
  const hasHours = sourceDuration >= 3600000;
  const clock = (ms: number) => preciseTime(ms, hasHours);
  const [spans, setSpans] = useState<Span[]>(lecture.edl);
  const spansRef = useRef(spans);
  spansRef.current = spans;
  const [undo, setUndo] = useState<Span[][]>([]);
  const [redo, setRedo] = useState<Span[][]>([]);
  const [selection, setSelection] = useState({ start: "", end: "" });
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [zoom, setZoom] = useState(0);
  const [viewport, setViewport] = useState({ start: 0, end: sourceDuration });
  const [peaks, setPeaks] = useState<number[]>([]);
  const [jump, setJump] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const [saved, setSaved] = useState(true);
  const [announcement, setAnnouncement] = useState("");
  const [audition, setAudition] = useState<Audition["label"] | null>(null);
  const auditionRef = useRef<Audition | null>(null);
  const synchronizing = useRef(false);
  const [processing, setProcessing] = useState<Preprocessing>({
    enabled: false,
    highpass: true,
    denoise: true,
    loudness: true,
    ...lecture.preprocessing,
  });
  const [preview, setPreview] = useState<{
    clean_id: string;
    enhanced_id: string;
  } | null>(null);
  const [version, setVersion] = useState<"clean" | "enhanced">("clean");
  const previewAudio = useRef<HTMLAudioElement>(null);
  const switchTime = useRef(0);
  const start = parseAudioTime(selection.start);
  const end = parseAudioTime(selection.end);
  const inBounds = (value: number | null): value is number =>
    value !== null && value >= 0 && value <= sourceDuration;
  const validSelection = inBounds(start) && inBounds(end) && end > start;
  const range = validSelection ? { start_ms: start, end_ms: end } : null;
  const cuts = removedRanges(spans, sourceDuration);
  const duration = spans.reduce((sum, s) => sum + s.end_ms - s.start_ms, 0);
  const editedAt = editedPosition(spans, position);
  const jumpAt = parseAudioTime(jump);
  const nextSpans = range ? removeRange(spans, range) : spans;
  const removedBySelection =
    duration - nextSpans.reduce((sum, s) => sum + s.end_ms - s.start_ms, 0);
  const miniWave = useMemo(() => overviewPath(peaks), [peaks]);

  function clearSelection() {
    setSelection({ start: "", end: "" });
  }
  function stop() {
    auditionRef.current = null;
    setAudition(null);
    wave.current?.pause();
  }
  function seek(ms: number, center = false) {
    auditionRef.current = null;
    setAudition(null);
    const at = Math.max(0, Math.min(sourceDuration, ms));
    wave.current?.setTime(at / 1000);
    if (center)
      wave.current?.setScrollTime(
        Math.max(0, at - (viewport.end - viewport.start) / 2) / 1000,
      );
  }
  function toggle() {
    const w = wave.current;
    if (!w || !ready || busy) return;
    if (w.isPlaying()) {
      stop();
      return;
    }
    auditionRef.current = null;
    setAudition(null);
    const at = Math.round(w.getCurrentTime() * 1000);
    const next =
      spansRef.current.find((s) => s.end_ms > at) ?? spansRef.current[0];
    const from = next
      ? Math.max(next.start_ms, at < next.end_ms ? at : next.start_ms)
      : 0;
    void w
      .play(from / 1000)
      .catch(() => onError("Audio playback could not start."));
  }
  function previewRange(value: Span, label: Audition["label"]) {
    const w = wave.current;
    if (!w || !ready || busy) return;
    if (
      w.isPlaying() &&
      auditionRef.current?.label === label &&
      auditionRef.current.start_ms === value.start_ms &&
      auditionRef.current.end_ms === value.end_ms
    ) {
      stop();
      return;
    }
    w.pause();
    auditionRef.current = { ...value, label };
    setAudition(label);
    void w.play(value.start_ms / 1000, value.end_ms / 1000).catch(() => {
      stop();
      onError("Audio preview could not start.");
    });
  }
  function change(next: Span[], message: string) {
    stop();
    const current = spansRef.current;
    setUndo((history) => [...history, current]);
    setRedo([]);
    spansRef.current = next;
    setSpans(next);
    setSaved(false);
    setPreview(null);
    setAnnouncement(message);
  }
  function cut() {
    if (!range || busy || !ready || removedBySelection <= 0) return;
    if (!nextSpans.length) {
      setAnnouncement("Keep at least one part of the recording.");
      return;
    }
    change(
      nextSpans,
      `${preciseTime(removedBySelection)} removed. Undo or restore this cut at any time.`,
    );
    clearSelection();
  }
  function undoCut() {
    if (!undo.length || busy) return;
    stop();
    const prior = undo.at(-1)!;
    const current = spansRef.current;
    setRedo((history) => [current, ...history]);
    setUndo((history) => history.slice(0, -1));
    spansRef.current = prior;
    setSpans(prior);
    setSaved(false);
    setPreview(null);
    clearSelection();
    setAnnouncement("Cut undone.");
  }
  function redoCut() {
    if (!redo.length || busy) return;
    stop();
    const next = redo[0];
    const current = spansRef.current;
    setUndo((history) => [...history, current]);
    setRedo((history) => history.slice(1));
    spansRef.current = next;
    setSpans(next);
    setSaved(false);
    setPreview(null);
    clearSelection();
    setAnnouncement("Cut reapplied.");
  }
  function mark(side: "start" | "end") {
    const at = Math.min(
      sourceDuration,
      Math.round((wave.current?.getCurrentTime() ?? 0) * 1000),
    );
    setSelection((prior) => ({ ...prior, [side]: clock(at) }));
  }
  function applyZoom(value: number, left?: number) {
    const w = wave.current;
    if (!w || !ready) return;
    const fit = w.getWidth() / (sourceDuration / 1000);
    const maximum = Math.max(fit, 400);
    w.zoom(value === 0 ? 0 : fit * Math.pow(maximum / fit, value / 100));
    setZoom(value);
    if (left !== undefined) w.setScrollTime(Math.max(0, left) / 1000);
  }
  function zoomToSelection() {
    if (!range || !wave.current) return;
    const fit = wave.current.getWidth() / (sourceDuration / 1000);
    const maximum = Math.max(fit, 400);
    const padding = Math.max(
      250,
      Math.min(3000, (range.end_ms - range.start_ms) * 0.3),
    );
    const desired = Math.max(
      fit,
      Math.min(
        maximum,
        wave.current.getWidth() /
          ((range.end_ms - range.start_ms + padding * 2) / 1000),
      ),
    );
    applyZoom(
      maximum > fit
        ? (100 * Math.log(desired / fit)) / Math.log(maximum / fit)
        : 0,
      range.start_ms - padding,
    );
  }
  const actions = useRef({
    toggle,
    mark,
    cut,
    undoCut,
    redoCut,
    clearSelection,
    seek,
  });
  actions.current = {
    toggle,
    mark,
    cut,
    undoCut,
    redoCut,
    clearSelection,
    seek,
  };

  useEffect(() => {
    if (!source || !container.current) return;
    let gone = false;
    const r = Regions.create();
    regions.current = r;
    const w = WaveSurfer.create({
      container: container.current,
      waveColor: "#7b968b",
      progressColor: "#456f5c",
      cursorColor: "#cb7654",
      cursorWidth: 2,
      height: 160,
      normalize: true,
      minPxPerSec: 0,
      autoScroll: true,
      plugins: [
        r,
        Timeline.create({
          height: 28,
          secondaryLabelOpacity: 0.85,
          formatTimeCallback: (seconds) =>
            seconds % 1 ? preciseTime(seconds * 1000) : time(seconds * 1000),
          style: { color: "var(--muted)", fontSize: "11px" },
        }),
        Hover.create({
          lineColor: "var(--muted)",
          labelColor: "var(--text)",
          labelBackground: "var(--soft)",
          labelSize: 12,
          formatTimeCallback: (seconds) =>
            preciseTime(seconds * 1000, sourceDuration >= 3600000),
        }),
      ],
    });
    wave.current = w;
    const disableDrag = r.enableDragSelection({
      color: "rgba(218,126,81,.23)",
      minLength: 0.001,
    });
    function readRegion(region: Region) {
      if (
        gone ||
        busyRef.current ||
        synchronizing.current ||
        region.id !== "selection"
      )
        return;
      w.pause();
      auditionRef.current = null;
      setAudition(null);
      setSelection({
        start: preciseTime(
          Math.max(0, Math.round(region.start * 1000)),
          sourceDuration >= 3600000,
        ),
        end: preciseTime(
          Math.min(sourceDuration, Math.round(region.end * 1000)),
          sourceDuration >= 3600000,
        ),
      });
    }
    r.on("region-created", (region) => {
      if (
        gone ||
        synchronizing.current ||
        region.id.startsWith("removed-") ||
        region.id === "start-marker" ||
        region.id === "selection"
      )
        return;
      if (busyRef.current) {
        region.remove();
        return;
      }
      r.getRegions()
        .filter((old) => old.id === "selection" || old.id === "start-marker")
        .forEach((old) => old.remove());
      region.setOptions({ id: "selection" });
      region.element?.setAttribute("data-kind", "selection");
      readRegion(region);
    });
    r.on("region-update", readRegion);
    r.on("region-updated", readRegion);
    w.on("ready", () => {
      if (!gone) setReady(true);
    });
    w.on("play", () => {
      if (!gone) setPlaying(w.isPlaying());
    });
    w.on("pause", () => {
      if (!gone) {
        setPlaying(w.isPlaying());
        if (!w.isPlaying()) {
          auditionRef.current = null;
          setAudition(null);
        }
      }
    });
    w.on("interaction", () => {
      auditionRef.current = null;
      setAudition(null);
    });
    w.on("scroll", (left, right) =>
      setViewport({
        start: Math.round(left * 1000),
        end: Math.min(sourceDuration, Math.round(right * 1000)),
      }),
    );
    w.on("redrawcomplete", () => {
      const scale = sourceDuration / Math.max(1, w.getWrapper().scrollWidth);
      setViewport({
        start: Math.round(w.getScroll() * scale),
        end: Math.min(
          sourceDuration,
          Math.round((w.getScroll() + w.getWidth()) * scale),
        ),
      });
    });
    w.on("timeupdate", () => {
      // WaveSurfer's reactive play event can re-emit the time from before a
      // seek. Read the media clock so starting a preview cannot stop it early.
      const at = Math.max(
        0,
        Math.min(sourceDuration, Math.round(w.getCurrentTime() * 1000)),
      );
      setPosition(at);
      if (!w.isPlaying()) return;
      const clip = auditionRef.current;
      if (clip) {
        if (at >= clip.end_ms) {
          w.pause();
          w.setTime(clip.end_ms / 1000);
          auditionRef.current = null;
          setAudition(null);
        }
        return;
      }
      const next = spansRef.current.find((s) => s.end_ms > at);
      if (!next) {
        w.pause();
        return;
      }
      if (at < next.start_ms) w.setTime(next.start_ms / 1000);
    });
    w.on("error", () => {
      if (!gone) {
        setReady(false);
        onError("Could not load the playback waveform.");
      }
    });
    void api<{ peaks: number[]; duration_ms: number }>(
      "/media/" + source.id + "/peaks",
    )
      .then(async (data) => {
        if (!gone) {
          setPeaks(data.peaks);
          await w.load(
            "/api/v1/media/" + source.id,
            [data.peaks],
            sourceDuration / 1000,
          );
        }
      })
      .catch((error) => {
        if (!gone) onError(String(error));
      });
    return () => {
      gone = true;
      disableDrag();
      w.destroy();
      wave.current = null;
      regions.current = null;
    };
  }, [source?.id, sourceDuration, onError]);

  useEffect(() => {
    const r = regions.current;
    if (!r || !ready) return;
    synchronizing.current = true;
    try {
      const current = r
        .getRegions()
        .find((region) => region.id === "selection");
      r.getRegions()
        .filter((region) => region.id === "start-marker")
        .forEach((region) => region.remove());
      if (validSelection) {
        if (current) {
          if (
            Math.abs(current.start * 1000 - start) > 0.5 ||
            Math.abs(current.end * 1000 - end) > 0.5
          )
            current.setOptions({ start: start / 1000, end: end / 1000 });
          current.setOptions({ drag: !busy, resize: !busy });
        } else {
          const region = r.addRegion({
            id: "selection",
            start: start / 1000,
            end: end / 1000,
            color: "rgba(218,126,81,.23)",
            minLength: 0.001,
            drag: !busy,
            resize: !busy,
          });
          region.element?.setAttribute("data-kind", "selection");
        }
      } else {
        current?.remove();
        if (inBounds(start) && selection.start)
          r.addRegion({
            id: "start-marker",
            start: start / 1000,
            end: start / 1000,
            color: "var(--warning)",
            drag: false,
            resize: false,
            content: "Start",
          });
      }
    } finally {
      synchronizing.current = false;
    }
  }, [
    start,
    end,
    validSelection,
    ready,
    busy,
    selection.start,
    sourceDuration,
  ]);

  useEffect(() => {
    const r = regions.current;
    if (!r || !ready) return;
    synchronizing.current = true;
    try {
      r.getRegions()
        .filter((region) => region.id.startsWith("removed-"))
        .forEach((region) => region.remove());
      for (const [i, value] of removedRanges(spans, sourceDuration).entries()) {
        const region = r.addRegion({
          id: "removed-" + i,
          start: value.start_ms / 1000,
          end: value.end_ms / 1000,
          color: "rgba(184,70,57,.15)",
          drag: false,
          resize: false,
          content: "Removed",
        });
        if (region.element) {
          region.element.setAttribute("data-kind", "removed");
          region.element.style.pointerEvents = "none";
          region.element.style.backgroundImage =
            "repeating-linear-gradient(135deg, transparent, transparent 6px, rgba(184,70,57,.12) 6px, rgba(184,70,57,.12) 8px)";
        }
      }
    } finally {
      synchronizing.current = false;
    }
  }, [spans, ready, sourceDuration]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        event.defaultPrevented ||
        event.isComposing ||
        busyRef.current ||
        target.closest(
          "input,textarea,select,[contenteditable=true],[role=slider]",
        )
      )
        return;
      if ((event.ctrlKey || event.metaKey) && event.code === "KeyZ") {
        event.preventDefault();
        event.shiftKey ? actions.current.redoCut() : actions.current.undoCut();
      } else if ((event.ctrlKey || event.metaKey) && event.code === "KeyY") {
        event.preventDefault();
        actions.current.redoCut();
      } else if (!event.ctrlKey && !event.metaKey && !event.altKey) {
        if (event.code === "Space" && !target.closest("button,a")) {
          event.preventDefault();
          actions.current.toggle();
        } else if (event.code === "KeyI") {
          event.preventDefault();
          actions.current.mark("start");
        } else if (event.code === "KeyO") {
          event.preventDefault();
          actions.current.mark("end");
        } else if (event.code === "Escape") actions.current.clearSelection();
        else if (event.code === "Delete") {
          event.preventDefault();
          actions.current.cut();
        } else if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
          event.preventDefault();
          actions.current.seek(
            (wave.current?.getCurrentTime() ?? 0) * 1000 +
              (event.code === "ArrowLeft" ? -1 : 1) *
                (event.shiftKey ? 100 : 1000),
          );
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  async function save() {
    stop();
    setBusy(true);
    try {
      await api("/lectures/" + lecture.id + "/edl", "PUT", { spans });
      await api("/lectures/" + lecture.id + "/preprocess", "PUT", processing);
      await onUpdate();
      setSaved(true);
    } catch (error) {
      onError(String(error));
      throw error;
    } finally {
      setBusy(false);
    }
  }
  async function buildPreview() {
    try {
      await save();
      setBusy(true);
      setPreview(
        await api(
          "/lectures/" + lecture.id + "/preprocess-preview",
          "POST",
          processing,
        ),
      );
      setVersion("clean");
    } catch (error) {
      onError(String(error));
    } finally {
      setBusy(false);
    }
  }
  function scrubOverview(element: HTMLElement, clientX: number) {
    if (!ready || busy) return;
    const box = element.getBoundingClientRect();
    seek(
      Math.round(
        Math.max(0, Math.min(1, (clientX - box.left) / box.width)) *
          sourceDuration,
      ),
      true,
    );
  }
  const fieldError = (text: string, value: number | null) =>
    Boolean(text.trim()) && !inBounds(value);
  const invalidStart = fieldError(selection.start, start),
    invalidEnd = fieldError(selection.end, end);

  if (!source)
    return (
      <section className="empty">
        <h2>Audio is not ready yet</h2>
        <p>The original may have been saved before proxy generation stopped.</p>
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void api("/lectures/" + lecture.id + "/proxy", "POST")
              .then(onUpdate)
              .catch((error) => onError(String(error)))
              .finally(() => setBusy(false));
          }}
        >
          Generate playback proxy
        </button>
      </section>
    );

  return (
    <section className="preparation">
      <div className="page-heading">
        <div>
          <p className="eyebrow">AUDIO PREPARATION</p>
          <h1 dir="auto">{lecture.title}</h1>
          <p>
            Select the part you want to remove. Listen first, cut, and undo
            anytime.
          </p>
        </div>
        <span className="pill">
          {time(duration)} kept · {cuts.length}{" "}
          {cuts.length === 1 ? "cut" : "cuts"}
        </span>
      </div>
      <div className="audio-workbench">
        <div className="audio-transport">
          <div className="audio-transport-buttons">
            <button
              aria-label="Skip backward 5 seconds"
              disabled={!ready || busy}
              onClick={() => seek(position - 5000)}
            >
              −5s
            </button>
            <button
              className="primary audio-play"
              aria-label={playing ? "Pause audio" : "Play retained audio"}
              aria-pressed={playing}
              disabled={!ready || busy}
              onClick={toggle}
            >
              <span aria-hidden="true">{playing ? "Ⅱ" : "▶"}</span>
              {playing ? "Pause" : "Play"}
            </button>
            <button
              aria-label="Skip forward 5 seconds"
              disabled={!ready || busy}
              onClick={() => seek(position + 5000)}
            >
              +5s
            </button>
          </div>
          <div className="audio-clock">
            <span>RECORDING TIME</span>
            <div>
              <output
                data-testid="playhead-time"
                aria-label="Current recording time"
                aria-live="off"
              >
                {clock(position)}
              </output>
              <small>/ {clock(sourceDuration)}</small>
            </div>
            <span>
              {(position / 1000).toFixed(3)} seconds ·{" "}
              {audition
                ? "Previewing " + audition
                : editedAt !== null
                  ? "Kept position " + clock(editedAt)
                  : "Removed section"}
            </span>
          </div>
          <form
            className="audio-jump"
            onSubmit={(event) => {
              event.preventDefault();
              if (inBounds(jumpAt)) {
                stop();
                seek(jumpAt, true);
              }
            }}
          >
            <label htmlFor="audio-jump">Jump to time</label>
            <div>
              <input
                id="audio-jump"
                aria-label="Jump to time"
                placeholder="12:34 or 754.5"
                value={jump}
                disabled={busy}
                dir="ltr"
                onChange={(event) => setJump(event.target.value)}
              />
              <button disabled={!ready || busy || !inBounds(jumpAt)}>Go</button>
            </div>
          </form>
        </div>
        <div className="audio-navigation">
          <div
            className="audio-overview"
            role="slider"
            aria-label="Recording overview"
            aria-valuemin={0}
            aria-valuemax={sourceDuration / 1000}
            aria-valuenow={position / 1000}
            aria-valuetext={clock(position)}
            aria-disabled={!ready || busy}
            tabIndex={ready && !busy ? 0 : -1}
            onPointerDown={(event) => {
              if (!ready || busy) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              scrubOverview(event.currentTarget, event.clientX);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                scrubOverview(event.currentTarget, event.clientX);
            }}
            onKeyDown={(event) => {
              if (!ready || busy) return;
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                seek(
                  position + (event.key === "ArrowLeft" ? -1 : 1) * 5000,
                  true,
                );
              } else if (event.key === "Home" || event.key === "End") {
                event.preventDefault();
                seek(event.key === "Home" ? 0 : sourceDuration, true);
              }
            }}
          >
            <svg
              viewBox="0 0 1000 40"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <path d={miniWave} />
            </svg>
            {cuts.map((value) => (
              <span
                className="overview-cut"
                key={value.start_ms}
                style={{
                  left: (value.start_ms / sourceDuration) * 100 + "%",
                  width:
                    ((value.end_ms - value.start_ms) / sourceDuration) * 100 +
                    "%",
                }}
              />
            ))}
            <span
              className="overview-viewport"
              style={{
                left: (viewport.start / sourceDuration) * 100 + "%",
                width:
                  Math.max(
                    0.2,
                    ((viewport.end - viewport.start) / sourceDuration) * 100,
                  ) + "%",
              }}
            />
            <span
              className="overview-playhead"
              style={{ left: (position / sourceDuration) * 100 + "%" }}
            />
          </div>
          <div className="overview-labels">
            <span>00:00 · click or drag to navigate</span>
            <span>{time(sourceDuration)}</span>
          </div>
        </div>
        <div className="waveform-shell" aria-busy={!ready || busy}>
          {!ready && (
            <p className="waveform-loading" role="status">
              Loading waveform…
            </p>
          )}
          <div
            className={"waveform " + (busy ? "waveform-busy" : "")}
            ref={container}
            tabIndex={0}
            role="group"
            aria-label="Audio waveform: drag to select, I and O to mark start and end"
          />
        </div>
        <div className="audio-wave-tools">
          <div className="wave-legend">
            <span className="legend-kept">Kept audio</span>
            <span className="legend-selected">Selection to cut</span>
            <span className="legend-removed">Removed</span>
          </div>
          <div className="audio-zoom">
            <button
              aria-label="Zoom out"
              disabled={!ready || busy || zoom <= 0}
              onClick={() => applyZoom(Math.max(0, zoom - 15))}
            >
              −
            </button>
            <input
              aria-label="Waveform zoom"
              type="range"
              min="0"
              max="100"
              value={zoom}
              disabled={!ready || busy}
              onChange={(event) => applyZoom(Number(event.target.value))}
            />
            <button
              aria-label="Zoom in"
              disabled={!ready || busy || zoom >= 100}
              onClick={() => applyZoom(Math.min(100, zoom + 15))}
            >
              +
            </button>
            <button disabled={!ready || busy} onClick={() => applyZoom(0)}>
              Fit recording
            </button>
            <button
              disabled={!ready || busy}
              onClick={() =>
                wave.current?.setScrollTime(
                  Math.max(0, position - (viewport.end - viewport.start) / 2) /
                    1000,
                )
              }
            >
              Show playhead
            </button>
          </div>
        </div>
      </div>
      <div className="cut-selection-panel">
        <div className="selection-heading">
          <div>
            <h2>Cut selection</h2>
            <p>
              Drag across the waveform, then adjust either handle. Or mark the
              start and end while listening.
            </p>
          </div>
          <button
            disabled={busy || (!selection.start && !selection.end)}
            onClick={clearSelection}
          >
            Clear selection
          </button>
        </div>
        <div className="selection-fields">
          <div>
            <label htmlFor="cut-start">Start</label>
            <input
              id="cut-start"
              aria-label="Selection start"
              aria-invalid={invalidStart}
              aria-describedby="time-entry-help"
              dir="ltr"
              value={selection.start}
              placeholder={hasHours ? "00:00:00.000" : "00:00.000"}
              disabled={busy}
              onChange={(event) =>
                setSelection((prior) => ({
                  ...prior,
                  start: event.target.value,
                }))
              }
              onBlur={() => {
                if (inBounds(start))
                  setSelection((prior) => ({ ...prior, start: clock(start) }));
              }}
            />
            <button disabled={!ready || busy} onClick={() => mark("start")}>
              Set start here <kbd>I</kbd>
            </button>
          </div>
          <div>
            <label htmlFor="cut-end">End</label>
            <input
              id="cut-end"
              aria-label="Selection end"
              aria-invalid={invalidEnd}
              aria-describedby="time-entry-help"
              dir="ltr"
              value={selection.end}
              placeholder={hasHours ? "00:00:00.000" : "00:00.000"}
              disabled={busy}
              onChange={(event) =>
                setSelection((prior) => ({ ...prior, end: event.target.value }))
              }
              onBlur={() => {
                if (inBounds(end))
                  setSelection((prior) => ({ ...prior, end: clock(end) }));
              }}
            />
            <button disabled={!ready || busy} onClick={() => mark("end")}>
              Set end here <kbd>O</kbd>
            </button>
          </div>
          <div className="selection-duration">
            <span>SELECTED DURATION</span>
            <strong data-testid="selection-duration">
              {range ? preciseTime(range.end_ms - range.start_ms) : "—"}
            </strong>
            <span>
              {range
                ? ((range.end_ms - range.start_ms) / 1000).toFixed(3) +
                  " seconds"
                : "Choose a start and end"}
            </span>
          </div>
          <div className="selection-actions">
            <button
              disabled={!range || !ready || busy}
              onClick={() => range && previewRange(range, "selection")}
            >
              {playing && audition === "selection"
                ? "Stop preview"
                : "Preview selection"}
            </button>
            <button
              disabled={!range || !ready || busy}
              onClick={zoomToSelection}
            >
              Zoom to selection
            </button>
            <button
              className="cut-button"
              disabled={
                !range ||
                !ready ||
                busy ||
                removedBySelection <= 0 ||
                !nextSpans.length
              }
              onClick={cut}
            >
              ✂ Cut selection
              {range && " · " + (removedBySelection / 1000).toFixed(3) + "s"}
            </button>
          </div>
        </div>
        <p className="hint" id="time-entry-help">
          Enter seconds (<bdi>743.5</bdi>) or a time (<bdi>12:23.500</bdi>).
          Times refer to the original recording; precision is 0.001 seconds.
        </p>
        {(invalidStart || invalidEnd) && (
          <p role="alert" className="cut-validation">
            Enter a valid time within the recording.
          </p>
        )}
        {!invalidStart &&
          !invalidEnd &&
          start !== null &&
          end !== null &&
          end <= start && (
            <p role="status" className="cut-validation">
              End must be after start.
            </p>
          )}
        {range && !nextSpans.length && (
          <p role="status" className="cut-validation">
            Keep at least one part of the recording.
          </p>
        )}
        {range && removedBySelection === 0 && (
          <p role="status" className="hint">
            This selection is already removed.
          </p>
        )}
        <div className="audio-edit-footer">
          <div>
            <button disabled={!undo.length || busy} onClick={undoCut}>
              ↶ Undo cut
            </button>
            <button disabled={!redo.length || busy} onClick={redoCut}>
              ↷ Redo cut
            </button>
          </div>
          <span className="hint">
            Space: play/pause · ←/→: 1s · Shift+←/→: 0.1s · Delete: cut
          </span>
        </div>
      </div>
      {announcement && (
        <p className="cut-announcement" role="status">
          {announcement}
        </p>
      )}
      <div className="cuts-heading">
        <div>
          <h2>
            Removed sections <span>{cuts.length}</span>
          </h2>
          <p>
            These parts are skipped in edited playback. The original recording
            stays intact.
          </p>
        </div>
        {cuts.length > 0 && (
          <button
            disabled={busy}
            onClick={() =>
              change(
                [{ start_ms: 0, end_ms: sourceDuration }],
                "All audio restored. You can undo this change.",
              )
            }
          >
            Restore all audio
          </button>
        )}
      </div>
      {cuts.length ? (
        <ol className="cut-list">
          {cuts.map((value, index) => (
            <li key={value.start_ms}>
              <span className="cut-index">{index + 1}</span>
              <div>
                <strong>
                  <bdi>
                    {clock(value.start_ms)} → {clock(value.end_ms)}
                  </bdi>
                </strong>
                <span>
                  {((value.end_ms - value.start_ms) / 1000).toFixed(3)} seconds
                  removed
                </span>
              </div>
              <button
                aria-label={"Preview removed section " + (index + 1)}
                disabled={!ready || busy}
                onClick={() => previewRange(value, "removed audio")}
              >
                Listen
              </button>
              <button
                aria-label={"Restore cut " + (index + 1)}
                disabled={busy}
                onClick={() => {
                  change(restoreRange(spans, value), "Cut restored.");
                  clearSelection();
                }}
              >
                Restore
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="no-cuts">
          No cuts yet. Select a section above to remove it.
        </p>
      )}
      <details className="retained-details">
        <summary>Kept ranges · {time(duration)}</summary>
        <ol className="ranges">
          {spans.map((span) => (
            <li key={span.start_ms}>
              <bdi>
                {clock(span.start_ms)} → {clock(span.end_ms)}
              </bdi>
              <span>{time(span.end_ms - span.start_ms)}</span>
            </li>
          ))}
        </ol>
      </details>
      <div className="enhancement">
        <h2>Conservative cleanup</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={processing.enabled}
            disabled={busy}
            onChange={(event) => {
              setProcessing({ ...processing, enabled: event.target.checked });
              setSaved(false);
              setPreview(null);
            }}
          />
          Use enhanced audio for transcription
        </label>
        <p className="hint">
          Optional high-pass filtering, light denoising, and loudness
          normalization. Off by default.
        </p>
        <div className="toolbar">
          {(["highpass", "denoise", "loudness"] as const).map((key) => (
            <label className="check" key={key}>
              <input
                type="checkbox"
                checked={processing[key]}
                disabled={busy}
                onChange={(event) => {
                  setProcessing({ ...processing, [key]: event.target.checked });
                  setSaved(false);
                  setPreview(null);
                }}
              />
              {key}
            </label>
          ))}
        </div>
        <button disabled={busy} onClick={() => void buildPreview()}>
          Build clean / enhanced A/B preview
        </button>
        {preview && (
          <div className="ab-preview">
            <div className="toolbar">
              {(["clean", "enhanced"] as const).map((value) => (
                <button
                  key={value}
                  aria-pressed={value === version}
                  onClick={() => {
                    switchTime.current = previewAudio.current?.currentTime ?? 0;
                    setVersion(value);
                  }}
                >
                  {value === "clean" ? "Clean" : "Enhanced"}
                </button>
              ))}
              <span>Same edited timeline · {time(duration)}</span>
            </div>
            <audio
              ref={previewAudio}
              controls
              src={
                "/api/v1/media/" +
                preview[version === "clean" ? "clean_id" : "enhanced_id"]
              }
              onLoadedMetadata={() => {
                if (previewAudio.current)
                  previewAudio.current.currentTime = switchTime.current;
              }}
            />
          </div>
        )}
      </div>
      <div className="page-actions">
        <span className="hint">
          {saved ? "Preparation saved" : "Unsaved preparation"}
        </span>
        <button disabled={busy} onClick={() => void save().catch(() => {})}>
          Save preparation
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            void save()
              .then(review)
              .catch(() => {})
          }
        >
          Review transcription →
        </button>
      </div>
    </section>
  );
}
