import { useContext } from 'react';

import type { OtelContextValue } from './OtelProvider';
import { OtelContext } from './OtelProvider';

export function useOtel(): OtelContextValue {
  const ctx = useContext(OtelContext);
  if (!ctx) {
    throw new Error(
      '[react-native-otel] useOtel must be used inside OtelProvider.'
    );
  }
  return ctx;
}
