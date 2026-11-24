import { screen } from '@testing-library/react';
import { renderWithProviders, session } from '../test-utils';
import { SummaryStrip } from './CompareView';

const tweak = session.columns[1];

test('the summary says whether the tweak is better, by how much and why', () => {
  renderWithProviders(<SummaryStrip session={session} tweak={tweak} />);
  expect(screen.getByText('Better')).toBeInTheDocument();
  expect(screen.getByText('0.659 → 0.879')).toBeInTheDocument();
  expect(screen.getByText(/\+1 relevant record in the top 5/)).toBeInTheDocument();
  expect(screen.getByText('3 of 5 same as production')).toBeInTheDocument();
});

test('while records are still unrated, the summary shows no numbers', () => {
  const partly = { ...session, counts: { ...session.counts, unrated: 2 } };
  renderWithProviders(<SummaryStrip session={partly} tweak={tweak} />);
  expect(screen.getByText(/2 records to rate/)).toBeInTheDocument();
  expect(screen.queryByText('Better')).toBeNull();
  expect(screen.queryByText(/0\.879/)).toBeNull();
});

