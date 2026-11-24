import {
  Badge,
  Box,
  Button,
  Collapse,
  Flex,
  SimpleGrid,
  Text,
  useDisclosure,
} from '@chakra-ui/react';
import { Column, Session } from '../api';
import { fmt, plural, signed } from '../format';
import { useColorModeColors } from '../scix/useColorModeColors';

const VERDICT_TEXT = { better: 'Better', worse: 'Worse', same: 'No change' } as const;
const VERDICT_SCHEME = { better: 'green', worse: 'red', same: 'gray' } as const;

// One line that answers "is this tweak better?". While records are still
// unrated it says only that: a verdict on part of the ratings misleads.
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
        <b>{plural(unrated, 'record')} to rate.</b> The verdict appears once every record is rated, so it never
        rests on half the ratings.
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

