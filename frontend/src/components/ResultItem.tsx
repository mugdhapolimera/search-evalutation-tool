import { Box, Flex, Link, Stack, Text } from '@chakra-ui/react';
import { ReactNode } from 'react';
import { Authors } from '../api';
import { useColorModeColors } from '../scix/useColorModeColors';

interface Props {
  bibcode: string;
  title: string | null;
  authors: Authors;
  year: string | null;
  pub: string | null;
  gutter?: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
  isFocused?: boolean;
}

// SciX's result item (nectar ResultList/Item/Item.tsx): a bordered card with a
// grey gutter on the left, a blue title link, the author line, and a small
// "date · journal" line. The gutter holds the rank and rating here.
export function ResultItem({ bibcode, title, authors, year, pub, gutter, aside, children, isFocused }: Props) {
  const colors = useColorModeColors();
  const more = authors.total - authors.shown.length;
  return (
    <Flex
      as="article"
      direction="row"
      border="1px"
      borderColor={isFocused ? 'blue.500' : colors.border}
      boxShadow={isFocused ? '0 0 0 1px var(--chakra-colors-blue-500)' : undefined}
      mb={1}
      borderRadius="md"
      data-bibcode={bibcode}
    >
      {gutter !== undefined && (
        <Flex
          direction="column"
          backgroundColor={colors.panel}
          justifyContent="center"
          alignItems="center"
          gap={1}
          px={2}
          py={2}
          borderLeftRadius="md"
          w="88px"
          flexShrink={0}
          textAlign="center"
        >
          {gutter}
        </Flex>
      )}
      <Stack direction="column" width="full" minW={0} spacing={0} mx={3} my={2}>
        <Flex justifyContent="space-between" gap={2}>
          <Link
            href={`https://scixplorer.org/abs/${encodeURIComponent(bibcode)}/abstract`}
            isExternal
            fontWeight="semibold"
            dangerouslySetInnerHTML={{ __html: title ?? bibcode }}
          />
          {aside && <Box flexShrink={0}>{aside}</Box>}
        </Flex>
        {authors.total > 0 && (
          <Text fontSize="sm" mt={0.5}>
            {authors.shown.join('; ')}
            {more > 0 && <Text as="span" fontStyle="italic"> and {more} more</Text>}
          </Text>
        )}
        <Flex fontSize="xs" mt={0.5} color={colors.lightText} wrap="wrap">
          {year}
          {year && pub ? <Text px="2">·</Text> : null}
          <Text as="span" noOfLines={1}>
            {pub}
          </Text>
        </Flex>
        {children}
      </Stack>
    </Flex>
  );
}
