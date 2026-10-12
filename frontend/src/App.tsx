import { useCallback, useEffect, useState } from "react";
import { api, time, bytes } from "./api";
import { AudioPreparation } from "./AudioPreparation";
import { TranscriptEditor } from "./TranscriptEditor";
import { Review } from "./Review";
import { QueueView } from "./QueueView";
import { Backups, Settings } from "./SettingsBackups";
import { LectureDialog, CourseDialog } from "./Dialogs";
import type {
  Course,
  Lecture,
  Queue,
  Preferences,
  SearchResult,
} from "./types";

type Page =
  | "library"
  | "audio"
  | "editor"
  | "review"
  | "queue"
  | "backups"
  | "settings";
const navigation: { id: Page; name: string; symbol: string }[] = [
  { id: "library", name: "Library", symbol: "▤" },
  { id: "audio", name: "Audio Preparation", symbol: "≋" },
  { id: "editor", name: "Transcript Editor", symbol: "¶" },
  { id: "queue", name: "Queue", symbol: "⇥" },
  { id: "backups", name: "Backups", symbol: "↺" },
  { id: "settings", name: "Settings", symbol: "⚙" },
];
const initialPreferences: Preferences = {
  backup_interval_hours: 24,
  include_audio: false,
  skip_seconds: 5,
  rewind_on_resume: false,
};
export default function App() {
  const [page, setPage] = useState<Page>("library");
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [queue, setQueue] = useState<Queue>({ paused: false, jobs: [] });
  const [preferences, setPreferences] = useState(initialPreferences);
  const [configured, setConfigured] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [seekMs, setSeekMs] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [theme, setTheme] = useState(
    () => localStorage.getItem("lectra-theme") ?? "dark",
  );
  const [courseFilter, setCourseFilter] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [tagFilter, setTagFilter] = useState("");
  const [uploadDialog, setUploadDialog] = useState(false);
  const [editLecture, setEditLecture] = useState<Lecture | null>(null);
  const [courseDialog, setCourseDialog] = useState<Course | "new" | null>(null);
  const onError = useCallback(
    (message: string) => setError(message.replace(/^Error:\s*/, "")),
    [],
  );
  const refresh = useCallback(async () => {
    const [ls, cs, q, p, system] = await Promise.all([
      api<Lecture[]>("/lectures"),
      api<Course[]>("/courses"),
      api<Queue>("/queue"),
      api<Preferences>("/settings"),
      api<{ provider_configured: boolean }>("/system/status"),
    ]);
    setLectures(ls);
    setCourses(cs);
    setQueue(q);
    setPreferences(p);
    setConfigured(system.provider_configured);
    setLoaded(true);
  }, []);
  useEffect(() => {
    void refresh().catch((e) => onError(String(e)));
    const timer = setInterval(
      () => void refresh().catch((e) => onError(String(e))),
      3000,
    );
    return () => clearInterval(timer);
  }, [refresh, onError]);
  useEffect(() => {
    window.document.documentElement.dataset.theme = theme;
    localStorage.setItem("lectra-theme", theme);
  }, [theme]);
  useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(
      () =>
        void api<SearchResult[]>("/search?q=" + encodeURIComponent(query))
          .then((r) => {
            if (!cancelled) setResults(r);
          })
          .catch((e) => onError(String(e))),
      250,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, onError]);
  const lecture = lectures.find((l) => l.id === selected) ?? null;
  function open(id: string, next: Page = "library", at: number | null = null) {
    setSelected(id);
    setSeekMs(at);
    setPage(next);
  }
  const visible = lectures.filter(
    (l) =>
      (!courseFilter || l.course_id === courseFilter) &&
      (!tagFilter || l.tags.includes(tagFilter)),
  );
  const waiting = queue.jobs.filter((j) =>
    ["queued", "running", "unknown_outcome"].includes(j.state),
  ).length;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          href="#"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            setPage("library");
          }}
        >
          <span className="brand-mark">L</span>
          <span>
            lectra<span className="brand-sub">LECTURE WORKSTATION</span>
          </span>
        </a>
        <nav aria-label="Workspace">
          {navigation.map((item, i) => (
            <button
              key={item.id}
              className={
                (page === item.id || (page === "review" && item.id === "audio")
                  ? "active "
                  : "") + (i === 3 ? "secondary-nav" : "")
              }
              aria-current={page === item.id ? "page" : undefined}
              disabled={
                (item.id === "audio" || item.id === "editor") && !lecture
              }
              onClick={() => setPage(item.id)}
            >
              <span aria-hidden="true">{item.symbol}</span>
              {item.name}
              {item.id === "queue" && waiting > 0 && (
                <b className="nav-count">{waiting}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="local-indicator">
            <span aria-hidden="true">●</span> Local workspace
          </div>
          <p>
            Audio stays local until
            <br />
            you confirm transcription.
          </p>
          <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "☀ Light mode" : "☾ Dark mode"}
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            {page === "review"
              ? "Audio Preparation / Review"
              : navigation.find((n) => n.id === page)?.name}
          </span>
          <div>
            <span className="hint">
              {queue.paused ? "Queue paused" : "Sequential worker"}
            </span>
            <bdi className="workspace-label">LECTRA / V1</bdi>
          </div>
        </header>
        <main>
          {error && (
            <div className="error-banner" role="alert">
              <div>
                <strong>Attention needed</strong>
                <p>{error}</p>
              </div>
              <button aria-label="Dismiss message" onClick={() => setError("")}>
                ×
              </button>
            </div>
          )}
          {!loaded && <p role="status">Connecting to your local workspace…</p>}
          {page === "library" && (
            <section>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">YOUR PRIVATE LECTURE LIBRARY</p>
                  <h1>Room to think.</h1>
                  <p>
                    Prepare the recording. Refine the words. Keep the knowledge.
                  </p>
                </div>
                <button
                  className="primary"
                  onClick={() => setUploadDialog(true)}
                >
                  + Import lecture
                </button>
              </div>
              <div className="library-tools">
                <input
                  className="search"
                  aria-label="Search lectures and transcripts"
                  placeholder="Search lectures and transcripts…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <select
                  aria-label="Filter course"
                  value={courseFilter}
                  onChange={(e) => setCourseFilter(e.target.value)}
                >
                  <option value="">All courses</option>
                  {courses.map((c) => (
                    <option value={c.id} key={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter tag"
                  value={tagFilter}
                  onChange={(e) => setTagFilter(e.target.value)}
                >
                  <option value="">All tags</option>
                  {[...new Set(lectures.flatMap((l) => l.tags))].map((tag) => (
                    <option key={tag}>{tag}</option>
                  ))}
                </select>
                <button onClick={() => setCourseDialog("new")}>+ Course</button>
              </div>
              <div className="course-strip">
                {courses.map((c) => (
                  <button key={c.id} onClick={() => setCourseDialog(c)}>
                    <bdi>{c.name}</bdi>
                    <span> · {c.vocabulary.length} keyterms</span>
                  </button>
                ))}
              </div>
              {results !== null ? (
                <div className="search-results">
                  <p className="eyebrow">{results.length} MATCHING PASSAGES</p>
                  {results.map((r, i) => (
                    <button
                      key={i}
                      onClick={() =>
                        open(
                          r.lecture_id,
                          r.block_id ? "editor" : "library",
                          r.start_ms,
                        )
                      }
                    >
                      <div>
                        <strong>
                          <bdi>{r.title}</bdi>
                        </strong>
                        <span>
                          {r.course}{" "}
                          {r.start_ms !== null && "· " + time(r.start_ms)}
                        </span>
                      </div>
                      <p dir="auto">{r.snippet}</p>
                    </button>
                  ))}
                  {!results.length && (
                    <p>
                      No matching passages. Arabic/Persian Yeh and Kaf variants
                      are normalized for search.
                    </p>
                  )}
                </div>
              ) : (
                <div className="library-layout">
                  <div className="lecture-list">
                    <div className="list-heading">
                      <span>LECTURES</span>
                      <span>
                        {visible.length} recording
                        {visible.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    {!visible.length && (
                      <div className="empty">
                        <div className="empty-wave" aria-hidden="true">
                          ▂ ▅ ▃ ▇ ▆ ▂ ▄ ▆ ▃
                        </div>
                        <h2>Your next lecture starts here</h2>
                        <p>
                          Import a recording, choose a course, and keep every
                          word worth keeping.
                        </p>
                        <button onClick={() => setUploadDialog(true)}>
                          Import your first lecture
                        </button>
                      </div>
                    )}
                    {visible.map((l) => (
                      <button
                        className={
                          "lecture-row " + (selected === l.id ? "selected" : "")
                        }
                        key={l.id}
                        onClick={() => setSelected(l.id)}
                      >
                        <span className="lecture-icon" aria-hidden="true">
                          ≋
                        </span>
                        <span className="lecture-info">
                          <strong dir="auto">{l.title}</strong>
                          <span>
                            <bdi>{l.course ?? "Unfiled"}</bdi> · {l.date}
                            {l.duration_ms > 0 && " · " + time(l.duration_ms)}
                          </span>
                          <span className="tag-list">
                            {l.tags.map((tag) => (
                              <bdi key={tag}>{tag}</bdi>
                            ))}
                          </span>
                        </span>
                        <span className="lecture-status">
                          {l.transcript_id
                            ? "Transcript available"
                            : l.status.replaceAll("_", " ")}
                        </span>
                      </button>
                    ))}
                  </div>
                  <aside className="lecture-detail">
                    {lecture ? (
                      <>
                        <p className="eyebrow">SELECTED LECTURE</p>
                        <h2 dir="auto">{lecture.title}</h2>
                        <p>
                          <bdi>{lecture.course ?? "Unfiled"}</bdi>
                          <br />
                          {lecture.date}
                        </p>
                        <dl>
                          <div>
                            <dt>Edited duration</dt>
                            <dd>{time(lecture.duration_ms)}</dd>
                          </div>
                          <div>
                            <dt>Original</dt>
                            <dd>
                              {lecture.media.some((a) => a.kind === "original")
                                ? "Preserved"
                                : "Unavailable"}
                            </dd>
                          </div>
                          <div>
                            <dt>Transcript</dt>
                            <dd>
                              {lecture.transcript_id
                                ? "Ready to edit"
                                : "Not yet available"}
                            </dd>
                          </div>
                        </dl>
                        <button
                          className="primary wide"
                          onClick={() => setPage("audio")}
                        >
                          Prepare audio →
                        </button>
                        <button
                          className="wide"
                          disabled={!lecture.transcript_id}
                          onClick={() => setPage("editor")}
                        >
                          Open transcript
                        </button>
                        <button
                          className="text-button"
                          onClick={() => setEditLecture(lecture)}
                        >
                          Edit title, course, and tags
                        </button>
                        <details>
                          <summary>Storage and original recording</summary>
                          <p className="hint">
                            {bytes(
                              lecture.media.reduce((sum, a) => sum + a.size, 0),
                            )}{" "}
                            live media. Deleting the original preserves the
                            transcript and playback proxy; copies in older
                            backups remain.
                          </p>
                          <button
                            className="danger"
                            disabled={
                              !lecture.media.some((a) => a.kind === "original")
                            }
                            onClick={() => {
                              if (
                                confirm(
                                  "Delete the original recording? The transcript and retained playback proxy will remain. Older backups may still contain it.",
                                )
                              )
                                void api(
                                  "/lectures/" +
                                    lecture.id +
                                    "/original-audio?confirmed=true",
                                  "DELETE",
                                )
                                  .then(refresh)
                                  .catch((e) => onError(String(e)));
                            }}
                          >
                            Delete original audio
                          </button>
                        </details>
                      </>
                    ) : (
                      <>
                        <p className="eyebrow">A FOCUSED WORKSPACE</p>
                        <h2>
                          From recording
                          <br />
                          to understanding.
                        </h2>
                        <p>
                          Select a lecture to prepare its audio or continue
                          editing.
                        </p>
                        <div className="workflow-steps">
                          <span>
                            01 <b>Prepare audio</b>
                          </span>
                          <span>
                            02 <b>Review & transcribe</b>
                          </span>
                          <span>
                            03 <b>Refine & keep</b>
                          </span>
                        </div>
                      </>
                    )}
                  </aside>
                </div>
              )}
            </section>
          )}
          {page === "audio" && lecture && (
            <AudioPreparation
              key={lecture.id}
              lecture={lecture}
              onUpdate={refresh}
              review={() => setPage("review")}
              onError={onError}
            />
          )}
          {page === "review" && lecture && (
            <Review
              key={lecture.id}
              lecture={lecture}
              courses={courses}
              configured={configured}
              onQueued={() => {
                setPage("queue");
                void refresh().catch((e) => onError(String(e)));
              }}
              onError={onError}
            />
          )}
          {page === "editor" && lecture && (
            <TranscriptEditor
              key={lecture.transcript_id ?? lecture.id}
              lecture={lecture}
              preferences={preferences}
              onError={onError}
              seekMs={seekMs}
            />
          )}
          {page === "queue" && (
            <QueueView
              queue={queue}
              refresh={refresh}
              open={(id) => open(id)}
              onError={onError}
            />
          )}
          {page === "backups" && (
            <Backups preferences={preferences} onError={onError} />
          )}
          {page === "settings" && (
            <Settings
              preferences={preferences}
              refresh={refresh}
              onError={onError}
            />
          )}
        </main>
        <footer className="workspace-footer">
          <span>Local files. Durable checkpoints. Your words.</span>
          <span>No analytics or telemetry.</span>
        </footer>
      </div>
      {(uploadDialog || editLecture) && (
        <LectureDialog
          courses={courses}
          existing={editLecture}
          onClose={() => {
            setUploadDialog(false);
            setEditLecture(null);
          }}
          onSaved={async (id) => {
            await refresh();
            setSelected(id);
            setUploadDialog(false);
            setEditLecture(null);
          }}
          onError={onError}
        />
      )}
      {courseDialog && (
        <CourseDialog
          course={courseDialog === "new" ? null : courseDialog}
          onClose={() => setCourseDialog(null)}
          onSaved={async () => {
            await refresh();
            setCourseDialog(null);
          }}
          onError={onError}
        />
      )}
    </div>
  );
}
