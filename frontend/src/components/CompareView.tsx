import {
  Alert,
  AlertDescription,
  AlertIcon,
  Badge,
  Box,
  Button,
  Collapse,
  Flex,
  Grid,
  Heading,
  HStack,
  Link,
  SimpleGrid,
  Stack,
  Tag,
  Text,
  useDisclosure,
  Wrap,
} from '@chakra-ui/react';
import { useState } from 'react';
import { Column, Session } from '../api';
import { fmt, plural, signed } from '../format';
import { useColorModeColors } from '../scix/useColorModeColors';
import { GradeChip } from './GradeChip';
import { MoveTag } from './MoveTag';

const VERDICT_TEXT = { better: 'Better', worse: 'Worse', same: 'No change' } as const;
const VERDICT_SCHEME = { better: 'green', worse: 'red', same: 'gray' } as const;

// One line that answers "is this tweak better?". While records are still to
// sort it shows only that, so nobody sees which ranking held which record
// before they have rated it.
export function SummaryStrip({ session, tweak }: { session: Session; tweak: Column | undefined }) {
  const details = useDisclosure();
  const colors = useColorModeColors();
  const k = session.k;
  const baseline = session.columns[0].metrics;
  const { unrated } = session.counts;
  const box = (children: React.ReactNode) => (
    <Box border="1px" borderColor={colors.border} borderRadius="md" p={3} bg={colors.panel}>
      {children}
    </Box>
  );
  if (unrated > 0) {
    return box(
      <Text>
        <b>{plural(unrated, 'record')} to sort.</b> The comparison is worked out from your sorting and appears when
        nothing is left.
      </Text>,
    );
  }
  if (!tweak) {
    return box(
      <Text>
        Production {baseline?.headline_label}{' '}
        <Text as="span" fontWeight="semibold">
          {fmt(baseline?.headline)}
        </Text>
        . Change a weight, the boost or the environment on the left to compare a tweak against it.
      </Text>,
    );
  }
  const m = tweak.metrics;
  if (!m || !baseline) return null;
  return box(
    <>
      <Flex gap={4} wrap="wrap" align="center">
        {m.verdict && (
          <Badge colorScheme={VERDICT_SCHEME[m.verdict]} variant={m.provisional ? 'outline' : 'solid'} fontSize="md" px={2} textTransform="none">
            {VERDICT_TEXT[m.verdict]}
            {m.provisional ? ' (provisional)' : ''}
          </Badge>
        )}
        {m.headline !== null && (
          <Text>
            {m.headline_label}{' '}
            <Text as="span" fontWeight="semibold">
              {fmt(baseline.headline)} → {fmt(m.headline)}
            </Text>
            {m.delta !== null && (
              <Text as="span" color="gray.600">
                {' '}
                ({signed(m.delta)})
              </Text>
            )}
          </Text>
        )}
        {m.relevant_change !== null && m.verdict && (
          <Text fontSize="sm">
            {m.relevant_change === 0
              ? 'Same number of relevant records'
              : `${m.relevant_change > 0 ? '+' : '−'}${plural(Math.abs(m.relevant_change), 'relevant record')}`}{' '}
            in the top {k}
          </Text>
        )}
        {m.same_as_baseline !== null && (
          <Text fontSize="sm">
            {m.same_as_baseline} of {k} same as production
          </Text>
        )}
        <Text fontSize="sm" color="gray.600">
          {m.rated_in_top_k ?? 0} of {k} rated
        </Text>
        <Button size="xs" variant="link" ml="auto" onClick={details.onToggle} aria-expanded={details.isOpen}>
          {details.isOpen ? 'Hide details' : 'Details'}
        </Button>
      </Flex>
      <Collapse in={details.isOpen} animateOpacity>
        <SimpleGrid columns={{ base: 2, md: 4 }} spacing={2} mt={3} fontSize="sm">
          <Figure label={`NDCG@${k}`} value={fmt(m.details.ndcg)} />
          <Figure label={`Precision@${k} (rated only)`} value={fmt(m.details.precision)} />
          <Figure label="Rank-biased overlap (p 0.9)" value={fmt(m.details.rbo)} />
          <Figure label={`Overlap@${k}`} value={fmt(m.details.overlap, 2)} />
          {m.details.success !== null && <Figure label={`Found in top ${k}`} value={fmt(m.details.success, 0)} />}
          <Figure label="NDCG range given unrated" value={`${fmt(m.range[0])}–${fmt(m.range[1])}`} />
          <Figure label="Rated records in pool" value={String(m.details.pool_size ?? '—')} />
          <Figure label="Gain" value={m.details.gain ?? '—'} />
        </SimpleGrid>
      </Collapse>
    </>,
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Text color="gray.600" fontSize="xs">
        {label}
      </Text>
      <Text fontWeight="semibold">{value}</Text>
    </Box>
  );
}

// Production next to the selected tweak, as compact rows: every record here
// has already been read and sorted, so only the title, the rater's grade and
// the rank change are shown.
export function CompactComparison({ session, tweak }: { session: Session; tweak: Column | undefined }) {
  const baseline = session.columns[0];
  return (
    <Box>
      <Heading as="h2" size="md" mb={3}>
        How the rankings compare
      </Heading>
      <Grid templateColumns={{ base: '1fr', md: tweak ? '1fr 1fr' : '1fr' }} gap={4} alignItems="start">
        <RankingColumn session={session} column={baseline} title="Production" />
        {tweak && <RankingColumn session={session} column={tweak} title="Tweak" />}
      </Grid>
    </Box>
  );
}

function RankingColumn({ session, column, title }: { session: Session; column: Column; title: string }) {
  const [showAll, setShowAll] = useState(false);
  const k = session.k;
  const rows = showAll ? column.results : column.results.slice(0, k);
  return (
    <Box as="section" aria-label={title} minW={0}>
      <Stack spacing={1} mb={2}>
        <HStack justify="space-between" align="baseline">
          <Heading as="h3" size="sm">
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
          <Stack as="ol" spacing={1} listStyleType="none">
            {rows.map((r) => (
              <Flex as="li" key={r.bibcode} align="center" gap={2} fontSize="sm" bg="gray.50" borderRadius="sm" px={2} py={1}>
                <Text color="gray.600" minW="1.25rem" textAlign="right">
                  {r.rank}
                </Text>
                <GradeChip grade={r.grade} mode={session.rating_mode} short />
                <Link
                  href={`https://scixplorer.org/abs/${encodeURIComponent(r.bibcode)}/abstract`}
                  isExternal
                  noOfLines={1}
                  flex="1"
                  minW={0}
                  dangerouslySetInnerHTML={{ __html: r.title ?? r.bibcode }}
                />
                {!column.is_baseline && <MoveTag move={r.move} />}
              </Flex>
            ))}
          </Stack>
          {column.results.length > k && (
            <Button size="xs" variant="link" onClick={() => setShowAll(!showAll)} mt={1}>
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
                  <HStack as="li" key={d.bibcode} spacing={2} align="center">
                    <Text color="gray.600" minW="3.5rem">
                      was {d.was}
                    </Text>
                    <GradeChip grade={d.grade} mode={session.rating_mode} short />
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
