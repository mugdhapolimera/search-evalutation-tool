import { ChakraProvider } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { ReactElement } from 'react';
import { AppConfig, Column, Session } from './api';
import { theme } from './scix/theme';

export function renderWithProviders(ui: ReactElement, client = new QueryClient()) {
  return render(
    <ChakraProvider theme={theme}>
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </ChakraProvider>,
  );
}

const row = (rank: number, bibcode: string, grade: Column['results'][number]['grade'], move: Column['results'][number]['move'] = null) => ({
  rank,
  bibcode,
  title: `Title of ${bibcode}`,
  authors: { shown: ['Author, A.'], total: 1 },
  year: '2024',
  pub: 'Icarus',
  grade,
  move,
});

const metrics = (headline: number | null, extra: Partial<NonNullable<Column['metrics']>> = {}) => ({
  headline_label: 'NDCG@5',
  headline,
  delta: null,
  verdict: null,
  relevant_in_top_k: 2,
  relevant_change: null,
  rated_in_top_k: 5,
  provisional: false,
  range: [headline, headline] as [number | null, number | null],
  same_as_baseline: null,
  details: { ndcg: headline, precision: 0.6, success: null, rbo: null, overlap: null, gain: 'linear', pool_size: 6 },
  ...extra,
});

export const session: Session = {
  id: 1,
  query: 'triton atmosphere',
  information_need: "Measurements of Triton's surface pressure",
  goal: null,
  discipline: 'planetary',
  intent: 'topical',
  rating_mode: 'graded',
  rubric_version: 'draft-2026-11-04',
  k: 5,
  counts: { pool: 7, rated: 6, skipped: 1, unrated: 0 },
  columns: [
    {
      id: 1, is_baseline: true, environment: 'prod', environment_label: 'Production', params: {}, changes: [], warnings: [],
      status: 'ok', error: null, num_found: 1127,
      results: [row(1, 'A', 3), row(2, 'B', 0), row(3, 'C', 2), row(4, 'D', 1), row(5, 'E', 'skip')],
      dropped: [], metrics: metrics(0.659),
    },
    {
      id: 2, is_baseline: false, environment: 'prod', environment_label: 'Production', params: { qf: 'title^2' },
      changes: ['title 0.8 → 2'], warnings: [], status: 'ok', error: null, num_found: 1144,
      results: [row(1, 'C', 2, 2), row(2, 'A', 3, -1), row(3, 'F', 3, 'new'), row(4, 'D', 1, 0), row(5, 'G', 0, 'new')],
      dropped: [{ bibcode: 'B', title: 'Title of B', was: 2, grade: 0 }],
      metrics: metrics(0.879, { delta: 0.22, verdict: 'better', relevant_change: 1, same_as_baseline: 3 }),
    },
  ],
};

export const config: AppConfig = {
  environments: [{ name: 'prod', label: 'Production' }, { name: 'dev', label: 'Development' }],
  baseline_environment: 'prod',
  default_variant_environment: 'prod',
  disciplines: [{ value: 'general', label: 'No preferred discipline' }],
  intents: [{ value: 'topical', label: 'Topic' }],
  production_weights: [{ field: 'abstract', weight: 0.7 }, { field: 'title', weight: 0.8 }],
  qf_fields: ['abstract', 'title', 'keyword'],
  score_k: 5,
  rubric: {
    graded: [
      { value: '3', label: 'Highly relevant', definition: 'Directly answers the need.' },
      { value: '2', label: 'Relevant' },
      { value: '1', label: 'Somewhat relevant' },
      { value: '0', label: 'Not relevant' },
      { value: 'skip', label: "Can't judge" },
    ],
    binary: [],
  },
};
