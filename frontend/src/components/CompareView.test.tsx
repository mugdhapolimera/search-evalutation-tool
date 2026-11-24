import { screen, within } from '@testing-library/react';
import { renderWithProviders, session } from '../test-utils';
import { CompareView } from './CompareView';

test('the summary says whether the tweak is better, by how much and why', () => {
  renderWithProviders(<CompareView session={session} selectedId={2} onRate={() => {}} />);
  expect(screen.getByText('Better')).toBeInTheDocument();
  expect(screen.getByText('0.659 → 0.879')).toBeInTheDocument();
  expect(screen.getByText(/\+1 relevant record in the top 5/)).toBeInTheDocument();
  expect(screen.getByText('3 of 5 same as production')).toBeInTheDocument();
});

test('the tweak column shows its change, rank moves and what dropped out', () => {
  renderWithProviders(<CompareView session={session} selectedId={2} onRate={() => {}} />);
  const tweak = screen.getByRole('region', { name: 'Tweak' });
  expect(within(tweak).getByText('title 0.8 → 2')).toBeInTheDocument();
  expect(within(tweak).getByLabelText('up 2')).toBeInTheDocument();
  expect(within(tweak).getAllByLabelText('new in the top results')).toHaveLength(2);
  expect(within(tweak).getByText('Dropped out of the top 5')).toBeInTheDocument();
  expect(within(tweak).getByText('was 2')).toBeInTheDocument();
});

test('grades are spelled out, never colour alone', () => {
  renderWithProviders(<CompareView session={session} selectedId={2} onRate={() => {}} />);
  const production = screen.getByRole('region', { name: 'Production ranking' });
  expect(within(production).getAllByLabelText('3 · Highly relevant').length).toBeGreaterThan(0);
  expect(within(production).getByText("Can't judge")).toBeInTheDocument();
});

test('unrated records prompt for rating', () => {
  const onRate = vi.fn();
  const partly = { ...session, counts: { ...session.counts, unrated: 2 } };
  renderWithProviders(<CompareView session={partly} selectedId={2} onRate={onRate} />);
  screen.getByRole('button', { name: 'Rate them' }).click();
  expect(onRate).toHaveBeenCalled();
});
