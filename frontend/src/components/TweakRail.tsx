import { CloseIcon } from '@chakra-ui/icons';
import {
  Accordion,
  AccordionButton,
  AccordionIcon,
  AccordionItem,
  AccordionPanel,
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Flex,
  FormControl,
  FormHelperText,
  FormLabel,
  HStack,
  IconButton,
  Input,
  NumberInput,
  NumberInputField,
  Select as NativeSelect,
  Stack,
  Text,
} from '@chakra-ui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, AppConfig, Column, Session } from '../api';
import { signed } from '../format';
import { useColorModeColors } from '../scix/useColorModeColors';

type Weights = { field: string; weight: string }[];

const toWeights = (list: { field: string; weight: number }[]): Weights =>
  list.map((w) => ({ field: w.field, weight: String(w.weight) }));

function parseQf(qf: string): Weights {
  return qf.split(/\s+/).filter(Boolean).map((term) => {
    const [field, weight = '1'] = term.split('^');
    return { field, weight };
  });
}

function sameWeights(a: Weights, b: Weights) {
  const key = (w: Weights) =>
    w.map((x) => `${x.field}^${Number(x.weight)}`).sort().join(' ');
  return key(a) === key(b);
}

interface Props {
  config: AppConfig;
  session: Session;
  selectedId: number | null;
  onSelect: (id: number) => void;
}

// The tweak controls, styled like SciX's facet panels. Field weights start at
// production's own values, because qf replaces the fields searched: a blank
// qf box invites `title^2`, which silently searches titles only.
export function TweakRail({ config, session, selectedId, onSelect }: Props) {
  const queryClient = useQueryClient();
  const production = useMemo(() => toWeights(config.production_weights), [config]);
  const [env, setEnv] = useState(config.default_variant_environment);
  const [weights, setWeights] = useState<Weights>(production);
  const [boost, setBoost] = useState('');
  const [adding, setAdding] = useState('');

  const tweaks = session.columns.filter((c) => !c.is_baseline);
  const selected = tweaks.find((c) => c.id === selectedId);

  // Selecting a tweak loads its settings, so the next change builds on it.
  useEffect(() => {
    if (!selected) return;
    setEnv(selected.environment);
    setWeights(selected.params.qf ? parseQf(selected.params.qf) : production);
    setBoost(selected.params.boost ?? '');
  }, [selected?.id]);

  const weightsChanged = !sameWeights(weights, production);
  const nothingChanged = !weightsChanged && !boost.trim() && env === config.baseline_environment;
  const invalid = weights.some((w) => !(Number(w.weight) > 0));

  const run = useMutation(
    () =>
      api.tweak(session.id, {
        env,
        qf: weightsChanged ? weights.map((w) => `${w.field}^${Number(w.weight)}`).join(' ') : undefined,
        boost: boost.trim() || undefined,
      }),
    {
      onSuccess: (next) => {
        queryClient.setQueryData(['session', session.id], next);
        const newest = next.columns[next.columns.length - 1];
        onSelect(newest.id);
      },
    },
  );

  const unused = config.qf_fields.filter((f) => !weights.some((w) => w.field === f));
  const prodWeight = Object.fromEntries(production.map((w) => [w.field, w.weight]));

  return (
    <Stack spacing={3}>
      <Box>
        <Text fontWeight="bold" fontSize="lg">
          Tweak the search
        </Text>
        <Text fontSize="sm" color="gray.600">
          Every tweak is compared with production's default ranking.
        </Text>
      </Box>
      <Accordion allowMultiple defaultIndex={[0, 1]} variant="abs-resources">
        <RailItem title="Field weights (qf)">
          <Stack spacing={1}>
            {weights.map((w, i) => {
              const changed = prodWeight[w.field] === undefined || Number(prodWeight[w.field]) !== Number(w.weight);
              return (
                <HStack key={w.field} spacing={2}>
                  <Text as="label" htmlFor={`w-${w.field}`} flex="1" fontSize="sm" fontWeight={changed ? 'bold' : 'normal'}>
                    {w.field}
                    {changed && prodWeight[w.field] !== undefined && (
                      <Text as="span" fontWeight="normal" color="gray.600">
                        {' '}
                        (was {prodWeight[w.field]})
                      </Text>
                    )}
                  </Text>
                  <NumberInput
                    size="sm"
                    w="5.5rem"
                    min={0}
                    step={0.1}
                    value={w.weight}
                    onChange={(value) =>
                      setWeights(weights.map((x, j) => (j === i ? { ...x, weight: value } : x)))
                    }
                    isInvalid={!(Number(w.weight) > 0)}
                  >
                    <NumberInputField id={`w-${w.field}`} />
                  </NumberInput>
                  <IconButton
                    aria-label={`Stop searching ${w.field}`}
                    title={`Stop searching ${w.field}`}
                    icon={<CloseIcon boxSize={2} />}
                    size="xs"
                    variant="ghost"
                    colorScheme="gray"
                    onClick={() => setWeights(weights.filter((_, j) => j !== i))}
                  />
                </HStack>
              );
            })}
            <HStack pt={2}>
              <NativeSelect
                size="sm"
                aria-label="Add a field"
                placeholder="Add a field…"
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
              >
                {unused.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </NativeSelect>
              <Button
                size="sm"
                variant="outline"
                isDisabled={!adding}
                onClick={() => {
                  setWeights([...weights, { field: adding, weight: '1' }]);
                  setAdding('');
                }}
              >
                Add
              </Button>
            </HStack>
            {weightsChanged && (
              <Button size="xs" variant="link" alignSelf="start" mt={1} onClick={() => setWeights(production)}>
                Reset to production's weights
              </Button>
            )}
          </Stack>
        </RailItem>
        <RailItem title="Boost">
          <FormControl>
            <FormLabel htmlFor="boost" srOnly>
              Boost function
            </FormLabel>
            <Input
              id="boost"
              size="sm"
              placeholder="e.g. pow(citation_count,0.1)"
              value={boost}
              onChange={(e) => setBoost(e.target.value)}
            />
            <FormHelperText fontSize="xs">
              The API applies a boost twice and keeps cite_read_boost, so it acts like its square.
            </FormHelperText>
          </FormControl>
        </RailItem>
        <RailItem title="Environment">
          <NativeSelect size="sm" aria-label="Environment" value={env} onChange={(e) => setEnv(e.target.value)}>
            {config.environments.map((e) => (
              <option key={e.name} value={e.name}>
                {e.label}
              </option>
            ))}
          </NativeSelect>
        </RailItem>
      </Accordion>
      {run.error instanceof Error && (
        <Alert status="error" fontSize="sm">
          <AlertIcon />
          {run.error.message}
        </Alert>
      )}
      <Button
        onClick={() => run.mutate()}
        isLoading={run.isLoading}
        loadingText="Searching"
        isDisabled={nothingChanged || invalid}
        title={nothingChanged ? 'Change a weight, the boost or the environment first' : undefined}
      >
        Run tweak
      </Button>
      {tweaks.length > 0 && (
        <TweakHistory tweaks={tweaks} selectedId={selectedId} onSelect={onSelect} toSort={session.counts.unrated} />
      )}
    </Stack>
  );
}

function RailItem({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <AccordionItem>
      <AccordionButton>
        <Box as="span" flex="1" textAlign="left" fontWeight="medium" color="blue.500">
          {title}
        </Box>
        <AccordionIcon />
      </AccordionButton>
      <AccordionPanel pb={3}>{children}</AccordionPanel>
    </AccordionItem>
  );
}

const VERDICT: Record<string, { label: string; scheme: string }> = {
  better: { label: 'Better', scheme: 'green' },
  worse: { label: 'Worse', scheme: 'red' },
  same: { label: 'No change', scheme: 'gray' },
};

// Verdicts stay hidden while anything is unrated, as in the summary: a
// verdict on part of the ratings misleads.
function TweakHistory({
  tweaks,
  selectedId,
  onSelect,
  toSort,
}: {
  tweaks: Column[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  toSort: number;
}) {
  const colors = useColorModeColors();
  return (
    <Box>
      <Text fontWeight="bold" mb={1}>
        Tweaks
      </Text>
      <Stack spacing={1} as="ol" listStyleType="none">
        {[...tweaks].reverse().map((t) => {
          const verdict = !toSort && t.metrics?.verdict ? VERDICT[t.metrics.verdict] : null;
          const isSelected = t.id === selectedId;
          return (
            <Box as="li" key={t.id}>
              <Button
                variant="unstyled"
                display="block"
                w="full"
                h="auto"
                textAlign="left"
                whiteSpace="normal"
                fontWeight="normal"
                border="1px"
                borderColor={isSelected ? 'blue.500' : colors.border}
                bg={isSelected ? 'blue.50' : 'transparent'}
                borderRadius="md"
                px={2}
                py={1.5}
                onClick={() => onSelect(t.id)}
                aria-current={isSelected}
              >
                <Text fontSize="sm" noOfLines={2}>
                  {t.changes.join(', ') || 'Same as production'}
                </Text>
                <Flex gap={2} mt={1} align="center">
                  {t.status === 'error' ? (
                    <Badge colorScheme="red" variant="subtle" textTransform="none">
                      Failed
                    </Badge>
                  ) : verdict ? (
                    <Badge colorScheme={verdict.scheme} variant="subtle" textTransform="none">
                      {verdict.label}
                    </Badge>
                  ) : (
                    <Badge variant="outline" colorScheme="gray" textTransform="none">
                      {toSort ? 'Sort to see' : 'Not rated yet'}
                    </Badge>
                  )}
                  {verdict && t.metrics?.delta != null && (
                    <Text fontSize="xs" color="gray.600">
                      {signed(t.metrics.delta)} {t.metrics.headline_label}
                    </Text>
                  )}
                </Flex>
              </Button>
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}
