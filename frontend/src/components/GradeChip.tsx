import { Badge } from '@chakra-ui/react';
import { Grade, RatingMode } from '../api';

// Grades are always spelled out, never colour alone. Subtle badges keep dark
// text on a light fill, which passes contrast at small sizes.
const GRADED: Record<number, { label: string; scheme: string }> = {
  3: { label: '3 · Highly relevant', scheme: 'green' },
  2: { label: '2 · Relevant', scheme: 'teal' },
  1: { label: '1 · Somewhat', scheme: 'yellow' },
  0: { label: '0 · Not relevant', scheme: 'red' },
};
const BINARY: Record<number, { label: string; scheme: string }> = {
  3: { label: 'Right person', scheme: 'green' },
  0: { label: 'Wrong person', scheme: 'red' },
};

export function GradeChip({ grade, mode = 'graded', short = false }: { grade: Grade; mode?: RatingMode; short?: boolean }) {
  if (grade === null) {
    return (
      <Badge variant="outline" colorScheme="gray" fontWeight="normal" textTransform="none">
        Unrated
      </Badge>
    );
  }
  if (grade === 'skip') {
    return (
      <Badge variant="subtle" colorScheme="gray" textTransform="none">
        Can't judge
      </Badge>
    );
  }
  const spec = (mode === 'binary' ? BINARY : GRADED)[grade] ?? GRADED[grade];
  return (
    <Badge variant="subtle" colorScheme={spec.scheme} textTransform="none" title={spec.label} aria-label={spec.label}>
      {short && mode === 'graded' ? String(grade) : spec.label}
    </Badge>
  );
}
