import { useContext } from 'react'

import { OtelContext, OtelContextValue } from './OtelProvider'

export function useOtel(): OtelContextValue {
  const ctx = useContext(OtelContext)
  if (!ctx) {
    throw new Error('[rn-otel] useOtel must be used inside OtelProvider.')
  }
  return ctx
}
