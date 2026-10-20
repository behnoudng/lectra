export type Span = { start_ms: number; end_ms: number };
export type Preprocessing = {
  enabled: boolean;
  highpass: boolean;
  denoise: boolean;
  loudness: boolean;
};
export type Options = {
  language_code: string | null;
  diarize: boolean;
  num_speakers: number | null;
  tag_audio_events: boolean;
  keyterms_enabled: boolean;
  keyterms: string[];
  preprocessing: Preprocessing;
  mode: "chunked" | "whole";
  target_ms: number;
};
export const defaults: Options = {
  language_code: null,
  diarize: false,
  num_speakers: null,
  tag_audio_events: false,
  keyterms_enabled: true,
  keyterms: [],
  preprocessing: {
    enabled: false,
    highpass: true,
    denoise: true,
    loudness: true,
  },
  mode: "chunked",
  target_ms: 900000,
};
export type Course = {
  id: string;
  name: string;
  preset: Options;
  vocabulary: string[];
};
export type Asset = {
  id: string;
  kind: string;
  duration_ms: number;
  sha256: string;
  size: number;
};
export type Lecture = {
  id: string;
  is_used: boolean;
  title: string;
  date: string;
  course_id: string | null;
  course: string | null;
  tags: string[];
  status: string;
  edl: Span[];
  preprocessing: Partial<Preprocessing>;
  media: Asset[];
  duration_ms: number;
  transcript_id: string | null;
};
export type Block = {
  id: string;
  text: string;
  start_ms: number | null;
  end_ms: number | null;
  speaker_key: string | null;
  direction_override: "rtl" | "ltr" | null;
  alignment_status: "provider_exact" | "edited_anchor" | "unaligned";
  ordinal: number;
  chunk_id?: string | null;
  marks_json: Record<string, unknown>;
};
export type Transcript = {
  id: string;
  lecture_id: string;
  job_id: string;
  revision: number;
  blocks: Block[];
  speakers: Record<string, string>;
};
export type Attempt = {
  id: string;
  chunk_id: string;
  state: string;
  attempt_no: number;
  charge_status: string;
  estimated_cost: number | null;
  currency: string | null;
  request_hash: string;
  audio_sha256: string;
  response_persisted_at: string | null;
  retry_of_attempt_id: string | null;
  http_status: number | null;
  error_code: string | null;
  error_message: string | null;
  request_id: string | null;
  diagnostic?: ProviderDiagnostic;
};
export type ProviderDiagnostic = {
  http_status: number | null;
  error_code: string | null;
  error_message: string | null;
  request_id: string | null;
  help: string;
};
export type Chunk = {
  id: string;
  state: string;
  ordinal: number;
  start_ms: number;
  end_ms: number;
  error_category: string | null;
};
export type Job = {
  id: string;
  lecture_id: string;
  title: string;
  state: string;
  position: number;
  duration_ms: number;
  settings: Options;
  estimated_cost: number | null;
  currency: string | null;
  chunks: Chunk[];
  attempts: Attempt[];
  transcript_id: string | null;
};
export type Queue = { paused: boolean; jobs: Job[] };
export type ProviderStatus = {
  status: string;
  credential_source: string;
  key_configured: boolean;
  transcription_verified: boolean;
  message?: string;
  reason?: string;
  subscription?: Record<string, unknown>;
  http_status?: number;
  last_transcription?: {
    state: string;
    created_at: string;
    diagnostic: ProviderDiagnostic | null;
  } | null;
};
export type Estimate = {
  review_hash: string;
  duration_ms: number;
  requests: number;
  estimated_billable_ms: number;
  estimated_cost: number | null;
  currency: string | null;
  feature_adjustment_basis_points: number | null;
  warnings: string[];
  pricing_rule: {
    id: string;
    source_note: string;
    effective_from: string;
  } | null;
  incremental_payment: null;
};
export type Preferences = {
  backup_interval_hours: number;
  include_audio: boolean;
  skip_seconds: number;
  skip_forward_seconds?: number | null;
  rewind_on_resume: boolean;
  shortcuts?: Shortcuts;
};
export type Shortcuts = {
  play_pause: "Ctrl+Space" | "Alt+P";
  backward: "Alt+ArrowLeft" | "Alt+J";
  forward: "Alt+ArrowRight" | "Alt+L";
  help: "?" | "Alt+H";
};
export const defaultShortcuts: Shortcuts = {
  play_pause: "Ctrl+Space",
  backward: "Alt+ArrowLeft",
  forward: "Alt+ArrowRight",
  help: "?",
};
export type Snapshot = {
  id: string;
  created_at: string;
  include_audio: boolean;
  size: number;
  status: string;
};
export type SearchResult = {
  lecture_id: string;
  is_used: boolean;
  block_id: string | null;
  start_ms: number | null;
  snippet: string;
  title: string;
  course: string | null;
};
