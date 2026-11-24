import { CloseIcon, DragHandleIcon } from '@chakra-ui/icons';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
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
  Stack,
  Switch,
  Text,
  Textarea,
  useToast,
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
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { api, Board, BoardRecord, Session } from '../api';
import { plural } from '../format';
import { useRater, useStoredValue } from '../prefs';
import { useColorModeColors } from '../scix/useColorModeColors';
import { ResultItem } from './ResultItem';

// One task: sort each record once. Its group is its rating and its place in
// the group is its rank, so one move records both (4 Nov decision: rate and
// rank in one step). The comparison is inferred from the sorting, never asked
// for again.

const UNSORTED = 'unsorted';
const SKIP = 'skip';
const groupKey = (grade: number) => `g${grade}`;
type Columns = Record<string, string[]>;

const SCHEME: Record<number, string> = { 3: 'green', 2: 'teal', 1: 'yellow', 0: 'red' };

function columnsFrom(board: Board): Columns {
  const columns: Columns = { [UNSORTED]: board.unsorted.map((r) => r.bibcode), [SKIP]: board.skipped.map((r) => r.bibcode) };
  board.groups.forEach((g) => (columns[groupKey(g.grade)] = g.records.map((r) => r.bibcode)));
  return columns;
}

function recordsFrom(board: Board): Record<string, BoardRecord> {
  const all = [...board.unsorted, ...board.skipped, ...board.groups.flatMap((g) => g.records)];
  return Object.fromEntries(all.map((r) => [r.bibcode, r]));
}

interface Props {
  session: Session;
  board: Board;
  /** What fills the left pane once nothing is left to sort: the comparison. */
  whenSorted: ReactNode;
}

export function SortBoard({ session, board, whenSorted }: Props) {
  const [rater] = useRater();
  if (!session.information_need) return <NeedForm session={session} />;
  if (!rater) return <RaterForm />;
  return <BoardInner session={session} board={board} rater={rater} whenSorted={whenSorted} />;
}

function BoardInner({ session, board, rater, whenSorted }: Props & { rater: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [columns, setColumns] = useState<Columns>(() => columnsFrom(board));
  const [records, setRecords] = useState(() => recordsFrom(board));
  const [ordered, setOrdered] = useState<Set<number>>(() => new Set(board.groups.filter((g) => g.ordered).map((g) => g.grade)));
  const [notes, setNotes] = useState<Record<string, string>>(() =>
    Object.fromEntries(board.skipped.map((r) => [r.bibcode, r.note ?? ''])),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const dragFrom = useRef<string | null>(null);
  const [focus, setFocus] = useState(0);
  const [abstracts, setAbstracts] = useStoredValue('search-eval:abstracts', 'all');
  const [keysOn, setKeysOn] = useStoredValue('search-eval:keys', 'on');

  // A new tweak brings new records: take the server's board as the new start.
  useEffect(() => {
    setColumns(columnsFrom(board));
    setRecords(recordsFrom(board));
  }, [board]);

  // Saves go out one at a time, in order, each carrying the whole board.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const save = useMutation(
    (next: { columns: Columns; ordered: Set<number>; notes: Record<string, string> }) => {
      const body = {
        rater,
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

  const commit = useCallback(
    (nextColumns: Columns, nextOrdered = ordered, nextNotes = notes) => {
      setColumns(nextColumns);
      setOrdered(nextOrdered);
      setNotes(nextNotes);
      save.mutate({ columns: nextColumns, ordered: nextOrdered, notes: nextNotes });
    },
    [ordered, notes, save],
  );

  const containerOf = (id: string) =>
    id in columns ? id : Object.keys(columns).find((key) => columns[key].includes(id));

  const moveTo = useCallback(
    (bibcode: string, target: string) => {
      const from = Object.keys(columns).find((key) => columns[key].includes(bibcode));
      if (!from || from === target) return;
      commit({ ...columns, [from]: columns[from].filter((b) => b !== bibcode), [target]: [...columns[target], bibcode] });
    },
    [columns, commit],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragStart = ({ active }: DragStartEvent) => {
    setActiveId(String(active.id));
    dragFrom.current = containerOf(String(active.id)) ?? null;
  };

  // Moving across containers happens while dragging, so the list opens a gap.
  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return;
    const from = containerOf(String(active.id));
    const to = containerOf(String(over.id));
    if (!from || !to || from === to) return;
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
    const container = containerOf(String(active.id));
    if (!container) return;
    let next = columns;
    if (over) {
      const list = columns[container];
      const oldIndex = list.indexOf(String(active.id));
      const newIndex = list.indexOf(String(over.id));
      if (newIndex >= 0 && oldIndex !== newIndex) next = { ...columns, [container]: arrayMove(list, oldIndex, newIndex) };
    }
    const nextOrdered = new Set(ordered);
    const grade = board.groups.find((g) => groupKey(g.grade) === container)?.grade;
    // A move that started and ended in the same group is the rater ordering it.
    if (grade !== undefined && dragFrom.current === container && next !== columns) nextOrdered.add(grade);
    commit(next, nextOrdered);
  };

  const reorderWithin = (container: string, bibcode: string, step: number) => {
    const list = columns[container];
    const i = list.indexOf(bibcode);
    const j = i + step;
    if (j < 0 || j >= list.length) return;
    const grade = board.groups.find((g) => groupKey(g.grade) === container)?.grade;
    const nextOrdered = new Set(ordered);
    if (grade !== undefined) nextOrdered.add(grade);
    commit({ ...columns, [container]: arrayMove(list, i, j) }, nextOrdered);
  };

  const unsorted = columns[UNSORTED];
  const lowest = board.groups[board.groups.length - 1];

  // Keyboard: on the To-sort list, a number (or u/d for author searches) drops
  // the focused record into that group; s is Can't judge; j/k move.
  const keyFor = (grade: number) => (board.rating_mode === 'binary' ? (grade === 3 ? 'u' : 'd') : String(grade));
  useEffect(() => {
    if (keysOn !== 'on') return;
    const handler = (e: KeyboardEvent) => {
      const typing = e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]');
      if (e.metaKey || e.ctrlKey || e.altKey || typing) return;
      const bibcode = unsorted[Math.min(focus, unsorted.length - 1)];
      if (e.key === 'j') setFocus((f) => Math.min(f + 1, unsorted.length - 1));
      else if (e.key === 'k') setFocus((f) => Math.max(f - 1, 0));
      else if (bibcode && e.key === 's') moveTo(bibcode, SKIP);
      else {
        const group = board.groups.find((g) => keyFor(g.grade) === e.key);
        if (!group || !bibcode) return;
        moveTo(bibcode, groupKey(group.grade));
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const sortedCount = Object.entries(columns).reduce((n, [k, v]) => (k === UNSORTED ? n : n + v.length), 0);
  const total = sortedCount + unsorted.length;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}>
      <Grid templateColumns={{ base: '1fr', xl: 'minmax(0, 1.2fr) minmax(0, 1fr)' }} gap={5} alignItems="start">
        <Box as="section" aria-labelledby="left-heading" minW={0}>
          {unsorted.length > 0 ? (
            <>
              <Flex align="baseline" gap={3} wrap="wrap" mb={1}>
                <Heading as="h2" size="md" id="left-heading">
                  To sort
                </Heading>
                <Text fontSize="sm" color="gray.600" aria-live="polite">
                  {sortedCount} of {total} sorted
                </Text>
                <HStack ml="auto" spacing={4}>
                  <HStack>
                    <Switch id="abstracts" isChecked={abstracts === 'all'} onChange={(e) => setAbstracts(e.target.checked ? 'all' : 'none')} />
                    <Text as="label" htmlFor="abstracts" fontSize="sm">
                      Abstracts
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
              <Text fontSize="sm" color="gray.600" mb={3}>
                Drag each record into a group on the right; where you drop it in the group is its rank.
                {keysOn === 'on' &&
                  ` Or press ${board.groups.map((g) => `${keyFor(g.grade)} ${g.label.toLowerCase()}`).join(', ')}, s can't judge; j/k move.`}{' '}
                The comparison appears here once everything is sorted.
              </Text>
              <Droppable id={UNSORTED}>
                <SortableContext items={unsorted} strategy={verticalListSortingStrategy}>
                  <Stack spacing={0}>
                    {unsorted.map((bibcode, index) => (
                      <SortableCard
                        key={bibcode}
                        record={records[bibcode]}
                        showAbstract={abstracts === 'all'}
                        isFocused={keysOn === 'on' && index === Math.min(focus, unsorted.length - 1)}
                        onFocus={() => setFocus(index)}
                        quickLabel={lowest.label}
                        onQuick={() => moveTo(bibcode, groupKey(lowest.grade))}
                      />
                    ))}
                  </Stack>
                </SortableContext>
              </Droppable>
            </>
          ) : (
            <Box id="left-heading">{whenSorted}</Box>
          )}
        </Box>
        <Box as="section" aria-labelledby="ranking-heading" position={{ xl: 'sticky' }} top={{ xl: 2 }} maxH={{ xl: 'calc(100vh - 1rem)' }} overflowY={{ xl: 'auto' }} pr={{ xl: 1 }}>
          <Heading as="h2" size="md" id="ranking-heading" mb={1}>
            Your ranking
          </Heading>
          <Text fontSize="sm" color="gray.600" mb={3}>
            Best first. Drag within a group to order it, or into another group to change its rating. Alt+↑/↓ moves a focused
            record.
          </Text>
          <Stack spacing={3}>
            {board.groups.map((g) => (
              <Group
                key={g.grade}
                id={groupKey(g.grade)}
                label={g.label}
                definition={g.definition}
                scheme={SCHEME[g.grade] ?? 'gray'}
                ordered={ordered.has(g.grade)}
                bibcodes={columns[groupKey(g.grade)]}
                records={records}
                onReorder={(b, step) => reorderWithin(groupKey(g.grade), b, step)}
                onUnsort={(b) => moveTo(b, UNSORTED)}
              />
            ))}
            <Group
              id={SKIP}
              label={board.skip.label}
              definition={board.skip.definition}
              scheme="gray"
              bibcodes={columns[SKIP]}
              records={records}
              onReorder={() => {}}
              onUnsort={(b) => moveTo(b, UNSORTED)}
              notes={notes}
              onNote={(b, note) => commit(columns, ordered, { ...notes, [b]: note })}
            />
          </Stack>
        </Box>
      </Grid>
      <DragOverlay>{activeId && records[activeId] ? <RowPreview record={records[activeId]} /> : null}</DragOverlay>
    </DndContext>
  );
}

function Droppable({ id, children }: { id: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <Box ref={setNodeRef} minH="3rem" borderRadius="md" outline={isOver ? '2px dashed' : undefined} outlineColor="blue.300">
      {children}
    </Box>
  );
}

function SortableCard({
  record,
  showAbstract,
  isFocused,
  onFocus,
  quickLabel,
  onQuick,
}: {
  record: BoardRecord;
  showAbstract: boolean;
  isFocused: boolean;
  onFocus: () => void;
  quickLabel: string;
  onQuick: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: record.bibcode,
  });
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? showAbstract;
  useEffect(() => setOpen(null), [showAbstract]);
  const title = plainTitle(record);
  return (
    <Box ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} opacity={isDragging ? 0.4 : 1} onClick={onFocus}>
      <ResultItem
        bibcode={record.bibcode}
        title={record.title}
        authors={record.authors}
        year={record.year}
        pub={record.pub}
        isFocused={isFocused}
        gutter={
          <Box
            as="button"
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={`Drag ${title}`}
            cursor="grab"
            p={2}
            borderRadius="sm"
            _focusVisible={{ boxShadow: 'outline' }}
            lineHeight={0}
          >
            <DragHandleIcon color="gray.500" boxSize={4} />
          </Box>
        }
        aside={
          <Button size="xs" variant="outline" colorScheme="red" onClick={onQuick} aria-label={`${quickLabel}: ${title}`} title={quickLabel}>
            👎
          </Button>
        }
      >
        {record.abstract && (
          <Box mt={1} fontSize="sm">
            {expanded && <Text mb={1} dangerouslySetInnerHTML={{ __html: record.abstract }} />}
            <Button size="xs" variant="link" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
              {expanded ? 'Hide abstract' : 'Show abstract'}
            </Button>
          </Box>
        )}
      </ResultItem>
    </Box>
  );
}

function Group({
  id,
  label,
  definition,
  scheme,
  ordered,
  bibcodes,
  records,
  onReorder,
  onUnsort,
  notes,
  onNote,
}: {
  id: string;
  label: string;
  definition: string;
  scheme: string;
  ordered?: boolean;
  bibcodes: string[];
  records: Record<string, BoardRecord>;
  onReorder: (bibcode: string, step: number) => void;
  onUnsort: (bibcode: string) => void;
  notes?: Record<string, string>;
  onNote?: (bibcode: string, note: string) => void;
}) {
  const colors = useColorModeColors();
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <Box
      ref={setNodeRef}
      border="1px"
      borderColor={isOver ? 'blue.400' : colors.border}
      borderLeftWidth="4px"
      borderLeftColor={`${scheme}.400`}
      borderRadius="md"
      p={2}
      bg={isOver ? 'blue.50' : 'white'}
    >
      <HStack spacing={2} align="baseline">
        <Text fontWeight="bold">{label}</Text>
        <Text fontSize="sm" color="gray.600">
          {bibcodes.length}
        </Text>
        {ordered !== undefined && bibcodes.length > 1 && (
          <Badge variant={ordered ? 'subtle' : 'outline'} colorScheme={ordered ? 'blue' : 'gray'} textTransform="none" ml="auto">
            {ordered ? 'Your order' : 'Tied'}
          </Badge>
        )}
      </HStack>
      <Text fontSize="xs" color="gray.600" mb={bibcodes.length ? 2 : 0}>
        {definition}
      </Text>
      <SortableContext items={bibcodes} strategy={verticalListSortingStrategy}>
        <Stack as="ol" spacing={1} listStyleType="none" minH="1.5rem">
          {bibcodes.map((b, i) => (
            <SortableRow
              key={b}
              record={records[b]}
              position={i + 1}
              onReorder={(step) => onReorder(b, step)}
              onUnsort={() => onUnsort(b)}
              note={notes?.[b]}
              onNote={onNote ? (n) => onNote(b, n) : undefined}
            />
          ))}
        </Stack>
      </SortableContext>
    </Box>
  );
}

function SortableRow({
  record,
  position,
  onReorder,
  onUnsort,
  note,
  onNote,
}: {
  record: BoardRecord;
  position: number;
  onReorder: (step: number) => void;
  onUnsort: () => void;
  note?: string;
  onNote?: (note: string) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: record.bibcode,
  });
  const [draft, setDraft] = useState(note ?? '');
  const title = plainTitle(record);
  return (
    <Box
      as="li"
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      opacity={isDragging ? 0.4 : 1}
      bg="gray.50"
      borderRadius="sm"
      px={1}
      py={1}
    >
      <Flex align="center" gap={2}>
        <Box
          as="button"
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          onKeyDown={(e: React.KeyboardEvent) => {
            if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
              e.preventDefault();
              onReorder(e.key === 'ArrowUp' ? -1 : 1);
              return;
            }
            listeners?.onKeyDown?.(e);
          }}
          aria-label={`Move ${title}, position ${position}`}
          cursor="grab"
          p={1}
          borderRadius="sm"
          _focusVisible={{ boxShadow: 'outline' }}
          lineHeight={0}
        >
          <DragHandleIcon color="gray.500" />
        </Box>
        <Text fontSize="sm" color="gray.600" minW="1.25rem">
          {position}
        </Text>
        <Link
          href={`https://scixplorer.org/abs/${encodeURIComponent(record.bibcode)}/abstract`}
          isExternal
          fontSize="sm"
          fontWeight="semibold"
          noOfLines={1}
          flex="1"
          minW={0}
          title={title}
          dangerouslySetInnerHTML={{ __html: record.title ?? record.bibcode }}
        />
        <Text fontSize="xs" color="gray.600" flexShrink={0}>
          {record.year}
        </Text>
        <IconButton
          aria-label={`Back to To sort: ${title}`}
          title="Back to To sort"
          icon={<CloseIcon boxSize={2} />}
          size="xs"
          variant="ghost"
          onClick={onUnsort}
        />
      </Flex>
      {onNote && (
        <Input
          size="xs"
          mt={1}
          bg="white"
          placeholder="Why can't you judge it?"
          aria-label={`Why you can't judge ${title}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => draft !== (note ?? '') && onNote(draft)}
        />
      )}
    </Box>
  );
}

function RowPreview({ record }: { record: BoardRecord }) {
  return (
    <Flex align="center" gap={2} bg="white" border="1px" borderColor="blue.400" borderRadius="sm" px={2} py={1} boxShadow="md" maxW="32rem">
      <DragHandleIcon color="gray.500" />
      <Text fontSize="sm" fontWeight="semibold" color="blue.500" noOfLines={1} dangerouslySetInnerHTML={{ __html: record.title ?? record.bibcode }} />
    </Flex>
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
      maxW="40rem"
      onSubmit={(e: React.FormEvent) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <FormControl isRequired>
        <FormLabel htmlFor="need">What were you looking for with “{session.query}”?</FormLabel>
        <Textarea id="need" value={need} onChange={(e) => setNeed(e.target.value)} rows={3} />
        <FormHelperText>
          You'll sort {plural(session.counts.pool, 'record')} by how well each meets this need. “Triton” can be a moon, a GPU
          language or a tumour, so the need is stored with every rating.
        </FormHelperText>
      </FormControl>
      {save.error instanceof Error && (
        <Alert status="error" mt={2}>
          <AlertIcon />
          {save.error.message}
        </Alert>
      )}
      <Button type="submit" mt={3} isDisabled={!need.trim()} isLoading={save.isLoading}>
        Start sorting
      </Button>
    </Box>
  );
}

function RaterForm() {
  const [, setRater] = useRater();
  const [name, setName] = useState('');
  return (
    <Box
      as="form"
      maxW="28rem"
      onSubmit={(e: React.FormEvent) => {
        e.preventDefault();
        if (name.trim()) setRater(name.trim());
      }}
    >
      <FormControl isRequired>
        <FormLabel htmlFor="rater">Your name</FormLabel>
        <Input id="rater" value={name} onChange={(e) => setName(e.target.value)} />
        <FormHelperText>Stored with each rating. You can change it from the top bar.</FormHelperText>
      </FormControl>
      <Button type="submit" mt={3} isDisabled={!name.trim()}>
        Continue
      </Button>
    </Box>
  );
}
