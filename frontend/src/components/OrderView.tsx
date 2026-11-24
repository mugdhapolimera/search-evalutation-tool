import { DragHandleIcon } from '@chakra-ui/icons';
import { Alert, AlertIcon, Badge, Box, Flex, Heading, HStack, Skeleton, Stack, Text, useToast } from '@chakra-ui/react';
import {
  closestCenter,
  DndContext,
  DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Ideal, IdealRecord, Session } from '../api';
import { useColorModeColors } from '../scix/useColorModeColors';

// The ideal ranking: rated records grouped by rating. Dragging reorders a
// record within its group. Each group is its own drag area, so a record can't
// be dropped into another group; changing its rating is how it moves across,
// because an order that contradicts the ratings is meaningless (synthesis R1).
export function OrderView({ session }: { session: Session }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const key = ['ideal', session.id, session.counts.rated, session.counts.skipped];
  const { data: ideal, isLoading } = useQuery(key, () => api.ideal(session.id));
  const save = useMutation((order: string[]) => api.setIdeal(session.id, order), {
    onSuccess: (next) => queryClient.setQueryData(key, next),
    onError: (error: Error) => {
      toast({ status: 'error', title: 'Order not saved', description: error.message });
      queryClient.invalidateQueries(key);
    },
  });

  if (isLoading || !ideal) return <Skeleton height="16rem" />;
  if (ideal.buckets.length === 0) {
    return (
      <Alert status="info" borderRadius="md">
        <AlertIcon />
        Rate some records first. Rated records appear here grouped by rating, ready to put in order.
      </Alert>
    );
  }

  const reorder = (grade: number, records: IdealRecord[]) => {
    const next: Ideal = {
      ...ideal,
      buckets: ideal.buckets.map((b) => (b.grade === grade ? { ...b, records, ordered: true } : b)),
    };
    queryClient.setQueryData(key, next);
    save.mutate(next.buckets.flatMap((b) => b.records.map((r) => r.bibcode)));
  };

  return (
    <Stack spacing={5}>
      <Text fontSize="sm" color="gray.600">
        Drag records by the handle to put the most useful first within each rating. With a keyboard, focus a
        handle, press Space, move with the arrow keys and press Space again. To move a record to another group,
        change its rating. Ordering is optional: a group you leave alone counts as a tie.
      </Text>
      {ideal.buckets.map((bucket) => (
        <Box as="section" key={bucket.grade} aria-label={bucket.label}>
          <HStack mb={2}>
            <Heading as="h3" size="sm">
              {bucket.label}
            </Heading>
            <Badge variant={bucket.ordered ? 'subtle' : 'outline'} colorScheme={bucket.ordered ? 'blue' : 'gray'} textTransform="none">
              {bucket.ordered ? 'Your order' : 'Tied'}
            </Badge>
          </HStack>
          <Bucket records={bucket.records} onReorder={(records) => reorder(bucket.grade, records)} />
        </Box>
      ))}
      {ideal.skipped.length > 0 && (
        <Box>
          <Heading as="h3" size="sm" mb={2}>
            Can't judge
          </Heading>
          <Stack as="ul" listStyleType="none" spacing={1} fontSize="sm">
            {ideal.skipped.map((r) => (
              <Box as="li" key={r.bibcode}>
                <Text as="span" dangerouslySetInnerHTML={{ __html: r.title ?? r.bibcode }} />
                {r.note && (
                  <Text as="span" color="gray.600">
                    {' '}
                    · {r.note}
                  </Text>
                )}
              </Box>
            ))}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}

function Bucket({ records, onReorder }: { records: IdealRecord[]; onReorder: (records: IdealRecord[]) => void }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = records.map((r) => r.bibcode);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    onReorder(arrayMove(records, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <Stack as="ol" spacing={1} listStyleType="none">
          {records.map((r, i) => (
            <SortableRow key={r.bibcode} record={r} position={i + 1} />
          ))}
        </Stack>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({ record, position }: { record: IdealRecord; position: number }) {
  const colors = useColorModeColors();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: record.bibcode,
  });
  const title = (record.title ?? record.bibcode).replace(/<[^>]+>/g, '');
  return (
    <Flex
      as="li"
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      align="center"
      gap={3}
      border="1px"
      borderColor={isDragging ? 'blue.500' : colors.border}
      borderRadius="md"
      bg={isDragging ? 'blue.50' : 'white'}
      px={2}
      py={2}
      zIndex={isDragging ? 1 : undefined}
      position="relative"
    >
      <Box
        as="button"
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Move ${title}`}
        cursor="grab"
        p={1}
        borderRadius="sm"
        _focusVisible={{ boxShadow: 'outline' }}
        lineHeight={0}
      >
        <DragHandleIcon color="gray.500" />
      </Box>
      <Text color="gray.600" fontSize="sm" minW="1.5rem">
        {position}
      </Text>
      <Box minW={0}>
        <Text fontWeight="semibold" color="blue.500" dangerouslySetInnerHTML={{ __html: record.title ?? record.bibcode }} />
        <Text fontSize="xs" color={colors.lightText}>
          {[record.year, record.pub].filter(Boolean).join(' · ')}
        </Text>
      </Box>
    </Flex>
  );
}
