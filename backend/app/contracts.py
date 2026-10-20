from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator
import unicodedata


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Preprocessing(Contract):
    enabled: bool = False
    highpass: bool = True
    denoise: bool = True
    loudness: bool = True


class TranscriptionSettings(Contract):
    language_code: str | None = Field(default=None, pattern=r"^[a-z]{2,3}$")
    diarize: bool = False
    num_speakers: int | None = Field(default=None, ge=1, le=32)
    tag_audio_events: bool = False
    keyterms_enabled: bool = True
    keyterms: list[str] = Field(default_factory=list, max_length=1000)
    preprocessing: Preprocessing = Field(default_factory=Preprocessing)
    mode: Literal["chunked", "whole"] = "chunked"
    target_ms: int = Field(default=900000, ge=1000, le=3600000)

    @model_validator(mode="after")
    def check(self):
        if self.num_speakers is not None and not self.diarize:
            raise ValueError("Expected speaker count requires diarization.")
        if not self.keyterms_enabled and self.keyterms:
            raise ValueError("Disabled keyterms must have an empty request list.")
        for term in self.keyterms:
            normalized = unicodedata.normalize("NFKC", term).strip()
            if (
                not normalized
                or len(term) >= 50
                or len(normalized.split()) > 5
                or any(c in term for c in "<>{}[]\\")
            ):
                raise ValueError(
                    "Keyterms must be nonempty, under 50 characters, at most five words, and contain no <> {} [] or backslash."
                )
        return self


class CourseInput(Contract):
    name: str = Field(min_length=1, max_length=200)
    preset: TranscriptionSettings = Field(default_factory=TranscriptionSettings)


class VocabularyInput(Contract):
    terms: list[str]


class TagInput(Contract):
    name: str = Field(min_length=1, max_length=80)


class LectureInput(Contract):
    title: str = Field(min_length=1, max_length=300)
    course_id: str | None = None
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    tags: list[str] = Field(default_factory=list, max_length=50)


class LectureUsageInput(Contract):
    is_used: bool = Field(strict=True)


class Span(Contract):
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)


class EDLInput(Contract):
    spans: list[Span] = Field(min_length=1, max_length=300)


class JobInput(Contract):
    lecture_id: str
    settings: TranscriptionSettings
    confirmed: bool = False
    review_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    retranscribe_completed: bool = False


class RetryInput(Contract):
    chunk_id: str
    authorize_charge: bool = False
    reason: str = Field(default="User requested retry", max_length=500)


class OrderInput(Contract):
    job_ids: list[str]


class Block(Contract):
    id: str
    text: str = Field(max_length=200000)
    start_ms: int | None = None
    end_ms: int | None = None
    speaker_key: str | None = None
    direction_override: Literal["rtl", "ltr"] | None = None
    alignment_status: Literal["provider_exact", "edited_anchor", "unaligned"] = (
        "unaligned"
    )
    marks_json: dict = Field(default_factory=dict)
    ordinal: int = 0
    chunk_id: str | None = None
    updated_at: str | None = None
    transcript_id: str | None = None


class TranscriptSave(Contract):
    base_revision: int
    blocks: list[Block] = Field(max_length=10000)
    reason: str = Field(default="autosave", max_length=100)


class SpeakerInput(Contract):
    base_revision: int
    labels: dict[str, str]
    merges: dict[str, str] = Field(default_factory=dict)


class Shortcuts(Contract):
    play_pause: Literal["Ctrl+Space", "Alt+P"] = "Ctrl+Space"
    backward: Literal["Alt+ArrowLeft", "Alt+J"] = "Alt+ArrowLeft"
    forward: Literal["Alt+ArrowRight", "Alt+L"] = "Alt+ArrowRight"
    help: Literal["?", "Alt+H"] = "?"


class Preferences(Contract):
    backup_interval_hours: int = Field(default=24, ge=1, le=8760)
    include_audio: bool = False
    skip_seconds: int = Field(default=5, ge=1, le=60)
    skip_forward_seconds: int | None = Field(default=None, ge=1, le=60)
    rewind_on_resume: bool = False
    shortcuts: Shortcuts = Field(default_factory=Shortcuts)


class Budget(Contract):
    monthly_micros: int | None = Field(default=None, ge=0)
    currency: str = Field(default="USD", pattern=r"^[A-Z]{3}$")


class PriceInput(Contract):
    effective_from: str
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    base_micros_per_hour: int = Field(ge=0)
    keyterms_basis_points: int = Field(default=2000, ge=0, le=100000)
    many_keyterms_min_ms: int = Field(default=20000, ge=0)
    source_note: str = Field(min_length=1, max_length=1000)


class BackupInput(Contract):
    include_audio: bool = False
