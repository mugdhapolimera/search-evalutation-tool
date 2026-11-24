import { Alert, AlertIcon, Box, Heading, Link, Stack, Text } from '@chakra-ui/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { api, Intent } from '../api';
import { SearchBar } from '../components/SearchBar';
import { plural } from '../format';
import { useDiscipline } from '../prefs';

export function useStartSearch() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [discipline] = useDiscipline();
  return useMutation(
    ({ query, intent }: { query: string; intent: Intent }) =>
      api.search({ query, intent, discipline: discipline === 'general' ? null : discipline }),
    {
      onSuccess: (session) => {
        queryClient.setQueryData(['session', session.id], session);
        queryClient.invalidateQueries(['recent']);
        navigate(`/sessions/${session.id}`);
      },
    },
  );
}

export function Home() {
  const start = useStartSearch();
  const { data: recent } = useQuery(['recent'], api.recent);
  return (
    <Stack spacing={8} maxW="container.md" mx="auto" mt={{ base: 6, md: 16 }}>
      <Box>
        <Heading as="h1" size="lg" mb={1}>
          Test a change to search ranking
        </Heading>
        <Text color="gray.600">
          Search as you would on SciX. You'll see production's ranking, then tweak field weights or the boost
          and compare, side by side.
        </Text>
      </Box>
      <SearchBar autoFocus isLoading={start.isLoading} onSearch={(query, intent) => start.mutate({ query, intent })} />
      {start.error instanceof Error && (
        <Alert status="error" borderRadius="md">
          <AlertIcon />
          {start.error.message}
        </Alert>
      )}
      {recent && recent.length > 0 && (
        <Box as="section" aria-labelledby="recent-heading">
          <Heading as="h2" size="sm" id="recent-heading" mb={2}>
            Recent searches
          </Heading>
          <Stack as="ul" listStyleType="none" spacing={1}>
            {recent.map((s) => (
              <Box as="li" key={s.id}>
                <Link as={RouterLink} to={`/sessions/${s.id}`} fontWeight="semibold">
                  {s.query}
                </Link>
                <Text as="span" fontSize="sm" color="gray.600">
                  {' '}
                  · {plural(s.tweaks, 'tweak')} · {s.rated} rated
                  {s.created_at && ` · ${new Date(s.created_at).toLocaleDateString()}`}
                </Text>
              </Box>
            ))}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}
