import { Text } from '@chakra-ui/react';

// Rank change against the production baseline, as text arrows so it never
// depends on colour.
export function MoveTag({ move }: { move: number | 'new' | null }) {
  if (move === null) return null;
  if (move === 'new') {
    return (
      <Text as="span" fontSize="xs" fontWeight="bold" color="blue.600" aria-label="new in the top results">
        NEW
      </Text>
    );
  }
  if (move === 0) {
    return (
      <Text as="span" fontSize="xs" color="gray.500" aria-label="same rank">
        ·
      </Text>
    );
  }
  const up = move > 0;
  return (
    <Text
      as="span"
      fontSize="xs"
      fontWeight="semibold"
      color={up ? 'green.700' : 'red.700'}
      aria-label={`${up ? 'up' : 'down'} ${Math.abs(move)}`}
    >
      {up ? '▲' : '▼'}
      {Math.abs(move)}
    </Text>
  );
}
