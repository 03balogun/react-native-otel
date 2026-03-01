import { Linking } from 'react-native';
import { Tracer } from '../core/tracer';

export interface LinkingInstrumentation {
  /** Remove the Linking listener and clean up. */
  uninstall: () => void;
}

/**
 * Creates a span for every deep link that opens the app, and optionally
 * records push-notification payloads as span events.
 *
 * Usage:
 * ```ts
 * const linking = createLinkingInstrumentation(tracer);
 * // later, when shutting down:
 * linking.uninstall();
 * ```
 */
export function createLinkingInstrumentation(
  tracer: Tracer
): LinkingInstrumentation {
  const subscription = Linking.addEventListener(
    'url',
    (event: { url: string }) => {
      const span = tracer.startSpan('app.deep_link', {
        kind: 'SERVER',
        attributes: {
          'app.link.url': event.url,
        },
        parent: null,
      });
      span.end();
    }
  );

  // Record the initial URL if the app was opened via a deep link.
  Linking.getInitialURL()
    .then((url) => {
      if (url) {
        const span = tracer.startSpan('app.deep_link.initial', {
          kind: 'SERVER',
          attributes: {
            'app.link.url': url,
            'app.link.initial': true,
          },
          parent: null,
        });
        span.end();
      }
    })
    .catch(() => {
      // Ignore — not all platforms support getInitialURL.
    });

  return {
    uninstall: () => {
      subscription.remove();
    },
  };
}

/**
 * Record a push-notification payload as a span event on the currently
 * active span, or as a standalone root span when there is no active span.
 */
export function recordPushNotification(
  tracer: Tracer,
  payload: Record<string, unknown>
): void {
  const span = tracer.startSpan('app.push_notification', {
    kind: 'SERVER',
    attributes: {
      'messaging.system': 'push',
    },
    parent: null,
  });
  span.addEvent(
    'push_notification.received',
    payload as Record<string, string | number | boolean>
  );
  span.end();
}
