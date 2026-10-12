import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import Regions from "wavesurfer.js/dist/plugins/regions.esm.js";
import { api, time } from "./api";
import type { Lecture, Span, Preprocessing } from "./types";

type Props = {
  lecture: Lecture;
  onUpdate: () => Promise<void>;
  review: () => void;
  onError: (message: string) => void;
};
export function AudioPreparation({
  lecture,
  onUpdate,
  review,
  onError,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const wave = useRef<WaveSurfer | null>(null);
  const regions = useRef<Regions | null>(null);
  const [spans, setSpans] = useState<Span[]>(lecture.edl);
  const spansRef = useRef(spans);
  spansRef.current = spans;
  const [undo, setUndo] = useState<Span[][]>([]);
  const [redo, setRedo] = useState<Span[][]>([]);
  const [range, setRange] = useState({ start_ms: 0, end_ms: 0 });
  const [zoom, setZoom] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(true);
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
  const source = lecture.media.find((a) => a.kind === "proxy");
  useEffect(() => {
    if (!source || !container.current) return;
    let gone = false;
    const r = Regions.create();
    regions.current = r;
    const w = WaveSurfer.create({
      container: container.current,
      waveColor: "#56726c",
      progressColor: "#a6e1b3",
      cursorColor: "#d89657",
      height: 150,
      normalize: true,
      plugins: [r],
      minPxPerSec: 0,
    });
    wave.current = w;
    r.enableDragSelection({ color: "rgba(216,150,87,.25)" });
    r.on("region-created", (region) => {
      for (const prior of r.getRegions())
        if (prior.id !== region.id) prior.remove();
      setRange({
        start_ms: Math.round(region.start * 1000),
        end_ms: Math.round(region.end * 1000),
      });
    });
    r.on("region-updated", (region) =>
      setRange({
        start_ms: Math.round(region.start * 1000),
        end_ms: Math.round(region.end * 1000),
      }),
    );
    w.on("error", () => {
      if (!gone) onError("Could not load the playback waveform.");
    });
    void api<{ peaks: number[]; duration_ms: number }>(
      "/media/" + source.id + "/peaks",
    )
      .then((p) => {
        if (!gone)
          void w.load(
            "/api/v1/media/" + source.id,
            [p.peaks],
            source.duration_ms / 1000,
          );
      })
      .catch((e) => onError(String(e)));
    // Source preview skips removed ranges without altering media.
    w.on("timeupdate", (seconds) => {
      if (!w.isPlaying()) return;
      const at = seconds * 1000;
      const next = spansRef.current.find((s) => s.end_ms > at);
      if (!next) {
        w.pause();
        return;
      }
      if (at < next.start_ms) w.setTime(next.start_ms / 1000);
    });
    return () => {
      gone = true;
      w.destroy();
      wave.current = null;
    };
  }, [source?.id, onError]);
  function change(next: Span[]) {
    setUndo((v) => [...v, spans]);
    setRedo([]);
    setSpans(next);
    setSaved(false);
    setPreview(null);
  }
  function cut() {
    const next = spans.flatMap((s) => {
      if (range.end_ms <= s.start_ms || range.start_ms >= s.end_ms) return [s];
      const out: Span[] = [];
      if (range.start_ms > s.start_ms)
        out.push({ start_ms: s.start_ms, end_ms: range.start_ms });
      if (range.end_ms < s.end_ms)
        out.push({ start_ms: range.end_ms, end_ms: s.end_ms });
      return out;
    });
    if (!next.length) {
      onError("Keep at least one part of the lecture.");
      return;
    }
    change(next);
    regions.current?.clearRegions();
  }
  async function save() {
    setBusy(true);
    try {
      await api("/lectures/" + lecture.id + "/edl", "PUT", { spans });
      await api("/lectures/" + lecture.id + "/preprocess", "PUT", processing);
      await onUpdate();
      setSaved(true);
    } catch (e) {
      onError(String(e));
      throw e;
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
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const duration = spans.reduce((sum, s) => sum + s.end_ms - s.start_ms, 0);
  if (!source)
    return (
      <section className="empty">
        <h2>Audio is not ready yet</h2>
        <p>The original may have been saved before proxy generation stopped.</p>
        <button
          onClick={() => {
            setBusy(true);
            void api("/lectures/" + lecture.id + "/proxy", "POST")
              .then(onUpdate)
              .catch((e) => onError(String(e)))
              .finally(() => setBusy(false));
          }}
          disabled={busy}
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
          <h1>{lecture.title}</h1>
          <p>Keep the useful parts. Your original stays untouched.</p>
        </div>
        <span className="pill">{time(duration)} edited</span>
      </div>
      <div className="toolbar">
        <button onClick={() => void wave.current?.playPause()}>
          Play / pause retained audio
        </button>
        <button
          disabled={!undo.length}
          onClick={() => {
            const prior = undo.at(-1)!;
            setRedo((v) => [spans, ...v]);
            setUndo((v) => v.slice(0, -1));
            setSpans(prior);
            setSaved(false);
            setPreview(null);
          }}
        >
          Undo cut
        </button>
        <button
          disabled={!redo.length}
          onClick={() => {
            setUndo((v) => [...v, spans]);
            setSpans(redo[0]);
            setRedo((v) => v.slice(1));
            setSaved(false);
            setPreview(null);
          }}
        >
          Redo cut
        </button>
        <label>
          Zoom
          <input
            type="range"
            min="0"
            max="100"
            value={zoom}
            onChange={(e) => {
              const value = Number(e.target.value);
              setZoom(value);
              wave.current?.zoom(value);
            }}
          />
        </label>
      </div>
      <div className="waveform" ref={container} />
      <p className="hint">
        Drag across the waveform to select a cut. Retained ranges use original
        recording times.
      </p>
      <div className="toolbar">
        <label>
          Cut start (seconds)
          <input
            type="number"
            min="0"
            step="0.1"
            value={range.start_ms / 1000}
            onChange={(e) =>
              setRange({
                ...range,
                start_ms: Math.round(Number(e.target.value) * 1000),
              })
            }
          />
        </label>
        <label>
          Cut end (seconds)
          <input
            type="number"
            min="0"
            step="0.1"
            value={range.end_ms / 1000}
            onChange={(e) =>
              setRange({
                ...range,
                end_ms: Math.round(Number(e.target.value) * 1000),
              })
            }
          />
        </label>
        <button disabled={range.end_ms <= range.start_ms} onClick={cut}>
          Remove selected range
        </button>
      </div>
      <h2>Retained ranges</h2>
      <ol className="ranges">
        {spans.map((span, i) => (
          <li key={i}>
            <bdi>
              {time(span.start_ms)} → {time(span.end_ms)}
            </bdi>
            <span>{time(span.end_ms - span.start_ms)}</span>
          </li>
        ))}
      </ol>
      <div className="enhancement">
        <h2>Conservative cleanup</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={processing.enabled}
            onChange={(e) => {
              setProcessing({ ...processing, enabled: e.target.checked });
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
                onChange={(e) => {
                  setProcessing({ ...processing, [key]: e.target.checked });
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
              {(["clean", "enhanced"] as const).map((v) => (
                <button
                  key={v}
                  aria-pressed={v === version}
                  onClick={() => {
                    switchTime.current = previewAudio.current?.currentTime ?? 0;
                    setVersion(v);
                  }}
                >
                  {v === "clean" ? "Clean" : "Enhanced"}
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
