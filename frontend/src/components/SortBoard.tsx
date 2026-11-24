import { CloseIcon } from '@chakra-ui/icons';
import {
  Alert,
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
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const toggle = (bibcode: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(bibcode)) next.delete(bibcode);
      else next.add(bibcode);
      return next;
    });
  const dragFrom = useRef<string | null>(null);
  const [focus, setFocus] = useState(0);
  const [abstracts, setAbstracts] = useStoredValue('search-eval:abstracts', 'none');
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

  // Move several cards at once, keeping their order, to the end of a column.
  const moveMany = (bibcodes: string[], target: string) => {
    const moving = new Set(bibcodes);
    const next: Columns = {};
    Object.entries(columns).forEach(([key, list]) => (next[key] = list.filter((b) => !moving.has(b))));
    const inOrder = Object.values(columns).flat().filter((b) => moving.has(b));
    next[target] = [...next[target], ...inOrder];
    setSelected(new Set());
    commit(next);
  };

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
    // Dragging a ticked card carries every ticked card, placed right after it.
    if (selected.has(String(active.id)) && selected.size > 1) {
      const others = new Set([...selected].filter((b) => b !== active.id));
      const stripped: Columns = {};
      Object.entries(next).forEach(([key, list]) => (stripped[key] = list.filter((b) => !others.has(b))));
      const inOrder = Object.values(next).flat().filter((b) => others.has(b));
      const list = stripped[container];
      const at = list.indexOf(String(active.id)) + 1;
      stripped[container] = [...list.slice(0, at), ...inOrder, ...list.slice(at)];
      next = stripped;
      setSelected(new Set());
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
      else if (bibcode && e.key === 'x') toggle(bibcode);
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

  const keysHint = `${board.groups.map((g) => `${keyFor(g.grade)}`).join('/')}/s`;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}>
      <Stack spacing={3}>
        <Flex align="center" gap={4} wrap="wrap">
          <Text fontWeight="semibold" aria-live="polite">
            {sortedCount} of {total} sorted
          </Text>
          <Text fontSize="sm" color="gray.600" flex="1" minW="16rem">
            Drag each card from <b>To sort</b> into the column that describes it. Higher in a column means better.
            {keysOn === 'on' && ` Keys: ${keysHint} send the highlighted card, x ticks it, j/k move.`} Tick several cards to move them together.
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
        {selected.size > 0 && (
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
            position="sticky"
            top={0}
            zIndex={2}
            role="region"
            aria-label="Selected records"
          >
            <Text fontWeight="semibold">{selected.size} selected</Text>
            <Text fontSize="sm">Move to:</Text>
            <ButtonGroup size="sm" spacing={1} flexWrap="wrap">
              {board.groups.map((g) => (
                <Button key={g.grade} colorScheme={SCHEME[g.grade] ?? 'gray'} variant="outline" bg="white" onClick={() => moveMany([...selected], groupKey(g.grade))}>
                  {g.label}
                </Button>
              ))}
              <Button variant="outline" bg="white" onClick={() => moveMany([...selected], SKIP)}>
                {board.skip.label}
              </Button>
              <Button variant="outline" bg="white" onClick={() => moveMany([...selected], UNSORTED)}>
                To sort
              </Button>
            </ButtonGroup>
            <Button size="sm" variant="link" ml="auto" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </Flex>
        )}
        <Flex gap={3} overflowX="auto" align="stretch" pb={2}>
          <BoardColumn id={UNSORTED} title="To sort" count={unsorted.length} scheme="blue" wide empty="All sorted">
            {unsorted.map((bibcode, index) => (
              <Card
                key={bibcode}
                record={records[bibcode]}
                isSelected={selected.has(bibcode)}
                onToggle={() => toggle(bibcode)}
                showAbstract={abstracts === 'all'}
                isFocused={keysOn === 'on' && index === Math.min(focus, unsorted.length - 1)}
                onFocus={() => setFocus(index)}
                quick={{ label: lowest.label, onClick: () => moveTo(bibcode, groupKey(lowest.grade)) }}
              />
            ))}
          </BoardColumn>
          {board.groups.map((g) => {
            const key = groupKey(g.grade);
            return (
              <BoardColumn
                key={g.grade}
                id={key}
                title={g.label}
                definition={g.definition}
                count={columns[key].length}
                scheme={SCHEME[g.grade] ?? 'gray'}
                keyHint={keysOn === 'on' ? keyFor(g.grade) : undefined}
                ordered={columns[key].length > 1 ? ordered.has(g.grade) : undefined}
              >
                {columns[key].map((b, i) => (
                  <Card
                    key={b}
                    record={records[b]}
                    isSelected={selected.has(b)}
                    onToggle={() => toggle(b)}
                    showAbstract={abstracts === 'all'}
                    position={i + 1}
                    onReorder={(step) => reorderWithin(key, b, step)}
                    onUnsort={() => moveTo(b, UNSORTED)}
                  />
                ))}
              </BoardColumn>
            );
          })}
          <BoardColumn
            id={SKIP}
            title={board.skip.label}
            definition={board.skip.definition}
            count={columns[SKIP].length}
            scheme="gray"
            keyHint={keysOn === 'on' ? 's' : undefined}
          >
            {columns[SKIP].map((b) => (
              <Card
                key={b}
                record={records[b]}
                isSelected={selected.has(b)}
                onToggle={() => toggle(b)}
                showAbstract={abstracts === 'all'}
                onUnsort={() => moveTo(b, UNSORTED)}
                note={notes[b] ?? ''}
                onNote={(note) => commit(columns, ordered, { ...notes, [b]: note })}
              />
            ))}
          </BoardColumn>
        </Flex>
        {unsorted.length === 0 && whenSorted}
      </Stack>
      <DragOverlay>
        {activeId && records[activeId] ? (
          <CardPreview record={records[activeId]} more={selected.has(activeId) ? selected.size - 1 : 0} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

// One column of the board: a coloured header with the rubric definition, and
// a drop area that says so while it is empty.
function BoardColumn({
  id,
  title,
  definition,
  count,
  scheme,
  wide,
  keyHint,
  ordered,
  empty = 'Drop here',
  children,
}: {
  id: string;
  title: string;
  definition?: string;
  count: number;
  scheme: string;
  wide?: boolean;
  keyHint?: string;
  ordered?: boolean;
  empty?: string;
  children: ReactNode[];
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const items = (children as { key: string }[]).map((c) => String(c.key));
  return (
    <Flex
      as="section"
      aria-label={title}
      direction="column"
      flex={wide ? '1.5 0 260px' : '1 0 180px'}
      bg="gray.50"
      border="1px"
      borderColor={isOver ? 'blue.400' : 'gray.100'}
      borderTop="4px solid"
      borderTopColor={`${scheme}.400`}
      borderRadius="md"
    >
      <Box px={2} pt={2} pb={1}>
        <HStack spacing={2}>
          <Text fontWeight="bold">{title}</Text>
          <Text fontSize="sm" color="gray.600">
            {count}
          </Text>
          {keyHint && (
            <Badge variant="outline" colorScheme="gray" ml="auto" title={`Press ${keyHint}`} textTransform="none">
              {keyHint}
            </Badge>
          )}
        </HStack>
        {definition && (
          <Text fontSize="xs" color="gray.600" noOfLines={3} title={definition}>
            {definition}
          </Text>
        )}
        {ordered !== undefined && (
          <Badge mt={1} variant={ordered ? 'subtle' : 'outline'} colorScheme={ordered ? 'blue' : 'gray'} textTransform="none">
            {ordered ? 'Your order' : 'Tied'}
          </Badge>
        )}
      </Box>
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <Stack ref={setNodeRef} spacing={2} p={2} flex="1" minH="12rem" maxH="70vh" overflowY="auto" bg={isOver ? 'blue.50' : undefined}>
          {children}
          {count === 0 && (
            <Flex
              flex="1"
              minH="8rem"
              align="center"
              justify="center"
              border="2px dashed"
              borderColor={isOver ? 'blue.400' : 'gray.200'}
              borderRadius="md"
              color="gray.500"
              fontSize="sm"
            >
              {empty}
            </Flex>
          )}
        </Stack>
      </SortableContext>
    </Flex>
  );
}

// A short record card. The whole card drags; the abstract opens on demand, so
// the columns stay scannable.
function Card({
  record,
  isSelected,
  onToggle,
  position,
  showAbstract = false,
  isFocused,
  onFocus,
  quick,
  onUnsort,
  onReorder,
  note,
  onNote,
}: {
  record: BoardRecord;
  isSelected: boolean;
  onToggle: () => void;
  position?: number;
  showAbstract?: boolean;
  isFocused?: boolean;
  onFocus?: () => void;
  quick?: { label: string; onClick: () => void };
  onUnsort?: () => void;
  onReorder?: (step: number) => void;
  note?: string;
  onNote?: (note: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: record.bibcode });
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? showAbstract;
  useEffect(() => setOpen(null), [showAbstract]);
  const [draft, setDraft] = useState(note ?? '');
  const title = plainTitle(record);
  const firstAuthor = record.authors.shown[0];
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
      onClick={onFocus}
      aria-label={`${title}${position ? `, position ${position}` : ''}. Drag to sort.`}
      opacity={isDragging ? 0.4 : 1}
      border="1px"
      borderColor={isFocused || isSelected ? 'blue.500' : 'gray.200'}
      bgColor={isSelected ? 'blue.50' : 'white'}
      boxShadow={isFocused ? '0 0 0 1px var(--chakra-colors-blue-500)' : 'sm'}
      borderRadius="md"
      p={2}
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
          <Link
            href={`https://scixplorer.org/abs/${encodeURIComponent(record.bibcode)}/abstract`}
            isExternal
            fontSize="sm"
            fontWeight="semibold"
            noOfLines={3}
            title={title}
            dangerouslySetInnerHTML={{ __html: record.title ?? record.bibcode }}
          />
          <Text fontSize="xs" color="gray.600" noOfLines={1}>
            {firstAuthor}
            {record.authors.total > 1 ? ' et al.' : ''}
            {record.year ? ` · ${record.year}` : ''}
            {record.pub ? ` · ${record.pub}` : ''}
          </Text>
        </Box>
      </Flex>
      {expanded && record.abstract && (
        <Text mt={2} fontSize="xs" maxH="14rem" overflowY="auto" dangerouslySetInnerHTML={{ __html: record.abstract }} />
      )}
      <Flex mt={1} gap={2} align="center">
        {record.abstract && (
          <Button size="xs" variant="link" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
            {expanded ? 'Hide abstract' : 'Abstract'}
          </Button>
        )}
        {quick && (
          <Button size="xs" variant="outline" colorScheme="red" ml="auto" onClick={quick.onClick} aria-label={`${quick.label}: ${title}`} title={quick.label}>
            👎
          </Button>
        )}
        {onUnsort && (
          <IconButton
            aria-label={`Back to To sort: ${title}`}
            title="Back to To sort"
            icon={<CloseIcon boxSize={2} />}
            size="xs"
            variant="ghost"
            ml="auto"
            onClick={onUnsort}
          />
        )}
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
