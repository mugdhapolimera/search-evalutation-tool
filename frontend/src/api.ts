// Types mirror search_eval/presenters.py. Every number comes from the server.

export type Grade = 0 | 1 | 2 | 3 | 'skip' | null;
export type Intent = 'topical' | 'author' | 'known_item';
export type RatingMode = 'graded' | 'binary';

export interface Option {
  value: string;
  label: string;
  definition?: string;
}

export interface AppConfig {
  environments: { name: string; label: string }[];
  baseline_environment: string;
  default_variant_environment: string;
  disciplines: Option[];
  intents: Option[];
  production_weights: { field: string; weight: number }[];
  qf_fields: string[];
  score_k: number;
  rubric: Record<RatingMode, Option[]>;
}

export interface Authors {
  shown: string[];
  total: number;
}

export interface ResultRow {
  rank: number;
  bibcode: string;
  title: string | null;
  authors: Authors;
  year: string | null;
  pub: string | null;
  grade: Grade;
  move: number | 'new' | null;
}

export interface Metrics {
  headline_label: string;
  headline: number | null;
  delta: number | null;
  verdict: 'better' | 'worse' | 'same' | null;
  relevant_in_top_k: number;
  relevant_change: number | null;
  rated_in_top_k: number | null;
  provisional: boolean;
  range: [number | null, number | null];
  same_as_baseline: number | null;
  details: {
    ndcg: number | null;
    precision: number | null;
    success: number | null;
    rbo: number | null;
    overlap: number | null;
    gain: string | null;
    pool_size: number | null;
  };
}

export interface Column {
  id: number;
  is_baseline: boolean;
  environment: string;
  environment_label: string;
  params: Record<string, string>;
  changes: string[];
  warnings: string[];
  status: 'ok' | 'error';
  error: string | null;
  num_found: number | null;
  results: ResultRow[];
  dropped: { bibcode: string; title: string | null; was: number; grade: Grade }[];
  metrics: Metrics | null;
}

export interface Session {
  id: number;
  query: string;
  information_need: string | null;
  goal: string | null;
  discipline: string | null;
  intent: Intent;
  rating_mode: RatingMode;
  rubric_version: string;
  k: number;
  counts: { pool: number; rated: number; skipped: number; unrated: number };
  columns: Column[];
}

export interface SessionSummary {
  id: number;
  query: string;
  intent: Intent;
  created_at: string | null;
  tweaks: number;
  rated: number;
}

export interface BoardRecord {
  bibcode: string;
  title: string | null;
  authors: Authors;
  year: string | null;
  pub: string | null;
  abstract: string | null;
  note?: string | null;
}

export interface BoardGroup {
  grade: number;
  label: string;
  definition: string;
  ordered: boolean;
  records: BoardRecord[];
}

export interface Board {
  information_need: string | null;
  rating_mode: RatingMode;
  groups: BoardGroup[];
  skip: { label: string; definition: string };
  skipped: BoardRecord[];
  unsorted: BoardRecord[];
}

export interface BoardSave {
  rater: string;
  groups: { grade: number; ordered: boolean; bibcodes: string[] }[];
  skipped: { bibcode: string; note: string | null }[];
}

export class ApiError extends Error {}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const resp = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new ApiError(data.error ?? `The server answered ${resp.status}.`);
  }
  return data as T;
}

export const api = {
  config: () => request<AppConfig>('GET', '/config'),
  recent: () => request<SessionSummary[]>('GET', '/sessions'),
  search: (body: { query: string; discipline?: string | null; intent?: Intent }) =>
    request<Session>('POST', '/sessions', body),
  session: (id: number) => request<Session>('GET', `/sessions/${id}`),
  updateSession: (id: number, body: Partial<Pick<Session, 'information_need' | 'goal' | 'discipline' | 'intent'>>) =>
    request<Session>('PATCH', `/sessions/${id}`, body),
  tweak: (id: number, body: { env: string; qf?: string; boost?: string }) =>
    request<Session>('POST', `/sessions/${id}/runs`, body),
  board: (id: number) => request<Board>('GET', `/sessions/${id}/board`),
  saveBoard: (id: number, body: BoardSave) =>
    request<{ session: Session; board: Board }>('PUT', `/sessions/${id}/board`, body),
};
