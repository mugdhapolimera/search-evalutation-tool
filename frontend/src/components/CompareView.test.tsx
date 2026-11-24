import { screen, within } from '@testing-library/react';
import { renderWithProviders, session } from '../test-utils';
import { CompactComparison, SummaryStrip } from './CompareView';

const tweak = session.columns[1];

test('the summary says whether the tweak is better, by how much and why', () => {
  renderWithProviders(<SummaryStrip session={session} tweak={tweak} />);
  expect(screen.getByText('Better')).toBeInTheDocument();
  expect(screen.getByText('0.659 → 0.879')).toBeInTheDocument();
  expect(screen.getByText(/\+1 relevant record in the top 5/)).toBeInTheDocument();
  expect(screen.getByText('3 of 5 same as production')).toBeInTheDocument();
});

test('while records are still to sort, the summary shows no numbers', () => {
  const partly = { ...session, counts: { ...session.counts, unrated: 2 } };
  renderWithProviders(<SummaryStrip session={partly} tweak={tweak} />);
  expect(screen.getByText(/2 records to sort/)).toBeInTheDocument();
  expect(screen.queryByText('Better')).toBeNull();
  expect(screen.queryByText(/0\.879/)).toBeNull();
});

test('the comparison shows the change, rank moves and what dropped out', () => {
  renderWithProviders(<CompactComparison session={session} tweak={tweak} />);
  const column = screen.getByRole('region', { name: 'Tweak' });
  expect(within(column).getByText('title 0.8 → 2')).toBeInTheDocument();
  expect(within(column).getByLabelText('up 2')).toBeInTheDocument();
  expect(within(column).getAllByLabelText('new in the top results')).toHaveLength(2);
  expect(within(column).getByText('Dropped out of the top 5')).toBeInTheDocument();
  expect(within(column).getByText('was 2')).toBeInTheDocument();
});

test('grades are spelled out for assistive tech, never colour alone', () => {
  renderWithProviders(<CompactComparison session={session} tweak={tweak} />);
  const production = screen.getByRole('region', { name: 'Production' });
  expect(within(production).getAllByLabelText('3 · Highly relevant').length).toBeGreaterThan(0);
  expect(within(production).getByText("Can't judge")).toBeInTheDocument();
});
