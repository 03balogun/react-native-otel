/**
 * Expo Router instrumentation — optional adapter.
 *
 * This module requires `expo-router` as a peer dependency. It is intentionally
 * NOT re-exported from the main index.ts so that apps without expo-router
 * don't need to install it.
 *
 * Usage (in your root layout, e.g. app/_layout.tsx):
 * ```tsx
 * import { useExpoRouterInstrumentation } from 'react-native-otel/src/instrumentation/expo-router';
 * import { otel } from 'react-native-otel';
 *
 * export default function RootLayout() {
 *   useExpoRouterInstrumentation(otel.getTracer());
 *   return <Slot />;
 * }
 * ```
 *
 * The hook creates a new span on every route change and ends the previous one.
 * Requires: expo-router ^3 or ^4 (usePathname / useSegments hooks).
 */

// We use dynamic require so that bundlers can tree-shake this when expo-router
// is not installed.  The try/catch provides a helpful error at runtime.
let usePathname: (() => string) | undefined;
let useSegments: (() => string[]) | undefined;
let useEffect:
  | ((effect: () => void | (() => void), deps?: unknown[]) => void)
  | undefined;
let useRef: (<T>(initial: T) => { current: T }) | undefined;

try {
  const expoRouter = require('expo-router') as {
    usePathname: () => string;
    useSegments: () => string[];
  };
  usePathname = expoRouter.usePathname;
  useSegments = expoRouter.useSegments;

  const react = require('react') as {
    useEffect: typeof import('react').useEffect;
    useRef: typeof import('react').useRef;
  };
  useEffect = react.useEffect;
  useRef = react.useRef;
} catch {
  // expo-router not installed — useExpoRouterInstrumentation will throw.
}

import type { Tracer } from '../core/tracer';
import type { Span, NoopSpan } from '../core/span';

/**
 * React hook that tracks Expo Router navigation as OTel spans.
 * Each route change ends the previous route span and starts a new one.
 *
 * Must be called inside a component that is rendered within the expo-router
 * provider (e.g. the root layout).
 */
export function useExpoRouterInstrumentation(tracer: Tracer): void {
  if (!usePathname || !useSegments || !useEffect || !useRef) {
    throw new Error(
      '[react-native-otel] expo-router is not installed. ' +
        'Add it as a dependency to use useExpoRouterInstrumentation.'
    );
  }

  const pathname = usePathname();
  const segments = useSegments();
  const spanRef = useRef<Span | NoopSpan | undefined>(undefined);

  useEffect(() => {
    // End the previous route span.
    spanRef.current?.end();

    const routeName = pathname || '/';
    const span = tracer.startSpan(`screen.${routeName}`, {
      kind: 'INTERNAL',
      attributes: {
        'screen.name': routeName,
        'screen.segments': segments.join('/'),
      },
      parent: null,
    });
    spanRef.current = span;

    return () => {
      span.end();
      spanRef.current = undefined;
    };
    // Re-run when the pathname changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
}
