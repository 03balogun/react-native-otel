import type { AppStateStatus } from 'react-native';
import { AppState } from 'react-native';

import { spanContext } from '../context/span-context';
import { Meter } from '../core/meter';

export function installLifecycleInstrumentation(meter: Meter): void {
  const foregroundCounter = meter.createCounter('app.foreground_count');
  const backgroundCounter = meter.createCounter('app.background_count');

  AppState.addEventListener('change', (state: AppStateStatus) => {
    spanContext.current()?.addEvent(`app.lifecycle.${state}`, {
      'app.state': state,
    });

    if (state === 'active') {
      foregroundCounter.add(1);
    } else if (state === 'background') {
      backgroundCounter.add(1);
      meter.flush();
    }
  });
}
