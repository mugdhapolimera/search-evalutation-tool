import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export const useConfig = () => useQuery(['config'], api.config, { staleTime: Infinity });
