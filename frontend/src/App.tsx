import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, time, bytes } from "./api";
import { AudioPreparation } from "./AudioPreparation";
import { TranscriptEditor } from "./TranscriptEditor";
import { Review } from "./Review";
import { QueueView } from "./QueueView";
import { Backups, Settings } from "./SettingsBackups";
import { LectureDialog, CourseDialog } from "./Dialogs";
import { Icon, type IconName } from "./Icon";
import { Select } from "./Select";
import { LectureActions } from "./LectureActions";
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
const navigation: { id: Page; name: string; icon: IconName }[] = [
  { id: "library", name: "Library", icon: "library" },
  { id: "audio", name: "Audio Preparation", icon: "audio" },
  { id: "editor", name: "Transcript Editor", icon: "editor" },
  { id: "queue", name: "Queue", icon: "queue" },
  { id: "backups", name: "Backups", icon: "backups" },
  { id: "settings", name: "Settings", icon: "settings" },
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
  const [results, setResults] = useState<{
    key: string;
    items: SearchResult[];
  } | null>(null);
  const [tagFilter, setTagFilter] = useState("");
  const [hideUsed, setHideUsed] = useState(false);
  const [searchRevision, setSearchRevision] = useState(0);
  const [savingUsage, setSavingUsage] = useState<Set<string>>(new Set());
  const pendingUsage = useRef(new Set<string>());
  const usageEpoch = useRef(0);
  const searchKey = JSON.stringify([
    query.trim(),
    courseFilter,
    tagFilter,
    hideUsed,
    searchRevision,
  ]);
  const [uploadDialog, setUploadDialog] = useState(false);
  const [editLecture, setEditLecture] = useState<Lecture | null>(null);
  const [courseDialog, setCourseDialog] = useState<Course | "new" | null>(null);
  const onError = useCallback(
    (message: string) => setError(message.replace(/^Error:\s*/, "")),
    [],
  );
  const refresh = useCallback(async () => {
    const startedAt = usageEpoch.current;
    const [ls, cs, q, p, system] = await Promise.all([
      api<Lecture[]>("/lectures"),
      api<Course[]>("/courses"),
      api<Queue>("/queue"),
      api<Preferences>("/settings"),
      api<{ provider_configured: boolean }>("/system/status"),
    ]);
    // A read started before a successful mark must not rewind that mark.
    if (startedAt === usageEpoch.current) setLectures(ls);
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
    const params = new URLSearchParams({ q: query.trim() });
    if (courseFilter === "unfiled") params.set("unfiled", "true");
    else if (courseFilter) params.set("course_id", courseFilter);
    if (tagFilter) params.set("tag", tagFilter);
    if (hideUsed) params.set("unused_only", "true");
    const timer = setTimeout(
      () =>
        void api<SearchResult[]>("/search?" + params)
          .then((r) => {
            if (!cancelled) setResults({ key: searchKey, items: r });
          })
          .catch((e) => {
            if (!cancelled) {
              setResults({ key: searchKey, items: [] });
              onError(String(e));
            }
          }),
      250,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, courseFilter, tagFilter, hideUsed, searchKey, onError]);
  async function toggleUsage(target: Lecture) {
    if (pendingUsage.current.has(target.id)) return;
    pendingUsage.current.add(target.id);
    setSavingUsage(new Set(pendingUsage.current));
    try {
      const updated = await api<Lecture>(
        "/lectures/" + target.id + "/usage",
        "PATCH",
        { is_used: !target.is_used },
      );
      usageEpoch.current++;
      setLectures((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setSearchRevision((revision) => revision + 1);
      void refresh().catch((e) => onError(String(e)));
    } catch (e) {
      onError(String(e));
    } finally {
      pendingUsage.current.delete(target.id);
      setSavingUsage(new Set(pendingUsage.current));
    }
  }
  const lecture = lectures.find((l) => l.id === selected) ?? null;
  function open(id: string, next: Page = "library", at: number | null = null) {
    setSelected(id);
    setSeekMs(at);
    setPage(next);
  }
  const visible = useMemo(
    () =>
      lectures.filter(
        (l) =>
          (!courseFilter ||
            (courseFilter === "unfiled"
              ? l.course_id === null
              : l.course_id === courseFilter)) &&
          (!tagFilter || l.tags.includes(tagFilter)) &&
          (!hideUsed || !l.is_used),
      ),
    [lectures, courseFilter, tagFilter, hideUsed],
  );
  const visibleIds = new Set(visible.map((item) => item.id));
  const matching =
    results?.key === searchKey
      ? results.items.filter((item) => visibleIds.has(item.lecture_id))
      : [];
  const hasFilters = Boolean(
    courseFilter || tagFilter || hideUsed || query.trim(),
  );
  function clearFilters() {
    setCourseFilter("");
    setTagFilter("");
    setHideUsed(false);
    setQuery("");
  }
  useEffect(() => {
    if (
      page === "library" &&
      loaded &&
      selected &&
      !visible.some((item) => item.id === selected)
    )
      setSelected(null);
  }, [page, loaded, selected, visible]);
  useEffect(() => {
    if (
      loaded &&
      courseFilter &&
      courseFilter !== "unfiled" &&
      !courses.some((course) => course.id === courseFilter)
    )
      setCourseFilter("");
  }, [loaded, courses, courseFilter]);
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
              aria-current={
                page === item.id || (page === "review" && item.id === "audio")
                  ? "page"
                  : undefined
              }
              disabled={
                (item.id === "audio" || item.id === "editor") && !lecture
              }
              onClick={() => setPage(item.id)}
            >
              <span className="nav-icon" aria-hidden="true">
                <Icon name={item.icon} />
              </span>
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
          <button
            className="theme-toggle"
            title={
              theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
            }
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            <span className="theme-icon">
              <Icon name={theme === "dark" ? "sun" : "moon"} />
            </span>
            <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
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
                <Select
                  aria-label="Filter tag"
                  value={tagFilter}
                  onValueChange={setTagFilter}
                >
                  <option value="">All tags</option>
                  {[...new Set(lectures.flatMap((l) => l.tags))].map((tag) => (
                    <option key={tag}>{tag}</option>
                  ))}
                </Select>
                <label className="check hide-used">
                  <input
                    type="checkbox"
                    checked={hideUsed}
                    onChange={(e) => setHideUsed(e.target.checked)}
                  />
                  Hide used
                </label>
                <button onClick={() => setCourseDialog("new")}>+ Course</button>
              </div>
              <div
                className="course-strip"
                role="group"
                aria-label="Filter by course"
              >
                <button
                  className="course-filter"
                  aria-pressed={!courseFilter}
                  onClick={() => setCourseFilter("")}
                >
                  All courses{" "}
                  <span className="course-count">{lectures.length}</span>
                </button>
                {courses.map((c) => (
                  <div className="course-chip" key={c.id}>
                    <button
                      className="course-filter"
                      aria-pressed={courseFilter === c.id}
                      onClick={() => setCourseFilter(c.id)}
                    >
                      <bdi>{c.name}</bdi>
                      <span className="course-count">
                        {lectures.filter((l) => l.course_id === c.id).length}
                      </span>
                    </button>
                    <button
                      className="course-edit"
                      aria-label={`Edit course ${c.name}`}
                      onClick={() => setCourseDialog(c)}
                    >
                      <Icon name="edit" />
                    </button>
                  </div>
                ))}
                {lectures.some((l) => l.course_id === null) && (
                  <button
                    className="course-filter"
                    aria-pressed={courseFilter === "unfiled"}
                    onClick={() => setCourseFilter("unfiled")}
                  >
                    Unfiled{" "}
                    <span className="course-count">
                      {lectures.filter((l) => l.course_id === null).length}
                    </span>
                  </button>
                )}
                {hasFilters && (
                  <button
                    className="clear-filters text-button"
                    onClick={clearFilters}
                  >
                    Clear filters
                  </button>
                )}
              </div>
              {query.trim() ? (
                <div className="search-results">
                  {results?.key !== searchKey ? (
                    <p role="status">Searching…</p>
                  ) : (
                    <p className="eyebrow">
                      {matching.length} MATCHING PASSAGES
                    </p>
                  )}
                  {matching.map((r, i) => {
                    const target = lectures.find((l) => l.id === r.lecture_id)!;
                    return (
                      <LectureActions
                        key={`${r.lecture_id}-${r.block_id}-${i}`}
                        lecture={target}
                        busy={savingUsage.has(target.id)}
                        onToggle={(l) => void toggleUsage(l)}
                        className={
                          "search-result" + (target.is_used ? " is-used" : "")
                        }
                      >
                        <button
                          className="search-result-main"
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
                              {target.is_used && (
                                <span className="used-badge">
                                  <Icon name="check" />
                                  Used
                                </span>
                              )}
                            </strong>
                            <span>
                              {r.course}{" "}
                              {r.start_ms !== null && "· " + time(r.start_ms)}
                            </span>
                          </div>
                          <p dir="auto">{r.snippet}</p>
                        </button>
                      </LectureActions>
                    );
                  })}
                  {results?.key === searchKey && !matching.length && (
                    <p>
                      No matching passages. Arabic/Persian Yeh and Kaf variants
                      are normalized for search.{" "}
                      <button className="text-button" onClick={clearFilters}>
                        Clear filters
                      </button>
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
                        <h2>
                          {lectures.length
                            ? "No matching lectures"
                            : "Your next lecture starts here"}
                        </h2>
                        <p>
                          {lectures.length
                            ? "Try another course or clear your filters to see more recordings."
                            : "Import a recording, choose a course, and keep every word worth keeping."}
                        </p>
                        <button
                          onClick={() =>
                            lectures.length
                              ? clearFilters()
                              : setUploadDialog(true)
                          }
                        >
                          {lectures.length
                            ? "Clear filters"
                            : "Import your first lecture"}
                        </button>
                      </div>
                    )}
                    {visible.map((l) => (
                      <LectureActions
                        className={
                          "lecture-row " +
                          (selected === l.id ? "selected " : "") +
                          (l.is_used ? "is-used" : "")
                        }
                        key={l.id}
                        lecture={l}
                        busy={savingUsage.has(l.id)}
                        onToggle={(target) => void toggleUsage(target)}
                      >
                        <button
                          className="lecture-select"
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
                              {l.is_used && (
                                <span className="used-badge">
                                  <Icon name="check" />
                                  Used
                                </span>
                              )}
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
                      </LectureActions>
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
            // A new recording should be visible even if old filters exclude it.
            if (uploadDialog) clearFilters();
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
