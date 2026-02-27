import type { AppStateStatus } from 'react-native';
import { AppState } from 'react-native';

import { spanContext } from '../context/span-context';
import { Meter } from '../core/meter';

export function installLifecycleInstrumentation(meter: Meter): void {
  AppState.addEventListener('change', (state: AppStateStatus) => {
    spanContext.current()?.addEvent(`app.lifecycle.${state}`, {
      'app.state': state,
    });

    if (state === 'background') {
      meter.flush();
    }
  });
}
