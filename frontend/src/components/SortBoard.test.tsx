import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Board } from '../api';
import { renderWithProviders, session } from '../test-utils';
import { SortBoard } from './SortBoard';

const record = (b: string) => ({
  bibcode: b,
  title: `Title of ${b}`,
  authors: { shown: ['Author, A.'], total: 1 },
  year: '2024',
  pub: 'Icarus',
  abstract: `Abstract of ${b} with N<sub>2</sub>`,
});

const board: Board = {
  information_need: session.information_need,
  rating_mode: 'graded',
  groups: [
    { grade: 3, label: 'Highly relevant', definition: 'Directly answers the need.', ordered: false, records: [] },
    { grade: 2, label: 'Relevant', definition: 'Partial.', ordered: false, records: [record('C')] },
    { grade: 1, label: 'Somewhat relevant', definition: 'On topic.', ordered: false, records: [] },
    { grade: 0, label: 'Not relevant', definition: 'Wrong topic.', ordered: false, records: [] },
  ],
  skip: { label: "Can't judge", definition: 'Outside your expertise.' },
  skipped: [],
  unsorted: [record('A'), record('B')],
};

const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;
const lastPut = () => {
  const puts = fetchMock().mock.calls.filter(([, init]) => init?.method === 'PUT');
  return puts.length ? JSON.parse(puts[puts.length - 1][1].body) : undefined;
};

beforeEach(() => {
  window.localStorage.setItem('search-eval:rater', 'Tester');
  window.localStorage.setItem('search-eval:keys', 'on');
  window.localStorage.setItem('search-eval:abstracts', 'none');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ session, board }) })));
});
afterEach(() => vi.unstubAllGlobals());

const renderBoard = () =>
  renderWithProviders(<SortBoard session={session} board={board} whenSorted={<p>comparison</p>} />);

test('one key press rates and ranks: the record joins the end of that group', async () => {
  renderBoard();
  fireEvent.keyDown(window, { key: '2' });
  await waitFor(() => expect(lastPut()).toBeDefined());
  expect(lastPut()).toEqual({
    rater: 'Tester',
    groups: [
      { grade: 3, ordered: false, bibcodes: [] },
      { grade: 2, ordered: false, bibcodes: ['C', 'A'] },
      { grade: 1, ordered: false, bibcodes: [] },
      { grade: 0, ordered: false, bibcodes: [] },
    ],
    skipped: [],
  });
  expect(within(screen.getByRole('region', { name: 'Relevant' })).getByText('Title of A')).toBeInTheDocument();
});

test('thumbs down sends a record to the bottom group', async () => {
  renderBoard();
  await userEvent.click(screen.getByRole('button', { name: 'Not relevant: Title of B' }));
  await waitFor(() => expect(lastPut()?.groups[3].bibcodes).toEqual(['B']));
});

test('abstracts start closed; one switch opens or closes them all', async () => {
  renderBoard();
  expect(screen.queryAllByText(/Abstract of/)).toHaveLength(0);
  await userEvent.click(screen.getByLabelText('All abstracts'));
  expect(screen.getAllByText(/Abstract of/)).toHaveLength(3);
  await userEvent.click(screen.getByLabelText('All abstracts'));
  expect(screen.queryAllByText(/Abstract of/)).toHaveLength(0);
});

test('ticked cards move together into one column', async () => {
  renderBoard();
  await userEvent.click(screen.getByLabelText('Select Title of A'));
  await userEvent.click(screen.getByLabelText('Select Title of B'));
  const bar = screen.getByRole('region', { name: 'Selected records' });
  expect(within(bar).getByText('2 selected')).toBeInTheDocument();
  await userEvent.click(within(bar).getByRole('button', { name: 'Highly relevant' }));
  await waitFor(() => expect(lastPut()?.groups[0].bibcodes).toEqual(['A', 'B']));
  expect(screen.queryByRole('region', { name: 'Selected records' })).toBeNull();
});

test('every empty column says it takes drops', () => {
  renderBoard();
  expect(screen.getAllByText('Drop here')).toHaveLength(4);
});

test('the to-sort list shows no rank, column or environment', () => {
  renderBoard();
  expect(screen.queryByText(/Production|Tweak|Baseline/)).toBeNull();
});

test('when nothing is left to sort, the comparison appears', () => {
  renderWithProviders(
    <SortBoard session={session} board={{ ...board, unsorted: [] }} whenSorted={<p>comparison</p>} />,
  );
  expect(screen.getByText('comparison')).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'To sort' })).getByText('All sorted')).toBeInTheDocument();
});

test('sorting asks for the information need first', () => {
  renderWithProviders(
    <SortBoard session={{ ...session, information_need: null }} board={board} whenSorted={null} />,
  );
  expect(screen.getByLabelText(/What were you looking for/)).toBeInTheDocument();
});
