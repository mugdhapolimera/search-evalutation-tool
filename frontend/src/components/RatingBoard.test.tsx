import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Board, Session } from '../api';
import { renderWithProviders, session as base } from '../test-utils';
import { RatingBoard } from './RatingBoard';

const record = (b: string) => ({
  bibcode: b,
  title: `Title of ${b}`,
  authors: { shown: ['Author, A.'], total: 1 },
  year: '2024',
  pub: 'Icarus',
  abstract: `Abstract of ${b} with N<sub>2</sub>`,
});

// Production: A B C D E. Tweak: C A F D G. Only C is rated so far (2).
const session: Session = {
  ...base,
  columns: base.columns.map((c) => ({
    ...c,
    results: c.results.map((r) => ({ ...r, grade: r.bibcode === 'C' ? 2 : null })),
  })),
};
const tweak = session.columns[1];

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
  unsorted: ['A', 'B', 'D', 'E', 'F', 'G'].map(record),
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

const renderBoard = (s: Session = session) => renderWithProviders(<RatingBoard session={s} board={board} tweak={tweak} />);
const column = (name: string) => screen.getByRole('region', { name });

test('each engine keeps its own order, and a record shown earlier collapses to a pointer', () => {
  renderBoard();
  const tweakColumn = column('Tweak');
  expect(within(tweakColumn).getByText('= Production #1')).toBeInTheDocument(); // A
  expect(within(tweakColumn).getByText('= Production #3')).toBeInTheDocument(); // C
  expect(within(tweakColumn).getByText('= Production #4')).toBeInTheDocument(); // D
  // F and G are only in the tweak, so they are read there, as full cards.
  expect(within(tweakColumn).getByRole('button', { name: 'Highly relevant: Title of F' })).toBeInTheDocument();
  expect(screen.getByText('1 of 7 rated')).toBeInTheDocument();
});

test('a grade button rates and ranks: the record joins the end of that group and shrinks in place', async () => {
  renderBoard();
  await userEvent.click(within(column('Production')).getByRole('button', { name: 'Relevant: Title of A' }));
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
  const production = column('Production');
  expect(within(production).queryByRole('button', { name: 'Relevant: Title of A' })).toBeNull();
  expect(within(production).getByRole('button', { name: /Title of A \(rated\)/ })).toBeInTheDocument();
  expect(within(column('Relevant')).getByText('Title of A')).toBeInTheDocument();
});

test('a rated card opens again on click, showing its grade', async () => {
  renderBoard();
  await userEvent.click(within(column('Production')).getByRole('button', { name: /Title of C \(rated\)/ }));
  const pressed = within(column('Production')).getByRole('button', { name: 'Relevant: Title of C' });
  expect(pressed).toHaveAttribute('aria-pressed', 'true');
});

test('one key press rates the highlighted record and moves on', async () => {
  renderBoard();
  fireEvent.keyDown(window, { key: '3' });
  await waitFor(() => expect(lastPut()?.groups[0].bibcodes).toEqual(['A']));
  fireEvent.keyDown(window, { key: '0' });
  await waitFor(() => expect(lastPut()?.groups[3].bibcodes).toEqual(['B']));
});

test('ticked cards move together into one group', async () => {
  renderBoard();
  await userEvent.click(screen.getByLabelText('Select Title of A'));
  await userEvent.click(screen.getByLabelText('Select Title of F'));
  const bar = screen.getByRole('region', { name: 'Selected records' });
  expect(within(bar).getByText('2 selected')).toBeInTheDocument();
  await userEvent.click(within(bar).getByRole('button', { name: 'Highly relevant' }));
  await waitFor(() => expect(lastPut()?.groups[0].bibcodes).toEqual(['A', 'F']));
  expect(screen.queryByRole('region', { name: 'Selected records' })).toBeNull();
});

test('abstracts start closed; one switch opens or closes them all', async () => {
  renderBoard();
  expect(screen.queryAllByText(/Abstract of/)).toHaveLength(0);
  await userEvent.click(screen.getByLabelText('All abstracts'));
  expect(screen.getAllByText(/Abstract of/)).toHaveLength(6); // unrated cards; groups stay compact
  await userEvent.click(screen.getByLabelText('All abstracts'));
  expect(screen.queryAllByText(/Abstract of/)).toHaveLength(0);
});

test('every empty group says it takes drops', () => {
  renderBoard();
  expect(screen.getAllByText('Drop here')).toHaveLength(4);
});

test('a group expands into a window with full cards', async () => {
  renderBoard();
  await userEvent.click(screen.getByRole('button', { name: 'Expand Relevant' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('Title of C')).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Abstract' })).toBeInTheDocument();
});

test('the comparison shows the change, rank moves and what dropped out', () => {
  renderBoard();
  const tweakColumn = column('Tweak');
  expect(within(tweakColumn).getByText('title 0.8 → 2')).toBeInTheDocument();
  expect(within(tweakColumn).getByLabelText('up 2')).toBeInTheDocument();
  expect(within(tweakColumn).getByText('Dropped out of the top 5')).toBeInTheDocument();
});

test('rating asks for the information need first', () => {
  renderBoard({ ...session, information_need: null });
  expect(screen.getByLabelText(/what you were looking for/)).toBeInTheDocument();
});
