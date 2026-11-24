import { SearchIcon } from '@chakra-ui/icons';
import { Button, Flex, HStack, IconButton, Input, InputGroup, Text, VisuallyHidden } from '@chakra-ui/react';
import { FormEvent, useState } from 'react';
import { Intent } from '../api';
import { useConfig } from '../useConfig';

interface Props {
  initialQuery?: string;
  initialIntent?: Intent;
  isLoading?: boolean;
  autoFocus?: boolean;
  onSearch: (query: string, intent: Intent) => void;
}

// SciX's search box (nectar SearchInput.tsx): one input with the search button
// attached. The row above it picks the kind of search, styled like SciX's
// quick fields, because it decides how records are rated.
export function SearchBar({ initialQuery = '', initialIntent = 'topical', isLoading, autoFocus, onSearch }: Props) {
  const { data: config } = useConfig();
  const [query, setQuery] = useState(initialQuery);
  const [intent, setIntent] = useState<Intent>(initialIntent);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim()) onSearch(query.trim(), intent);
  };

  return (
    <form onSubmit={submit} role="search">
      <HStack spacing={1} mb={1} fontSize="md" flexWrap="wrap" role="group" aria-label="Kind of search">
        <Text textTransform="uppercase" mr={2}>
          Kind of search:
        </Text>
        {(config?.intents ?? []).map((o) => (
          <Button
            key={o.value}
            variant="link"
            aria-pressed={intent === o.value}
            color={intent === o.value ? 'gray.700' : 'blue.500'}
            fontWeight={intent === o.value ? 'bold' : 'normal'}
            textDecoration={intent === o.value ? 'underline' : 'none'}
            px={2}
            onClick={() => setIntent(o.value as Intent)}
          >
            {o.label}
          </Button>
        ))}
      </HStack>
      <Flex
        sx={{ '&:has(input:focus)': { boxShadow: '0 0 0 3px rgba(66, 153, 225, 0.6)', borderRadius: 'md' } }}
      >
        <InputGroup>
          <VisuallyHidden as="label" htmlFor="search-input">
            Search
          </VisuallyHidden>
          <Input
            id="search-input"
            type="search"
            placeholder="Search..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            borderRightRadius={0}
            borderLeftRadius="md"
            _focus={{ boxShadow: 'none' }}
            autoFocus={autoFocus}
            autoComplete="off"
            spellCheck={false}
          />
        </InputGroup>
        <IconButton
          type="submit"
          aria-label="Search"
          icon={<SearchIcon />}
          borderLeftRadius={0}
          borderRightRadius="md"
          isLoading={isLoading}
        />
      </Flex>
    </form>
  );
}
