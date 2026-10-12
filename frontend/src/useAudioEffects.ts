import { useEffect, useState, type RefObject } from "react";
import type WaveSurfer from "wavesurfer.js";
import { api } from "./api";
import type { Preprocessing } from "./types";

export function useAudioEffects(
  wave: RefObject<WaveSurfer | null>,
  loaded: boolean,
  lectureId: string,
  sourceId: string | undefined,
  duration: number,
  peaks: number[],
  processing: Preprocessing,
  onError: (message: string) => void,
) {
  const [state, setState] = useState<
    "original" | "loading" | "enhanced" | "failed"
  >("original");
  const [retry, setRetry] = useState(0);
  const [source, setSource] = useState(sourceId);
  const { highpass, denoise, loudness } = processing;
  const enabled = highpass || denoise || loudness;

  useEffect(() => {
    const w = wave.current;
    if (!loaded || !w || !sourceId) return;
    let gone = false;
    const controller = new AbortController();
    w.pause();
    setState("loading");
    const timer = window.setTimeout(
      async () => {
        try {
          const id = enabled
            ? (
                await api<{ id: string }>(
                  "/lectures/" + lectureId + "/monitor-preview",
                  "POST",
                  { enabled: true, highpass, denoise, loudness },
                  controller.signal,
                )
              ).id
            : sourceId;
          if (gone) return;
          if (
            w.getMediaElement().getAttribute("src") !==
            "/api/v1/media/" + id
          ) {
            const at = w.getCurrentTime();
            await w.load("/api/v1/media/" + id, [peaks], duration / 1000);
            if (gone) return;
            w.setTime(Math.min(at, duration / 1000));
          }
          setSource(id);
          setState(enabled ? "enhanced" : "original");
        } catch (error) {
          if (!gone) {
            setState("failed");
            onError(
              "Audio effects could not be prepared. Retry or turn off the effects to hear the original audio.",
            );
          }
        }
      },
      enabled ? 450 : 0,
    );
    return () => {
      gone = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    wave,
    loaded,
    lectureId,
    sourceId,
    duration,
    peaks,
    highpass,
    denoise,
    loudness,
    enabled,
    retry,
    onError,
  ]);

  return {
    state,
    source,
    loading: state === "loading",
    retry: () => setRetry((value) => value + 1),
  };
}
