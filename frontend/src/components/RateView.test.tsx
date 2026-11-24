import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Pool } from '../api';
import { config, renderWithProviders, session } from '../test-utils';
import { RateView } from './RateView';

const pool: Pool = {
  information_need: session.information_need,
  rating_mode: 'graded',
  options: config.rubric.graded,
  records: ['A', 'B'].map((b) => ({
    bibcode: b,
    title: `Title of ${b}`,
    authors: { shown: ['Author, A.'], total: 1 },
    year: '2024',
    pub: 'Icarus',
    doctype: 'article',
    abstract: 'N<sub>2</sub> ice',
    rating: null,
    note: null,
  })),
};

beforeEach(() => {
  window.localStorage.setItem('search-eval:rater', 'Tester');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (String(url).endsWith('/pool') ? pool : session),
    })),
  );
});

afterEach(() => vi.unstubAllGlobals());

test('a rating is saved the moment it is chosen, with the rater', async () => {
  renderWithProviders(<RateView session={session} onDone={() => {}} />);
  const buttons = await screen.findAllByRole('button', { name: '3 · Highly relevant' });
  await userEvent.click(buttons[0]);
  await waitFor(() => {
    const put = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(put).toBeDefined();
    expect(JSON.parse(put![1].body)).toEqual({ bibcode: 'A', rating: '3', rater: 'Tester' });
  });
  expect(screen.getByText('1 of 2 rated')).toBeInTheDocument();
  expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
});

test('the pool shows no rank, column or environment', async () => {
  renderWithProviders(<RateView session={session} onDone={() => {}} />);
  await screen.findByText('Title of A');
  expect(screen.queryByText(/Production|Tweak|Baseline/)).toBeNull();
});

test('rating asks for the information need first', () => {
  renderWithProviders(<RateView session={{ ...session, information_need: null }} onDone={() => {}} />);
  expect(screen.getByLabelText(/What were you looking for/)).toBeInTheDocument();
});
