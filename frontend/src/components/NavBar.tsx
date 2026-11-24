import { Box, Button, Flex, HStack, Icon, Input, Popover, PopoverBody, PopoverContent, PopoverTrigger, Text } from '@chakra-ui/react';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useDiscipline, useRater } from '../prefs';
import { ScixAndTextLogo_H } from '../scix/ScixAndTextLogo-H';
import { Select, SelectOption } from '../scix/Select';
import { useConfig } from '../useConfig';

// SciX's nav bar (nectar NavBar.tsx): black bar, white logo, the discipline
// dropdown beside it, menus on the right.
export function NavBar() {
  const { data: config } = useConfig();
  const [discipline, setDiscipline] = useDiscipline();
  const options: SelectOption<string>[] = (config?.disciplines ?? []).map((d) => ({
    id: d.value,
    value: d.value,
    label: d.label,
  }));
  const selected = options.find((o) => o.value === discipline) ?? options[0];

  return (
    <Box as="nav" backgroundColor="gray.900" position="relative" zIndex="overlay">
      <Flex direction="row" alignItems="center" justifyContent="space-between" mx={4} my={2} gap={3} wrap="wrap">
        <HStack spacing={3}>
          <RouterLink to="/" aria-label="Search evaluation home">
            <Flex direction="column" alignItems="end">
              <Icon as={ScixAndTextLogo_H} width="6em" height="3em" color="gray.50" aria-hidden />
              <Text color="gray.100" fontSize="xs" mt={-3} whiteSpace="nowrap">
                search evaluation
              </Text>
            </Flex>
          </RouterLink>
          {options.length > 0 && (
            <Box width={{ base: '200px', xs: '270px' }}>
              <Select<SelectOption<string>>
                value={selected}
                options={options}
                stylesTheme="theme"
                onChange={(o) => o && setDiscipline(o.value)}
                label="Discipline"
                id="discipline-selector"
              />
            </Box>
          )}
        </HStack>
        <RaterMenu />
      </Flex>
    </Box>
  );
}

function RaterMenu() {
  const [rater, setRater] = useRater();
  const [draft, setDraft] = useState(rater ?? '');
  return (
    <Popover placement="bottom-end">
      <PopoverTrigger>
        <Button variant="ghost" color="gray.50" _hover={{ bg: 'gray.800' }} fontWeight="medium" size={{ base: 'sm', md: 'md' }} ml="auto">
          {rater ? `Rating as ${rater}` : 'Set your name'}
        </Button>
      </PopoverTrigger>
      <PopoverContent width="18rem">
        <PopoverBody>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setRater(draft.trim() || null);
            }}
          >
            <Text as="label" htmlFor="rater-name" fontWeight="bold" fontSize="sm">
              Your name, stored with each rating
            </Text>
            <HStack mt={2}>
              <Input id="rater-name" size="sm" value={draft} onChange={(e) => setDraft(e.target.value)} />
              <Button type="submit" size="sm">
                Save
              </Button>
            </HStack>
          </form>
        </PopoverBody>
      </PopoverContent>
    </Popover>
  );
}
