import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Grid,
  Skeleton,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Text,
} from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { CompareView } from '../components/CompareView';
import { OrderView } from '../components/OrderView';
import { RateView } from '../components/RateView';
import { SearchBar } from '../components/SearchBar';
import { TweakRail } from '../components/TweakRail';
import { useConfig } from '../useConfig';
import { useStartSearch } from './Home';

const VIEWS = ['compare', 'rate', 'order'] as const;

// One page per search: tweak controls on the left, and the comparison, the
// blind rating list and the ideal order as views of the same session.
export function Workspace() {
  const id = Number(useParams().id);
  const { data: config } = useConfig();
  const { data: session, error, isLoading } = useQuery(['session', id], () => api.session(id));
  const [params, setParams] = useSearchParams();
  const view = Math.max(0, VIEWS.indexOf((params.get('view') as (typeof VIEWS)[number]) ?? 'compare'));
  const setView = (index: number) => setParams({ view: VIEWS[index] }, { replace: true });
  const [selectedId, setSelectedId] = useState<number | null>(null);
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
  const discipline = config.disciplines.find((d) => d.value === session.discipline)?.label;

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
      <Grid templateColumns={{ base: '1fr', lg: '300px 1fr' }} gap={6} mt={6} alignItems="start">
        <Box as="aside" aria-label="Tweak the search" order={{ base: 2, lg: 1 }}>
          <TweakRail config={config} session={session} selectedId={selectedId} onSelect={setSelectedId} />
        </Box>
        <Tabs index={view} onChange={setView} isLazy minW={0} order={{ base: 1, lg: 2 }}>
          <TabList>
            <Tab>Compare</Tab>
            <Tab>
              Rate
              {session.counts.unrated > 0 && (
                <Badge ml={2} colorScheme="blue" variant="solid" borderRadius="full" aria-label={`${session.counts.unrated} to rate`}>
                  {session.counts.unrated}
                </Badge>
              )}
            </Tab>
            <Tab>Order</Tab>
          </TabList>
          <TabPanels>
            <TabPanel px={0}>
              <CompareView session={session} selectedId={selectedId} onRate={() => setView(1)} />
            </TabPanel>
            <TabPanel px={0}>
              <RateView session={session} onDone={() => setView(0)} />
            </TabPanel>
            <TabPanel px={0}>
              <OrderView session={session} />
              <Button mt={6} size="sm" variant="outline" onClick={() => setView(0)}>
                Back to compare
              </Button>
            </TabPanel>
          </TabPanels>
        </Tabs>
      </Grid>
    </Box>
  );
}
