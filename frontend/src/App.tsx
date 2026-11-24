import { Box, Container, Heading, Link, Text } from '@chakra-ui/react';
import { Link as RouterLink, Route, Routes } from 'react-router-dom';
import { NavBar } from './components/NavBar';
import { Home } from './pages/Home';
import { Workspace } from './pages/Workspace';

export function App() {
  return (
    <Box minH="100vh" display="flex" flexDirection="column">
      <NavBar />
      <Container maxW="1680px" px={{ base: 4, md: 6 }} pb={16} flex="1" as="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/sessions/:id" element={<Workspace />} />
          <Route
            path="*"
            element={
              <Box mt={10}>
                <Heading size="md">Page not found</Heading>
                <Text mt={2}>
                  <Link as={RouterLink} to="/">
                    Start a new search
                  </Link>
                </Text>
              </Box>
            }
          />
        </Routes>
      </Container>
    </Box>
  );
}
