import { CloseIcon } from '@chakra-ui/icons';
import {
  Alert,
  AlertDescription,
  AlertIcon,
  Badge,
  Box,
  Button,
  ButtonGroup,
  Checkbox,
  Flex,
  FormControl,
  FormHelperText,
  FormLabel,
  Grid,
  Heading,
  HStack,
  IconButton,
  Input,
  Link,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalHeader,
  ModalOverlay,
  Stack,
  Switch,
  Tag,
  Text,
  Textarea,
  useToast,
  Wrap,
} from '@chakra-ui/react';
import {
  closestCorners,
  DndContext,
  DragEndEvent,
  DragOverEvent,
  DragOverlay,
  DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { api, Board, BoardRecord, Column, Grade, ResultRow, Session } from '../api';
import { fmt } from '../format';
import { useRater, useStoredValue } from '../prefs';
import { GradeChip } from './GradeChip';
import { MoveTag } from './MoveTag';

// Compare, rate and rank on one screen. The wide pane holds each engine's
// results in that engine's order; the narrow column beside it stacks the
// rating groups, which are the rater's ideal ranking. A record is rated by a
// grade button, a key press or a drop into a group, and joins the end of that
// group. Each record is read once: a record an earlier column already showed
// collapses to one line, and a rated card shrinks to one line in place.

const UNRATED = 'unrated';
const SKIP = 'skip';
const groupKey = (grade: number) => `g${grade}`;
type Columns = Record<string, string[]>;
type Bucket = { key: string; grade?: number; label: string; definition: string; scheme: string; keyHint: string };

const SCHEME: Record<number, string> = { 3: 'green', 2: 'teal', 1: 'yellow', 0: 'red' };

function columnsFrom(board: Board): Columns {
  const columns: Columns = { [UNRATED]: board.unsorted.map((r) => r.bibcode), [SKIP]: board.skipped.map((r) => r.bibcode) };
  board.groups.forEach((g) => (columns[groupKey(g.grade)] = g.records.map((r) => r.bibcode)));
  return columns;
}

interface Props {
  session: Session;
  board: Board;
  tweak: Column | undefined;
}

export function RatingBoard({ session, board, tweak }: Props) {
  const [rater] = useRater();
  return (
    <Stack spacing={3}>
      {!session.information_need ? <NeedForm session={session} /> : !rater && <RaterForm />}
      <BoardInner session={session} board={board} tweak={tweak} rater={rater} canRate={!!session.information_need && !!rater} />
    </Stack>
  );
}

function BoardInner({ session, board, tweak, rater, canRate }: Props & { rater: string | null; canRate: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [columns, setColumns] = useState<Columns>(() => columnsFrom(board));
  const [ordered, setOrdered] = useState<Set<number>>(() => new Set(board.groups.filter((g) => g.ordered).map((g) => g.grade)));
  const [notes, setNotes] = useState<Record<string, string>>(() =>
    Object.fromEntries(board.skipped.map((r) => [r.bibcode, r.note ?? ''])),
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const dragFrom = useRef<string | null>(null);
  const [focus, setFocus] = useState(0);
  const [abstracts, setAbstracts] = useStoredValue('search-eval:abstracts', 'none');
  const [keysOn, setKeysOn] = useStoredValue('search-eval:keys', 'on');

  // A new tweak brings new records: take the server's board as the new start.
  useEffect(() => setColumns(columnsFrom(board)), [board]);

  const k = session.k;
  const baseline = session.columns[0];

  // Everything known about each record, from the board (with abstracts) and
  // from every run's results (deeper ranks have no abstract).
  const records = useMemo(() => {
    const all: Record<string, BoardRecord> = {};
    session.columns.forEach((c) =>
      c.results.forEach((r) => (all[r.bibcode] = { bibcode: r.bibcode, title: r.title, authors: r.authors, year: r.year, pub: r.pub, abstract: null })),
    );
    [...board.unsorted, ...board.skipped, ...board.groups.flatMap((g) => g.records)].forEach((r) => (all[r.bibcode] = r));
    return all;
  }, [session, board]);

  const buckets: Bucket[] = [
    ...board.groups.map((g) => ({
      key: groupKey(g.grade),
      grade: g.grade,
      label: g.label,
      definition: g.definition,
      scheme: SCHEME[g.grade] ?? 'gray',
      keyHint: board.rating_mode === 'binary' ? (g.grade === 3 ? 'u' : 'd') : String(g.grade),
    })),
    { key: SKIP, label: board.skip.label, definition: board.skip.definition, scheme: 'gray', keyHint: 's' },
  ];

  const containerOf = (id: string) =>
    id in columns ? id : Object.keys(columns).find((key) => columns[key].includes(id));

  // The grade a row shows: the local board first, so it changes the moment a
  // record is dropped, then what the server last returned.
  const gradeOf = (row: ResultRow): Grade => {
    const key = containerOf(row.bibcode);
    if (key === SKIP) return 'skip';
    const bucket = buckets.find((b) => b.key === key);
    if (bucket?.grade !== undefined) return bucket.grade as Grade;
    if (key === UNRATED) return null;
    return row.grade;
  };

  // Saves go out one at a time, in order, each carrying the whole board.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const save = useMutation(
    (next: { columns: Columns; ordered: Set<number>; notes: Record<string, string> }) => {
      const body = {
        rater: rater ?? '',
        groups: board.groups.map((g) => ({
          grade: g.grade,
          ordered: next.ordered.has(g.grade),
          bibcodes: next.columns[groupKey(g.grade)],
        })),
        skipped: next.columns[SKIP].map((b) => ({ bibcode: b, note: next.notes[b]?.trim() || null })),
      };
      const run = queue.current.catch(() => undefined).then(() => api.saveBoard(session.id, body));
      queue.current = run;
      return run;
    },
    {
      onSuccess: ({ session: next }) => queryClient.setQueryData(['session', session.id], next),
      onError: (error: Error) => {
        if (!toast.isActive('board-error')) {
          toast({ id: 'board-error', status: 'error', title: 'Not saved', description: error.message });
        }
        queryClient.invalidateQueries(['board', session.id]);
      },
    },
  );

  const commit = (nextColumns: Columns, nextOrdered = ordered, nextNotes = notes) => {
    setColumns(nextColumns);
    setOrdered(nextOrdered);
    setNotes(nextNotes);
    if (canRate) save.mutate({ columns: nextColumns, ordered: nextOrdered, notes: nextNotes });
  };

  // Put records into a group (at `index`, or the end), taking them from
  // wherever they were. Several records keep their on-screen order.
  const place = (bibcodes: string[], target: string, index?: number) => {
    if (!canRate) {
      toast({ id: 'need-first', status: 'info', title: 'Fill in the need and your name above first' });
      return;
    }
    const moving = new Set(bibcodes);
    const next: Columns = {};
    Object.entries(columns).forEach(([key, list]) => (next[key] = list.filter((b) => !moving.has(b))));
    const list = next[target];
    const at = index === undefined || index < 0 ? list.length : Math.min(index, list.length);
    next[target] = [...list.slice(0, at), ...bibcodes, ...list.slice(at)];
    setSelected(new Set());
    commit(next);
  };
  const withSelection = (bibcode: string) => (selected.has(bibcode) ? [...selected] : [bibcode]);

  const reorderWithin = (container: string, bibcode: string, step: number) => {
    const list = columns[container];
    const i = list.indexOf(bibcode);
    const j = i + step;
    if (j < 0 || j >= list.length) return;
    const grade = buckets.find((b) => b.key === container)?.grade;
    const nextOrdered = new Set(ordered);
    if (grade !== undefined) nextOrdered.add(grade);
    commit({ ...columns, [container]: arrayMove(list, i, j) }, nextOrdered);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const bibcodeOf = (id: string | number, data?: Record<string, unknown>) => String(data?.bibcode ?? id);

  const onDragStart = ({ active }: DragStartEvent) => {
    const bibcode = bibcodeOf(active.id, active.data.current);
    setActiveId(bibcode);
    dragFrom.current = active.data.current?.fromList ? 'list' : containerOf(bibcode) ?? null;
  };

  // Moving a group card across groups happens while dragging, so the list
  // opens a gap. Cards dragged from a result list are placed on drop.
  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over || active.data.current?.fromList) return;
    const from = containerOf(String(active.id));
    const to = containerOf(String(over.id));
    if (!from || !to || from === to || to === UNRATED) return;
    setColumns((current) => {
      const target = current[to];
      const overIndex = target.indexOf(String(over.id));
      const index = overIndex < 0 ? target.length : overIndex;
      return {
        ...current,
        [from]: current[from].filter((b) => b !== active.id),
        [to]: [...target.slice(0, index), String(active.id), ...target.slice(index)],
      };
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null);
    if (!over) return;
    if (active.data.current?.fromList) {
      const bibcode = bibcodeOf(active.id, active.data.current);
      const target = containerOf(String(over.id));
      if (!target || target === UNRATED) return;
      place(withSelection(bibcode), target, columns[target].indexOf(String(over.id)));
      return;
    }
    const container = containerOf(String(active.id));
    if (!container) return;
    let next = columns;
    const list = columns[container];
    const oldIndex = list.indexOf(String(active.id));
    const newIndex = list.indexOf(String(over.id));
    if (newIndex >= 0 && oldIndex !== newIndex) next = { ...columns, [container]: arrayMove(list, oldIndex, newIndex) };
    const nextOrdered = new Set(ordered);
    const grade = buckets.find((b) => b.key === container)?.grade;
    // A move that started and ended in the same group is the rater ordering it.
    if (grade !== undefined && dragFrom.current === container && next !== columns) nextOrdered.add(grade);
    commit(next, nextOrdered);
  };

  // Each engine's list, in screen order. A record's first appearance (in the
  // top k) is where it is read and rated; later appearances point back to it.
  const lists = [
    { title: 'Production', column: baseline },
    ...(tweak ? [{ title: 'Tweak', column: tweak }] : []),
  ];
  const firstSeen = new Map<string, string>();
  lists.forEach(({ title, column }) => {
    if (column.status !== 'ok') return;
    column.results.slice(0, k).forEach((r) => {
      if (!firstSeen.has(r.bibcode)) firstSeen.set(r.bibcode, `${title} #${r.rank}`);
    });
  });
  const isFirst = (title: string, row: ResultRow) => firstSeen.get(row.bibcode) === `${title} #${row.rank}`;
  // What the keyboard walks through: every record once, in screen order.
  const focusList = [...firstSeen.keys()];
  const focused = focusList[Math.min(focus, focusList.length - 1)];

  useEffect(() => {
    if (keysOn !== 'on') return;
    const handler = (e: KeyboardEvent) => {
      const typing = e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable], [role="dialog"]');
      if (e.metaKey || e.ctrlKey || e.altKey || typing) return;
      if (e.key === 'j') setFocus((f) => Math.min(f + 1, focusList.length - 1));
      else if (e.key === 'k') setFocus((f) => Math.max(f - 1, 0));
      else if (focused && e.key === 'x') toggleSelected(focused);
      else {
        const bucket = buckets.find((b) => b.keyHint === e.key);
        if (!bucket || !focused) return;
        place([focused], bucket.key);
        setFocus((f) => Math.min(f + 1, focusList.length - 1));
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const toggleSelected = (bibcode: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(bibcode)) next.delete(bibcode);
      else next.add(bibcode);
      return next;
    });

  const ratedShown = focusList.filter((b) => {
    const key = containerOf(b);
    return key && key !== UNRATED;
  }).length;

  const listCard = (row: ResultRow, column: Column) => (
    <ListCard
      key={`${column.id}-${row.bibcode}`}
      columnId={column.id}
      row={row}
      record={records[row.bibcode]}
      grade={gradeOf(row)}
      mode={session.rating_mode}
      buckets={buckets}
      showMove={!column.is_baseline}
      showAbstract={abstracts === 'all'}
      isFocused={keysOn === 'on' && row.bibcode === focused}
      onFocus={() => setFocus(Math.max(focusList.indexOf(row.bibcode), 0))}
      isSelected={selected.has(row.bibcode)}
      onToggle={() => toggleSelected(row.bibcode)}
      onRate={(key) => place(withSelection(row.bibcode), key)}
      canDrag={canRate}
    />
  );
  const listRow = (title: string, column: Column, row: ResultRow) =>
    firstSeen.has(row.bibcode) && !isFirst(title, row) ? (
      <SharedRow
        key={`${column.id}-${row.bibcode}`}
        row={row}
        seenAt={firstSeen.get(row.bibcode)!}
        grade={gradeOf(row)}
        mode={session.rating_mode}
        showMove={!column.is_baseline}
      />
    ) : (
      listCard(row, column)
    );

  const bucketCard = (bucket: Bucket, b: string, i: number, compact: boolean) => (
    <GroupCard
      key={b}
      record={records[b]}
      compact={compact}
      showAbstract={abstracts === 'all'}
      isSelected={selected.has(b)}
      onToggle={() => toggleSelected(b)}
      position={bucket.grade !== undefined ? i + 1 : undefined}
      onReorder={bucket.grade !== undefined ? (step) => reorderWithin(bucket.key, b, step) : undefined}
      onUnrate={() => place([b], UNRATED)}
      note={bucket.key === SKIP ? notes[b] ?? '' : undefined}
      onNote={bucket.key === SKIP ? (note) => commit(columns, ordered, { ...notes, [b]: note }) : undefined}
    />
  );
  const expandedBucket = buckets.find((b) => b.key === expanded);
  const selectionBar = (
    <SelectionBar
      count={selected.size}
      buckets={buckets}
      onMove={(key) => place([...selected], key)}
      onClear={() => setSelected(new Set())}
    />
  );

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}>
      <Stack spacing={3}>
        <Flex align="center" gap={4} wrap="wrap">
          <Text fontWeight="semibold" aria-live="polite">
            {ratedShown} of {focusList.length} rated
          </Text>
          <Text fontSize="sm" color="gray.600" flex="1" minW="16rem">
            Rate each record with its buttons, or drag it into a group on the right. The groups are your ideal ranking: higher in a group means better.
            {keysOn === 'on' && ` Keys: ${buckets.map((b) => b.keyHint).join('/')} rate the highlighted record, x ticks it, j/k move.`}
          </Text>
          <HStack spacing={4}>
            <HStack>
              <Switch id="abstracts" isChecked={abstracts === 'all'} onChange={(e) => setAbstracts(e.target.checked ? 'all' : 'none')} />
              <Text as="label" htmlFor="abstracts" fontSize="sm">
                All abstracts
              </Text>
            </HStack>
            <HStack>
              <Switch id="keys" isChecked={keysOn === 'on'} onChange={(e) => setKeysOn(e.target.checked ? 'on' : 'off')} />
              <Text as="label" htmlFor="keys" fontSize="sm">
                Keys
              </Text>
            </HStack>
          </HStack>
        </Flex>
        {selected.size > 0 && !expanded && selectionBar}
        <Grid templateColumns={{ base: '1fr', lg: 'minmax(0, 2.4fr) minmax(280px, 1fr)' }} gap={4} alignItems="start">
          <Box as="section" aria-label="Results to rate" border="1px" borderColor="gray.100" borderRadius="md" p={3} minW={0}>
            <HStack justify="space-between" mb={2}>
              <Heading as="h2" size="sm">
                Results to rate
              </Heading>
              <Text fontSize="sm" color="gray.600">
                {focusList.length - ratedShown} left
              </Text>
            </HStack>
            <Grid templateColumns={{ base: '1fr', md: `repeat(${lists.length}, minmax(0, 1fr))` }} gap={4} alignItems="start">
              {lists.map(({ title, column }) => (
                <ListColumn key={column.id} title={title} column={column} k={k}>
                  {(rows) => rows.map((row) => listRow(title, column, row))}
                </ListColumn>
              ))}
            </Grid>
          </Box>
          <Stack spacing={3} position={{ lg: 'sticky' }} top={{ lg: 2 }} maxH={{ lg: 'calc(100vh - 1rem)' }} overflowY={{ lg: 'auto' }}>
            <Heading as="h2" size="sm">
              Your ranking
            </Heading>
            {buckets.map((bucket) => (
              <GroupColumn
                key={bucket.key}
                bucket={bucket}
                count={columns[bucket.key].length}
                keyHint={keysOn === 'on' ? bucket.keyHint : undefined}
                ordered={bucket.grade !== undefined && columns[bucket.key].length > 1 ? ordered.has(bucket.grade) : undefined}
                isExpanded={expanded === bucket.key}
                onExpand={() => setExpanded(bucket.key)}
                items={expanded === bucket.key ? [] : columns[bucket.key]}
              >
                {expanded === bucket.key ? null : columns[bucket.key].map((b, i) => bucketCard(bucket, b, i, true))}
              </GroupColumn>
            ))}
          </Stack>
        </Grid>
      </Stack>
      <Modal isOpen={!!expandedBucket} onClose={() => setExpanded(null)} size="3xl" scrollBehavior="inside">
        <ModalOverlay />
        <ModalContent>
          {expandedBucket && (
            <>
              <ModalHeader>
                {expandedBucket.label}{' '}
                <Text as="span" fontSize="md" color="gray.600" fontWeight="normal">
                  {columns[expandedBucket.key].length}
                </Text>
                <Text fontSize="sm" color="gray.600" fontWeight="normal">
                  {expandedBucket.definition}
                </Text>
              </ModalHeader>
              <ModalCloseButton />
              <ModalBody>
                {selected.size > 0 && selectionBar}
                <Text fontSize="sm" color="gray.600" mb={2}>
                  Drag to put the best first, or tick records to move them to another group.
                </Text>
                <SortableContext items={columns[expandedBucket.key]} strategy={verticalListSortingStrategy}>
                  <Stack spacing={2} pb={4}>
                    {columns[expandedBucket.key].map((b, i) => bucketCard(expandedBucket, b, i, false))}
                    {columns[expandedBucket.key].length === 0 && <Text color="gray.500">Nothing here yet.</Text>}
                  </Stack>
                </SortableContext>
              </ModalBody>
            </>
          )}
        </ModalContent>
      </Modal>
      <DragOverlay>
        {activeId && records[activeId] ? (
          <CardPreview record={records[activeId]} more={selected.has(activeId) ? selected.size - 1 : 0} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function ListColumn({
  title,
  column,
  k,
  children,
}: {
  title: string;
  column: Column;
  k: number;
  children: (rows: ResultRow[]) => ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? column.results : column.results.slice(0, k);
  return (
    <Box as="section" aria-label={title} minW={0}>
      <Stack spacing={1} mb={2}>
        <HStack justify="space-between" align="baseline">
          <Heading as="h2" size="sm">
            {title}
          </Heading>
          {column.metrics?.headline != null && (
            <Text fontSize="sm">
              {column.metrics.headline_label} <b>{fmt(column.metrics.headline)}</b>
            </Text>
          )}
        </HStack>
        {column.is_baseline ? (
          <Text fontSize="xs" color="gray.600">
            {column.environment_label} default
            {column.num_found !== null && ` · ${column.num_found.toLocaleString()} results`}
          </Text>
        ) : (
          <Wrap spacing={1}>
            {column.changes.map((c) => (
              <Tag key={c} size="sm" variant="subtle" colorScheme="blue">
                {c}
              </Tag>
            ))}
            {column.num_found !== null && (
              <Text fontSize="xs" color="gray.600" alignSelf="center">
                {column.num_found.toLocaleString()} results
              </Text>
            )}
          </Wrap>
        )}
        {column.warnings.map((w) => (
          <Alert key={w} status="warning" fontSize="xs" py={1} borderRadius="md">
            <AlertIcon boxSize={3} />
            {w}
          </Alert>
        ))}
      </Stack>
      {column.status === 'error' ? (
        <Alert status="error" borderRadius="md">
          <AlertIcon />
          <AlertDescription>{column.error}</AlertDescription>
        </Alert>
      ) : (
        <>
          <Stack spacing={1.5}>{children(rows)}</Stack>
          {column.results.length > k && (
            <Button size="xs" variant="link" onClick={() => setShowAll(!showAll)} mt={2}>
              {showAll ? `Show top ${k} only` : `Show all ${column.results.length}`}
            </Button>
          )}
          {column.dropped.length > 0 && (
            <Box mt={3}>
              <Text fontWeight="semibold" fontSize="sm" mb={1}>
                Dropped out of the top {k}
              </Text>
              <Stack as="ul" listStyleType="none" spacing={1} fontSize="sm">
                {column.dropped.map((d) => (
                  <HStack as="li" key={d.bibcode} spacing={2}>
                    <Text color="gray.600" minW="3.5rem">
                      was {d.was}
                    </Text>
                    <Text noOfLines={1} dangerouslySetInnerHTML={{ __html: d.title ?? d.bibcode }} />
                  </HStack>
                ))}
              </Stack>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}

// A result in an engine's list, in that engine's order. Rating it (button,
// key or drag) puts it in a group; it stays in place and shrinks to one line
// showing its grade, so what is left to read stands out. Clicking the line
// opens the card again.
function ListCard({
  columnId,
  row,
  record,
  grade,
  mode,
  buckets,
  showMove,
  showAbstract,
  isFocused,
  onFocus,
  isSelected,
  onToggle,
  onRate,
  canDrag,
}: {
  columnId: number;
  row: ResultRow;
  record: BoardRecord;
  grade: Grade;
  mode: Session['rating_mode'];
  buckets: Bucket[];
  showMove: boolean;
  showAbstract: boolean;
  isFocused: boolean;
  onFocus: () => void;
  isSelected: boolean;
  onToggle: () => void;
  onRate: (key: string) => void;
  canDrag: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `list-${columnId}-${row.bibcode}`,
    data: { bibcode: row.bibcode, fromList: true },
    disabled: !canDrag,
  });
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? showAbstract;
  useEffect(() => setOpen(null), [showAbstract]);
  const [reopened, setReopened] = useState(false);
  useEffect(() => setReopened(false), [grade]);
  const title = plainTitle(record);
  const current = grade === null ? null : grade === 'skip' ? SKIP : groupKey(grade);

  if (grade !== null && !reopened) {
    const scheme = buckets.find((b) => b.key === current)?.scheme ?? 'gray';
    return (
      <Flex
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        role="button"
        aria-label={`${row.rank}. ${title} (rated). Open the card again.`}
        onClick={() => {
          setReopened(true);
          onFocus();
        }}
        opacity={isDragging ? 0.5 : 1}
        align="center"
        gap={2}
        fontSize="sm"
        bg="gray.50"
        border="1px"
        borderColor={isFocused ? 'blue.500' : 'gray.100'}
        borderLeft="4px solid"
        borderLeftColor={`${scheme}.400`}
        borderRadius="md"
        px={2}
        py={1.5}
        cursor="pointer"
        _focusVisible={{ boxShadow: 'outline' }}
      >
        <Text fontWeight="bold" minW="1.75rem" textAlign="center">
          {row.rank}
        </Text>
        <GradeChip grade={grade} mode={mode} short />
        <Text noOfLines={1} flex="1" minW={0} color="gray.700" title={title} dangerouslySetInnerHTML={{ __html: record.title ?? row.bibcode }} />
        {showMove && <MoveTag move={row.move} />}
      </Flex>
    );
  }

  return (
    <Box
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onFocus}
      aria-label={`${row.rank}. ${title}. Drag into a group to rate it.`}
      opacity={isDragging ? 0.5 : 1}
      border="1px"
      borderColor={isFocused || isSelected ? 'blue.500' : 'gray.200'}
      boxShadow={isFocused ? '0 0 0 1px var(--chakra-colors-blue-500)' : 'sm'}
      bgColor={isSelected ? 'blue.50' : 'white'}
      borderRadius="md"
      p={2}
      cursor={canDrag ? 'grab' : 'default'}
      _focusVisible={{ boxShadow: 'outline' }}
    >
      <Flex gap={2} align="start">
        <Stack spacing={1} align="center" minW="1.75rem">
          <Text fontSize="sm" fontWeight="bold">
            {row.rank}
          </Text>
          <Checkbox
            isChecked={isSelected}
            onChange={onToggle}
            aria-label={`Select ${title}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </Stack>
        <Box minW={0} flex="1">
          <Flex gap={2} justify="space-between" align="start">
            <Link
              href={`https://scixplorer.org/abs/${encodeURIComponent(row.bibcode)}/abstract`}
              isExternal
              fontSize="sm"
              fontWeight="semibold"
              noOfLines={3}
              title={title}
              dangerouslySetInnerHTML={{ __html: record.title ?? row.bibcode }}
            />
            {showMove && <MoveTag move={row.move} />}
          </Flex>
          <Text fontSize="xs" color="gray.600" noOfLines={1}>
            {record.authors.shown[0]}
            {record.authors.total > 1 ? ' et al.' : ''}
            {record.year ? ` · ${record.year}` : ''}
            {record.pub ? ` · ${record.pub}` : ''}
          </Text>
          {expanded && record.abstract && (
            <Text mt={1} fontSize="xs" maxH="14rem" overflowY="auto" dangerouslySetInnerHTML={{ __html: record.abstract }} />
          )}
          <Flex mt={1} gap={2} align="center" wrap="wrap">
            {record.abstract && (
              <Button size="xs" variant="link" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
                {expanded ? 'Hide abstract' : 'Abstract'}
              </Button>
            )}
            {reopened && (
              <Button size="xs" variant="link" onClick={() => setReopened(false)}>
                Fold
              </Button>
            )}
            <ButtonGroup size="xs" spacing={1} ml="auto" onPointerDown={(e) => e.stopPropagation()}>
              {buckets.map((b) => (
                <Button
                  key={b.key}
                  minW="1.75rem"
                  colorScheme={b.scheme}
                  variant={current === b.key ? 'solid' : 'outline'}
                  aria-pressed={current === b.key}
                  aria-label={`${b.label}: ${title}`}
                  title={b.label}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRate(b.key);
                  }}
                >
                  {gradeButtonText(b, mode)}
                </Button>
              ))}
            </ButtonGroup>
          </Flex>
        </Box>
      </Flex>
    </Box>
  );
}

const gradeButtonText = (b: Bucket, mode: Session['rating_mode']) =>
  b.grade === undefined ? '?' : mode === 'binary' ? (b.grade > 0 ? '👍' : '👎') : String(b.grade);

// A record an earlier column already showed: read and rated there, so one line.
function SharedRow({
  row,
  seenAt,
  grade,
  mode,
  showMove,
}: {
  row: ResultRow;
  seenAt: string;
  grade: Grade;
  mode: Session['rating_mode'];
  showMove: boolean;
}) {
  return (
    <Flex align="center" gap={2} fontSize="sm" border="1px dashed" borderColor="gray.200" borderRadius="md" px={2} py={1.5}>
      <Text fontWeight="bold" minW="1.75rem" textAlign="center">
        {row.rank}
      </Text>
      <Text color="gray.600" flexShrink={0}>
        = {seenAt}
      </Text>
      <GradeChip grade={grade} mode={mode} short />
      <Text noOfLines={1} flex="1" minW={0} color="gray.600" dangerouslySetInnerHTML={{ __html: row.title ?? row.bibcode }} />
      {showMove && <MoveTag move={row.move} />}
    </Flex>
  );
}

function GroupColumn({
  bucket,
  count,
  keyHint,
  ordered,
  isExpanded,
  onExpand,
  items,
  children,
}: {
  bucket: Bucket;
  count: number;
  keyHint?: string;
  ordered?: boolean;
  isExpanded: boolean;
  onExpand: () => void;
  items: string[];
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: bucket.key });
  return (
    <Flex
      as="section"
      aria-label={bucket.label}
      direction="column"
      bg="gray.50"
      border="1px"
      borderColor={isOver ? 'blue.400' : 'gray.100'}
      borderTop="4px solid"
      borderTopColor={`${bucket.scheme}.400`}
      borderRadius="md"
    >
      <Box px={2} pt={2} pb={1}>
        <HStack spacing={2}>
          <Text fontWeight="bold">{bucket.label}</Text>
          <Text fontSize="sm" color="gray.600">
            {count}
          </Text>
          {ordered !== undefined && (
            <Badge variant={ordered ? 'subtle' : 'outline'} colorScheme={ordered ? 'blue' : 'gray'} textTransform="none">
              {ordered ? 'Your order' : 'Tied'}
            </Badge>
          )}
          <HStack ml="auto" spacing={1}>
            {keyHint && (
              <Badge variant="outline" colorScheme="gray" title={`Press ${keyHint}`} textTransform="none">
                {keyHint}
              </Badge>
            )}
            {count > 0 && (
              <Button size="xs" variant="ghost" onClick={onExpand} aria-label={`Expand ${bucket.label}`}>
                Expand
              </Button>
            )}
          </HStack>
        </HStack>
        <Text fontSize="xs" color="gray.600" noOfLines={2} title={bucket.definition}>
          {bucket.definition}
        </Text>
      </Box>
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <Stack ref={setNodeRef} spacing={1} p={2} minH="3.5rem" maxH="14rem" overflowY="auto" bg={isOver ? 'blue.50' : undefined}>
          {children}
          {isExpanded && (
            <Text fontSize="sm" color="gray.500" textAlign="center" py={2}>
              Open in a window
            </Text>
          )}
          {count === 0 && (
            <Flex
              minH="2.5rem"
              align="center"
              justify="center"
              border="2px dashed"
              borderColor={isOver ? 'blue.400' : 'gray.200'}
              borderRadius="md"
              color="gray.500"
              fontSize="sm"
            >
              Drop here
            </Flex>
          )}
        </Stack>
      </SortableContext>
    </Flex>
  );
}

function GroupCard({
  record,
  compact,
  showAbstract,
  isSelected,
  onToggle,
  position,
  onReorder,
  onUnrate,
  note,
  onNote,
}: {
  record: BoardRecord;
  compact: boolean;
  showAbstract: boolean;
  isSelected: boolean;
  onToggle: () => void;
  position?: number;
  onReorder?: (step: number) => void;
  onUnrate: () => void;
  note?: string;
  onNote?: (note: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: record.bibcode });
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = !compact && (open ?? showAbstract);
  const [draft, setDraft] = useState(note ?? '');
  const title = plainTitle(record);
  return (
    <Box
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (onReorder && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          onReorder(e.key === 'ArrowUp' ? -1 : 1);
          return;
        }
        listeners?.onKeyDown?.(e);
      }}
      aria-label={`${title}${position ? `, position ${position}` : ''}. Drag to reorder.`}
      opacity={isDragging ? 0.4 : 1}
      border="1px"
      borderColor={isSelected ? 'blue.500' : 'gray.200'}
      bgColor={isSelected ? 'blue.50' : 'white'}
      borderRadius="md"
      p={compact ? 1.5 : 2}
      cursor="grab"
      _focusVisible={{ boxShadow: 'outline' }}
    >
      <Flex gap={2} align="start">
        <Checkbox
          mt={0.5}
          isChecked={isSelected}
          onChange={onToggle}
          aria-label={`Select ${title}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        />
        {position !== undefined && (
          <Text fontSize="sm" fontWeight="bold" color="gray.600">
            {position}
          </Text>
        )}
        <Box minW={0} flex="1">
          <Text fontSize="sm" fontWeight="semibold" color="blue.500" noOfLines={compact ? 2 : 3} title={title} dangerouslySetInnerHTML={{ __html: record.title ?? record.bibcode }} />
          {!compact && (
            <Text fontSize="xs" color="gray.600" noOfLines={1}>
              {record.authors.shown[0]}
              {record.authors.total > 1 ? ' et al.' : ''}
              {record.year ? ` · ${record.year}` : ''}
              {record.pub ? ` · ${record.pub}` : ''}
            </Text>
          )}
          {expanded && record.abstract && (
            <Text mt={1} fontSize="xs" maxH="14rem" overflowY="auto" dangerouslySetInnerHTML={{ __html: record.abstract }} />
          )}
          {!compact && record.abstract && (
            <Button size="xs" variant="link" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
              {expanded ? 'Hide abstract' : 'Abstract'}
            </Button>
          )}
        </Box>
        <IconButton aria-label={`Unrate ${title}`} title="Unrate" icon={<CloseIcon boxSize={2} />} size="xs" variant="ghost" onClick={onUnrate} />
      </Flex>
      {onNote && (
        <Input
          size="xs"
          mt={1}
          placeholder="Why can't you judge it?"
          aria-label={`Why you can't judge ${title}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => draft !== (note ?? '') && onNote(draft)}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        />
      )}
    </Box>
  );
}

function SelectionBar({ count, buckets, onMove, onClear }: { count: number; buckets: Bucket[]; onMove: (key: string) => void; onClear: () => void }) {
  return (
    <Flex
      align="center"
      gap={3}
      wrap="wrap"
      bg="blue.50"
      border="1px"
      borderColor="blue.200"
      borderRadius="md"
      px={3}
      py={2}
      mb={2}
      position="sticky"
      top={0}
      zIndex={2}
      role="region"
      aria-label="Selected records"
    >
      <Text fontWeight="semibold">{count} selected</Text>
      <Text fontSize="sm">Rate as:</Text>
      <ButtonGroup size="sm" spacing={1} flexWrap="wrap">
        {buckets.map((b) => (
          <Button key={b.key} colorScheme={b.scheme} variant="outline" bg="white" onClick={() => onMove(b.key)}>
            {b.label}
          </Button>
        ))}
        <Button variant="outline" bg="white" onClick={() => onMove(UNRATED)}>
          Unrated
        </Button>
      </ButtonGroup>
      <Button size="sm" variant="link" ml="auto" onClick={onClear}>
        Clear
      </Button>
    </Flex>
  );
}

function CardPreview({ record, more }: { record: BoardRecord; more: number }) {
  return (
    <Box bg="white" border="1px" borderColor="blue.400" borderRadius="md" p={2} boxShadow="lg" maxW="18rem" cursor="grabbing" position="relative">
      {more > 0 && (
        <Badge position="absolute" top={-2} right={-2} colorScheme="blue" variant="solid" borderRadius="full">
          +{more}
        </Badge>
      )}
      <Text fontSize="sm" fontWeight="semibold" color="blue.500" noOfLines={3} dangerouslySetInnerHTML={{ __html: record.title ?? record.bibcode }} />
    </Box>
  );
}

const plainTitle = (record: BoardRecord) => (record.title ?? record.bibcode).replace(/<[^>]+>/g, '');

function NeedForm({ session }: { session: Session }) {
  const queryClient = useQueryClient();
  const [need, setNeed] = useState('');
  const save = useMutation(() => api.updateSession(session.id, { information_need: need }), {
    onSuccess: (next) => queryClient.setQueryData(['session', session.id], next),
  });
  return (
    <Box
      as="form"
      border="1px"
      borderColor="blue.200"
      bg="blue.50"
      borderRadius="md"
      p={3}
      onSubmit={(e: React.FormEvent) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <FormControl isRequired>
        <FormLabel htmlFor="need">To rate, first say what you were looking for with “{session.query}”</FormLabel>
        <HStack align="start">
          <Textarea id="need" value={need} onChange={(e) => setNeed(e.target.value)} rows={2} bg="white" />
          <Button type="submit" isDisabled={!need.trim()} isLoading={save.isLoading}>
            Save
          </Button>
        </HStack>
        <FormHelperText>Ratings mean “relevant to this need”, and it is stored with every rating.</FormHelperText>
      </FormControl>
      {save.error instanceof Error && (
        <Alert status="error" mt={2}>
          <AlertIcon />
          {save.error.message}
        </Alert>
      )}
    </Box>
  );
}

function RaterForm() {
  const [, setRater] = useRater();
  const [name, setName] = useState('');
  return (
    <Box
      as="form"
      border="1px"
      borderColor="blue.200"
      bg="blue.50"
      borderRadius="md"
      p={3}
      onSubmit={(e: React.FormEvent) => {
        e.preventDefault();
        if (name.trim()) setRater(name.trim());
      }}
    >
      <FormControl isRequired>
        <FormLabel htmlFor="rater">Your name, stored with each rating</FormLabel>
        <HStack>
          <Input id="rater" value={name} onChange={(e) => setName(e.target.value)} bg="white" maxW="20rem" />
          <Button type="submit" isDisabled={!name.trim()}>
            Save
          </Button>
        </HStack>
      </FormControl>
    </Box>
  );
}
