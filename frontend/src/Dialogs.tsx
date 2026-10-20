import { Select } from "./Select";
import { useDialog } from "./useDialog";
import { useRef, useState, type FormEvent } from "react";
import { api, bytes, upload } from "./api";
import { Icon } from "./Icon";
import { defaults, type Course, type Lecture, type Options } from "./types";
import { NumberField } from "./NumberField";
export function LectureDialog({
  courses,
  existing,
  onClose,
  onSaved,
  onError,
}: {
  courses: Course[];
  existing: Lecture | null;
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState(existing?.title ?? "");
  const [date, setDate] = useState(
    existing?.date ?? new Date().toLocaleDateString("en-CA"),
  );
  const [course, setCourse] = useState(existing?.course_id ?? "");
  const [tags, setTags] = useState(existing?.tags.join(", ") ?? "");
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const dialog = useDialog<HTMLFormElement>(onClose, !busy);
  const [localError, setLocalError] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      let lectureId = existing?.id ?? created;
      if (!lectureId) {
        const l = await api<Lecture>("/lectures", "POST", {
          title,
          date,
          course_id: course || null,
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        });
        lectureId = l.id;
        setCreated(l.id);
      } else
        await api("/lectures/" + lectureId, "PATCH", {
          title,
          date,
          course_id: course || null,
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        });
      if (file && !existing) await upload(lectureId, file, setProgress);
      await onSaved(lectureId);
    } catch (e) {
      setLocalError(String(e));
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function choose(f: File | null) {
    setFile(f);
    if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, ""));
  }
  return (
    <div className="modal-backdrop">
      <form
        ref={dialog}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-title"
        onSubmit={(e) => void submit(e)}
      >
        <div className="modal-title">
          <h2 id="upload-title">
            {existing ? "Edit lecture" : "Import a lecture"}
          </h2>
          <button
            type="button"
            disabled={busy}
            aria-label="Close dialog"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <label>
          Lecture title
          <input
            autoFocus
            required
            dir="auto"
            maxLength={300}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <div className="form-grid">
          <label>
            Course
            <Select value={course} onValueChange={(value) => setCourse(value)}>
              <option value="">Unfiled</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </label>
          <label>
            Date
            <input
              type="date"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
        </div>
        <label>
          Tags (comma separated)
          <input
            dir="auto"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
          />
        </label>
        {!existing && (
          <div
            className={"file-drop" + (dragging ? " is-dragging" : "")}
            onDragOver={(e) => {
              e.preventDefault();
              if (!busy) setDragging(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                setDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (!busy && e.dataTransfer.files[0])
                choose(e.dataTransfer.files[0]);
            }}
          >
            <div className="upload-icon">
              <Icon name="upload" />
            </div>
            <strong dir="auto">
              {file ? file.name : "Drop a lecture recording here"}
            </strong>
            <span>
              {file
                ? bytes(file.size)
                : "Audio or video · your original stays preserved"}
            </span>
            <div className="file-actions">
              <button
                type="button"
                className="choose-recording"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
              >
                <Icon name="upload" />
                {file ? "Change recording" : "Choose recording"}
              </button>
              {file && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    choose(null);
                    if (fileInput.current) fileInput.current.value = "";
                  }}
                >
                  Remove file
                </button>
              )}
            </div>
            <input
              ref={fileInput}
              hidden
              aria-label="Lecture recording"
              type="file"
              disabled={busy}
              accept="audio/*,video/*"
              onChange={(e) => {
                if (e.target.files?.[0]) choose(e.target.files[0]);
              }}
            />
          </div>
        )}
        {busy && (
          <div role="status">
            <progress max="100" value={progress} />
            <p>
              {progress < 100
                ? `Uploading ${Math.round(progress)}%`
                : "Original received. Validating media and generating waveform…"}
            </p>
          </div>
        )}
        <p className="hint">
          Originals are preserved. Importing does not authorize transcription.
        </p>
        {localError && (
          <p className="notice warning" role="alert">
            {localError}
          </p>
        )}
        <div className="page-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || (!existing && !file)}>
            {existing
              ? "Save lecture"
              : busy
                ? "Preparing…"
                : "Import recording"}
          </button>
        </div>
      </form>
    </div>
  );
}
export function CourseDialog({
  course,
  onClose,
  onSaved,
  onError,
}: {
  course: Course | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(course?.name ?? "");
  const [vocab, setVocab] = useState(course?.vocabulary.join("\n") ?? "");
  const [preset, setPreset] = useState<Options>(course?.preset ?? defaults);
  const [busy, setBusy] = useState(false);
  const dialog = useDialog<HTMLFormElement>(onClose, !busy);
  const [localError, setLocalError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const c = await api<Course>(
        "/courses" + (course ? "/" + course.id : ""),
        course ? "PATCH" : "POST",
        { name, preset },
      );
      await api("/courses/" + c.id + "/vocabulary", "PUT", {
        terms: vocab
          .split("\n")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      await onSaved();
    } catch (e) {
      setLocalError(String(e));
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <form
        ref={dialog}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="course-title"
        onSubmit={(e) => void submit(e)}
      >
        <div className="modal-title">
          <h2 id="course-title">
            {course ? "Course defaults" : "Create a course"}
          </h2>
          <button type="button" aria-label="Close dialog" onClick={onClose}>
            ×
          </button>
        </div>
        <label>
          Course name
          <input
            autoFocus
            required
            dir="auto"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Reusable vocabulary, one term per line
          <textarea
            rows={5}
            dir="auto"
            value={vocab}
            onChange={(e) => setVocab(e.target.value)}
          />
        </label>
        <label>
          Default language
          <Select
            value={preset.language_code ?? ""}
            onValueChange={(value) =>
              setPreset({ ...preset, language_code: value || null })
            }
          >
            <option value="">Auto-detect</option>
            <option value="fas">Persian</option>
            <option value="eng">English</option>
          </Select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={preset.diarize}
            onChange={(e) =>
              setPreset({
                ...preset,
                diarize: e.target.checked,
                num_speakers: e.target.checked ? preset.num_speakers : null,
              })
            }
          />
          Default speaker labeling
        </label>
        {preset.diarize && (
          <NumberField
            label="Expected speakers"
            min="1"
            max="32"
            value={preset.num_speakers ?? ""}
            onValueChange={(value) =>
              setPreset({
                ...preset,
                num_speakers: value ? Number(value) : null,
              })
            }
          />
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={preset.tag_audio_events}
            onChange={(e) =>
              setPreset({ ...preset, tag_audio_events: e.target.checked })
            }
          />
          Default audio-event labels
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={preset.preprocessing.enabled}
            onChange={(e) =>
              setPreset({
                ...preset,
                preprocessing: {
                  ...preset.preprocessing,
                  enabled: e.target.checked,
                },
              })
            }
          />
          Default conservative enhancement
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={preset.keyterms_enabled ?? true}
            onChange={(e) =>
              setPreset({
                ...preset,
                keyterms_enabled: e.target.checked,
                keyterms: e.target.checked ? preset.keyterms : [],
              })
            }
          />
          Default reviewed keyterms enabled
        </label>
        <p className="hint">
          Course defaults are always reviewed before a provider request.
        </p>
        {localError && (
          <p className="notice warning" role="alert">
            {localError}
          </p>
        )}
        <div className="page-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            Save course
          </button>
        </div>
      </form>
    </div>
  );
}
