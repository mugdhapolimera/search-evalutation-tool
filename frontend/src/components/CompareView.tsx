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
  SimpleGrid,
  Stack,
  Tag,
  Text,
  useDisclosure,
  Wrap,
} from '@chakra-ui/react';
import { useState } from 'react';
import { Column, Metrics, Session } from '../api';
import { fmt, plural, signed } from '../format';
import { useColorModeColors } from '../scix/useColorModeColors';
import { GradeChip } from './GradeChip';
import { MoveTag } from './MoveTag';
import { ResultItem } from './ResultItem';

interface Props {
  session: Session;
  selectedId: number | null;
  onRate: () => void;
}

export function CompareView({ session, selectedId, onRate }: Props) {
  const baseline = session.columns[0];
  const tweak = session.columns.find((c) => c.id === selectedId && !c.is_baseline);
  const { unrated } = session.counts;

  return (
    <Stack spacing={4}>
      {unrated > 0 && (
        <Alert status="info" borderRadius="md">
          <AlertIcon />
          <AlertDescription flex="1">
            {plural(unrated, 'record')} in these top {session.k}s {unrated === 1 ? "isn't" : "aren't"} rated
            yet, so the comparison is incomplete.
          </AlertDescription>
          <Button size="sm" onClick={onRate}>
            Rate {unrated === 1 ? 'it' : 'them'}
          </Button>
        </Alert>
      )}
      {tweak && baseline.metrics && tweak.metrics && (
        <SummaryStrip k={session.k} baseline={baseline.metrics} tweak={tweak} />
      )}
      <Grid templateColumns={{ base: '1fr', lg: tweak ? '1fr 1fr' : '1fr' }} gap={4} alignItems="start">
        <RankingColumn session={session} column={baseline} title="Production ranking" />
        {tweak ? (
          <RankingColumn session={session} column={tweak} title="Tweak" />
        ) : (
          session.columns.length === 1 && (
            <Text color="gray.600" fontSize="sm">
              Change a field weight, the boost or the environment on the left and run it. The tweak
              appears here, next to production.
            </Text>
          )
        )}
      </Grid>
    </Stack>
  );
}

const VERDICT_TEXT = { better: 'Better', worse: 'Worse', same: 'No change' } as const;
const VERDICT_SCHEME = { better: 'green', worse: 'red', same: 'gray' } as const;

// One line that answers "is this tweak better?" before anything else.
function SummaryStrip({ k, baseline, tweak }: { k: number; baseline: Metrics; tweak: Column }) {
  const m = tweak.metrics!;
  const details = useDisclosure();
  const colors = useColorModeColors();
  const rated = m.rated_in_top_k ?? 0;
  return (
    <Box border="1px" borderColor={colors.border} borderRadius="md" p={3} bg={colors.panel}>
      <Flex gap={4} wrap="wrap" align="center">
        {m.verdict ? (
          <Badge
            colorScheme={VERDICT_SCHEME[m.verdict]}
            variant={m.provisional ? 'outline' : 'solid'}
            fontSize="md"
            px={2}
            textTransform="none"
          >
            {VERDICT_TEXT[m.verdict]}
            {m.provisional ? ' (provisional)' : ''}
          </Badge>
        ) : (
          <Badge variant="outline" fontSize="md" px={2} textTransform="none">
            Rate records to compare
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
        <Text fontSize="sm" color={m.provisional && rated > 0 ? 'orange.700' : 'gray.600'}>
          {rated} of {k} rated
          {m.provisional && rated > 0 && m.range[0] !== null && m.range[1] !== null && m.range[0] !== m.range[1]
            ? ` · could land ${fmt(m.range[0])}–${fmt(m.range[1])}`
            : ''}
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
    </Box>
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

function RankingColumn({ session, column, title }: { session: Session; column: Column; title: string }) {
  const [showAll, setShowAll] = useState(false);
  const k = session.k;
  const rows = showAll ? column.results : column.results.slice(0, k);
  const m = column.metrics;
  return (
    <Box as="section" aria-label={title} minW={0}>
      <Stack spacing={1} mb={2}>
        <HStack justify="space-between" align="baseline">
          <Heading as="h2" size="md">
            {title}
          </Heading>
          {m && (
            <Text fontSize="sm">
              {m.headline_label}{' '}
              <Text as="span" fontWeight="bold">
                {fmt(m.headline)}
              </Text>
            </Text>
          )}
        </HStack>
        {column.is_baseline ? (
          <Text fontSize="sm" color="gray.600">
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
              <Text fontSize="sm" color="gray.600" alignSelf="center">
                {column.num_found.toLocaleString()} results
              </Text>
            )}
          </Wrap>
        )}
        {column.warnings.map((w) => (
          <Alert key={w} status="warning" fontSize="sm" py={1} borderRadius="md">
            <AlertIcon boxSize={4} />
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
          {rows.map((r) => (
            <ResultItem
              key={r.bibcode}
              bibcode={r.bibcode}
              title={r.title}
              authors={r.authors}
              year={r.year}
              pub={r.pub}
              aside={!column.is_baseline && <MoveTag move={r.move} />}
              gutter={
                <>
                  <Text fontWeight="semibold">{r.rank}</Text>
                  <GradeChip grade={r.grade} mode={session.rating_mode} short />
                </>
              }
            />
          ))}
          {column.results.length > k && (
            <Button size="sm" variant="link" onClick={() => setShowAll(!showAll)} mt={1}>
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
                  <HStack as="li" key={d.bibcode} spacing={2} align="start">
                    <Text color="gray.600" minW="3.5rem">
                      was {d.was}
                    </Text>
                    <GradeChip grade={d.grade} mode={session.rating_mode} short />
                    <Text dangerouslySetInnerHTML={{ __html: d.title ?? d.bibcode }} />
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
