import { ATTR_APP_SCREEN_NAME } from '@opentelemetry/semantic-conventions/incubating';

import { spanContext } from '../context/span-context';
import { Span, NoopSpan } from '../core/span';
import { Tracer } from '../core/tracer';

// Keyed by React Navigation route key — handles modals + tabs coexisting
const screenSpans = new Map<string, Span | NoopSpan>();

export function createNavigationInstrumentation(tracer: Tracer) {
  return {
    onRouteChange(
      currentName: string,
      previousName: string | undefined,
      currentKey: string,
      previousKey: string | undefined,
      params?: Record<string, unknown>
    ): void {
      // End previous screen span looked up by key (not stack pop)
      if (previousKey) {
        const prevSpan = screenSpans.get(previousKey);
        if (prevSpan) {
          prevSpan.end();
          screenSpans.delete(previousKey);
        }
      }

      // Start new screen span
      const span = tracer.startSpan(`screen.${currentName}`, {
        kind: 'INTERNAL',
        attributes: {
          [ATTR_APP_SCREEN_NAME]: currentName, // 'app.screen.name'
          'app.screen.previous_name': previousName ?? '', // custom
          ...(params ? { 'app.screen.params': JSON.stringify(params) } : {}), // custom
        },
      });

      screenSpans.set(currentKey, span);
      spanContext.setCurrent(span);
    },

    endCurrentScreen(): void {
      const current = spanContext.current();
      if (current) {
        current.end();
        // Remove from map
        for (const [key, span] of screenSpans.entries()) {
          if (span === current) {
            screenSpans.delete(key);
            break;
          }
        }
        spanContext.setCurrent(undefined);
      }
    },
  };
}

export type NavigationInstrumentation = ReturnType<
  typeof createNavigationInstrumentation
>;
