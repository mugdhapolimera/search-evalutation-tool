import { ChevronLeftIcon, ChevronRightIcon } from '@chakra-ui/icons';
import { Alert, AlertIcon, Box, Button, Flex, IconButton, Skeleton, Stack, Text } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { SummaryStrip } from '../components/CompareView';
import { SearchBar } from '../components/SearchBar';
import { RatingBoard } from '../components/RatingBoard';
import { TweakRail } from '../components/TweakRail';
import { useStoredValue } from '../prefs';
import { useConfig } from '../useConfig';
import { useStartSearch } from './Home';

// One screen per search. The tweak rail sits on the left and folds away to
// the side. The main area compares, rates and ranks in one pass: each
// engine's results side by side, with the rating groups beside them.
export function Workspace() {
  const id = Number(useParams().id);
  const { data: config } = useConfig();
  const { data: session, error, isLoading } = useQuery(['session', id], () => api.session(id));
  // Refetch the board only when a run is added, i.e. when new records arrive.
  const { data: board } = useQuery(['board', id, session?.columns.length], () => api.board(id), { enabled: !!session });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [rail, setRail] = useStoredValue('search-eval:rail', 'open');
  const start = useStartSearch();

  // Show the newest tweak until the person picks another.
  useEffect(() => {
    if (!session) return;
    const tweaks = session.columns.filter((c) => !c.is_baseline);
    if (!tweaks.some((t) => t.id === selectedId)) setSelectedId(tweaks.at(-1)?.id ?? null);
  }, [session, selectedId]);

  if (error instanceof Error) {
    return (
      <Alert status="error" mt={6} borderRadius="md">
        <AlertIcon />
        {error.message}
      </Alert>
    );
  }
  if (isLoading || !session || !config) return <Skeleton height="30rem" mt={6} />;

  const baseline = session.columns[0];
  const tweak = session.columns.find((c) => c.id === selectedId && !c.is_baseline);
  const discipline = config.disciplines.find((d) => d.value === session.discipline)?.label;
  const railOpen = rail !== 'closed';

  return (
    <Box mt={4}>
      <SearchBar
        key={session.id}
        initialQuery={session.query}
        initialIntent={session.intent}
        isLoading={start.isLoading}
        onSearch={(query, intent) => start.mutate({ query, intent })}
      />
      <Text fontSize="sm" mt={1}>
        {baseline.num_found !== null && (
          <>
            Production returned <b>{baseline.num_found.toLocaleString()}</b> results
          </>
        )}
        {discipline && ` · ${discipline}`}
        {session.information_need && ` · Need: ${session.information_need}`}
      </Text>
      {start.error instanceof Error && (
        <Alert status="error" mt={2} borderRadius="md">
          <AlertIcon />
          {start.error.message}
        </Alert>
      )}
      <Flex gap={5} mt={5} align="start" direction={{ base: 'column', lg: 'row' }}>
        {railOpen ? (
          <Box as="aside" aria-label="Tweak the search" w={{ base: 'full', lg: '300px' }} flexShrink={0} order={{ base: 2, lg: 1 }}>
            <Button size="xs" variant="ghost" leftIcon={<ChevronLeftIcon />} onClick={() => setRail('closed')} mb={1}>
              Hide tweaks
            </Button>
            <TweakRail config={config} session={session} selectedId={selectedId} onSelect={setSelectedId} />
          </Box>
        ) : (
          <IconButton
            aria-label="Show tweaks"
            title="Show tweaks"
            icon={<ChevronRightIcon />}
            variant="outline"
            size="sm"
            onClick={() => setRail('open')}
            flexShrink={0}
          />
        )}
        <Stack spacing={4} flex="1" minW={0} w="full" order={{ base: 1, lg: 2 }}>
          <SummaryStrip session={session} tweak={tweak} />
          {board ? (
            <RatingBoard session={session} board={board} tweak={tweak} />
          ) : (
            <Skeleton height="20rem" />
          )}
        </Stack>
      </Flex>
    </Box>
  );
}
