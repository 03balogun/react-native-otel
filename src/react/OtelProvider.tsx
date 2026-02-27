import React, { createContext, Component, ErrorInfo, ReactNode } from 'react';

import { OtelLogger } from '../core/log-record';
import { Meter } from '../core/meter';
import { Tracer } from '../core/tracer';
import { otel } from '../sdk';

export interface OtelContextValue {
  tracer: Tracer;
  meter: Meter;
  logger: OtelLogger;
  recordEvent: (name: string, attributes?: Record<string, unknown>) => void;
  setUser: (user: { id?: string; email?: string }) => void;
}

export const OtelContext = createContext<OtelContextValue | undefined>(
  undefined
);

interface ErrorBoundaryProps {
  children: ReactNode;
  tracer: Tracer;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

class OtelErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.tracer.recordException(error, {
      'error.source': 'react_error_boundary',
    });
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return null;
    }
    return this.props.children;
  }
}

export interface OtelProviderProps {
  children: ReactNode;
  withErrorBoundary?: boolean;
}

export function OtelProvider({
  children,
  withErrorBoundary = false,
}: OtelProviderProps): React.ReactElement {
  const tracer = otel.getTracer();
  const meter = otel.getMeter();
  const logger = otel.getLogger();

  const value: OtelContextValue = {
    tracer,
    meter,
    logger,
    recordEvent: (name, attributes) =>
      tracer.recordEvent(
        name,
        attributes as Record<
          string,
          string | number | boolean | string[] | number[] | boolean[]
        >
      ),
    setUser: (user) => otel.setUser(user),
  };

  const content = (
    <OtelContext.Provider value={value}>{children}</OtelContext.Provider>
  );

  if (withErrorBoundary) {
    return <OtelErrorBoundary tracer={tracer}>{content}</OtelErrorBoundary>;
  }

  return content;
}
