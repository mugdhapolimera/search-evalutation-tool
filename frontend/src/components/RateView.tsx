import {
  Alert,
  AlertIcon,
  Box,
  Button,
  ButtonGroup,
  Flex,
  FormControl,
  FormHelperText,
  FormLabel,
  HStack,
  Input,
  Progress,
  Skeleton,
  Stack,
  Switch,
  Text,
  Textarea,
  Tooltip,
  useToast,
} from '@chakra-ui/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, Option, Pool, PoolRecord, RawRating, Session } from '../api';
import { useRater, useStoredValue } from '../prefs';
import { ResultItem } from './ResultItem';

interface Props {
  session: Session;
  onDone: () => void;
}

// Rating is blind: the pool merges every ranking's top records in a shuffled
// order with no rank, column or environment, so nobody grades toward the
// system they expect to win.
export function RateView({ session, onDone }: Props) {
  const { data: pool, isLoading } = useQuery(['pool', session.id, session.columns.length], () =>
    api.pool(session.id),
  );
  const [rater] = useRater();

  if (!session.information_need) return <NeedForm session={session} />;
  if (!rater) return <RaterForm />;
  if (isLoading || !pool) return <Skeleton height="20rem" />;
  return <RatingList session={session} pool={pool} rater={rater} onDone={onDone} />;
}

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
          Ratings mean “relevant to this need”. “Triton” can be a moon, a GPU language or a tumour,
          so the need is stored with every rating.
        </FormHelperText>
      </FormControl>
      <Button type="submit" mt={3} isDisabled={!need.trim()} isLoading={save.isLoading}>
        Start rating
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

const SHORT: Record<string, string> = {
  '3': 'Highly relevant',
  '2': 'Relevant',
  '1': 'Somewhat',
  '0': 'Not relevant',
  up: 'Right person',
  down: 'Wrong person',
  skip: "Can't judge",
};
const KEYS: Record<string, string> = { '3': '3', '2': '2', '1': '1', '0': '0', up: 'u', down: 'd', skip: 's' };

function RatingList({ session, pool, rater, onDone }: { session: Session; pool: Pool; rater: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [ratings, setRatings] = useState<Record<string, RawRating | null>>(() =>
    Object.fromEntries(pool.records.map((r) => [r.bibcode, r.rating])),
  );
  const [onlyUnrated, setOnlyUnrated] = useState(false);
  const [keysOn, setKeysOn] = useStoredValue('search-eval:keys', 'on');
  const [focus, setFocus] = useState(0);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Keep ratings from other tabs or reloads in step with the server copy.
  useEffect(() => {
    setRatings((current) => ({
      ...Object.fromEntries(pool.records.map((r) => [r.bibcode, r.rating])),
      ...current,
    }));
  }, [pool]);

  const records = useMemo(
    () => (onlyUnrated ? pool.records.filter((r) => !ratings[r.bibcode]) : pool.records),
    [pool.records, onlyUnrated, ratings],
  );
  const total = pool.records.length;
  const done = pool.records.filter((r) => ratings[r.bibcode]).length;

  // Keep the cursor inside the list as it shrinks.
  useEffect(() => setFocus((f) => Math.min(f, Math.max(records.length - 1, 0))), [records.length]);

  // Saves go out one at a time, in the order they were made, so a fast rater
  // never has two writes to the same session in flight.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const save = useMutation(
    (vars: { bibcode: string; rating: RawRating | null; note?: string }) => {
      const next = queue.current.catch(() => undefined).then(() => api.rate(session.id, { ...vars, rater }));
      queue.current = next;
      return next;
    },
    {
      onSuccess: (next) => queryClient.setQueryData(['session', session.id], next),
      onError: (error: Error, vars) => {
        setRatings((r) => ({ ...r, [vars.bibcode]: pool.records.find((p) => p.bibcode === vars.bibcode)?.rating ?? null }));
        if (!toast.isActive('rate-error')) {
          toast({ id: 'rate-error', status: 'error', title: 'A rating was not saved', description: error.message });
        }
      },
    },
  );

  const rate = useCallback(
    (bibcode: string, rating: RawRating, note?: string) => {
      // Choosing the selected rating again clears it.
      const next = ratings[bibcode] === rating ? null : rating;
      setRatings((r) => ({ ...r, [bibcode]: next }));
      save.mutate({ bibcode, rating: next, ...(note ? { note } : {}) });
      // With "only unrated" on, the rated record leaves the list and the next
      // one slides into place, so the cursor stays put.
      if (next && !onlyUnrated) setFocus((f) => Math.min(f + 1, records.length - 1));
    },
    [ratings, records.length, save, onlyUnrated],
  );

  useEffect(() => {
    if (keysOn !== 'on') return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || target.closest('input, textarea, select, [contenteditable]')) return;
      const record = records[focus];
      if (e.key === 'j') setFocus((f) => Math.min(f + 1, records.length - 1));
      else if (e.key === 'k') setFocus((f) => Math.max(f - 1, 0));
      else if (record) {
        const option = pool.options.find((o) => KEYS[o.value] === e.key);
        if (!option) return;
        rate(record.bibcode, option.value as RawRating);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [keysOn, records, focus, pool.options, rate]);

  useEffect(() => {
    const record = records[focus];
    if (record && keysOn === 'on') itemRefs.current[record.bibcode]?.scrollIntoView({ block: 'nearest' });
  }, [focus, records, keysOn]);

  return (
    <Stack spacing={3}>
      <Box position="sticky" top={0} zIndex={2} bg="white" py={2} borderBottom="1px" borderColor="gray.100">
        <Flex gap={4} align="center" wrap="wrap">
          <Text fontWeight="semibold" aria-live="polite">
            {done} of {total} rated
          </Text>
          <Progress value={total ? (100 * done) / total : 0} flex="1" minW="8rem" size="sm" borderRadius="sm" aria-hidden />
          <HStack>
            <Switch id="only-unrated" isChecked={onlyUnrated} onChange={(e) => setOnlyUnrated(e.target.checked)} />
            <Text as="label" htmlFor="only-unrated" fontSize="sm">
              Only unrated
            </Text>
          </HStack>
          <HStack>
            <Switch id="keys" isChecked={keysOn === 'on'} onChange={(e) => setKeysOn(e.target.checked ? 'on' : 'off')} />
            <Text as="label" htmlFor="keys" fontSize="sm">
              Keyboard shortcuts
            </Text>
          </HStack>
          <Button size="sm" onClick={onDone} variant={done === total ? 'solid' : 'outline'}>
            {done === total ? 'Done: compare' : 'Compare'}
          </Button>
        </Flex>
        <Text fontSize="sm" color="gray.600" mt={1}>
          Need: {session.information_need}
          {keysOn === 'on' && ' · Keys: j/k move, ' + pool.options.map((o) => `${KEYS[o.value]} ${SHORT[o.value].toLowerCase()}`).join(', ')}
        </Text>
      </Box>
      {records.length === 0 && (
        <Alert status="success" borderRadius="md">
          <AlertIcon />
          Everything is rated.
        </Alert>
      )}
      {records.map((record, index) => (
        <div key={record.bibcode} ref={(el) => (itemRefs.current[record.bibcode] = el)} onClick={() => setFocus(index)}>
          <RatingItem
            record={record}
            options={pool.options}
            value={ratings[record.bibcode] ?? null}
            isFocused={keysOn === 'on' && index === focus}
            onRate={(rating, note) => rate(record.bibcode, rating, note)}
            onNote={(note) => {
              const rating = ratings[record.bibcode];
              if (rating) save.mutate({ bibcode: record.bibcode, rating, note });
            }}
          />
        </div>
      ))}
    </Stack>
  );
}

const SCHEME: Record<string, string> = { '3': 'green', '2': 'teal', '1': 'yellow', '0': 'red', up: 'green', down: 'red', skip: 'gray' };

function RatingItem({
  record,
  options,
  value,
  isFocused,
  onRate,
  onNote,
}: {
  record: PoolRecord;
  options: Option[];
  value: RawRating | null;
  isFocused: boolean;
  onRate: (rating: RawRating, note: string) => void;
  onNote: (note: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [noteOpen, setNoteOpen] = useState(Boolean(record.note));
  const [note, setNote] = useState(record.note ?? '');
  const titleText = (record.title ?? record.bibcode).replace(/<[^>]+>/g, '');
  return (
    <ResultItem
      bibcode={record.bibcode}
      title={record.title}
      authors={record.authors}
      year={record.year}
      pub={record.pub}
      isFocused={isFocused}
    >
      {record.abstract && (
        <Box mt={2} fontSize="sm">
          <Text noOfLines={expanded ? undefined : 3} dangerouslySetInnerHTML={{ __html: record.abstract }} />
          <Button size="xs" variant="link" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
            {expanded ? 'Show less' : 'Show full abstract'}
          </Button>
        </Box>
      )}
      <Flex mt={2} mb={1} gap={2} wrap="wrap" align="center">
        <ButtonGroup size="sm" isAttached={false} spacing={1} role="group" aria-label={`Rate: ${titleText}`} flexWrap="wrap">
          {options.map((o) => (
            <Tooltip key={o.value} label={o.definition} openDelay={400} hasArrow placement="top">
              <Button
                variant={value === o.value ? 'solid' : 'outline'}
                colorScheme={value === o.value ? SCHEME[o.value] : 'gray'}
                aria-pressed={value === o.value}
                onClick={() => onRate(o.value as RawRating, note)}
                fontWeight={value === o.value ? 'bold' : 'normal'}
              >
                {['3', '2', '1', '0'].includes(o.value) ? `${o.value} · ${SHORT[o.value]}` : SHORT[o.value]}
              </Button>
            </Tooltip>
          ))}
        </ButtonGroup>
        {!noteOpen && (
          <Button size="xs" variant="link" onClick={() => setNoteOpen(true)}>
            Add a note
          </Button>
        )}
      </Flex>
      {noteOpen && (
        <Input
          size="sm"
          mb={2}
          aria-label={`Note on ${titleText}`}
          placeholder={value === 'skip' ? "Why can't you judge it?" : 'Note (optional)'}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => note !== (record.note ?? '') && onNote(note)}
        />
      )}
    </ResultItem>
  );
}
