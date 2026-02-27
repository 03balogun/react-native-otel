import { useEffect, useState } from 'react';
import { Text, View, StyleSheet, TouchableOpacity } from 'react-native';
import {
  otel,
  ConsoleSpanExporter,
  ConsoleMetricExporter,
  ConsoleLogExporter,
} from 'react-native-otel';

// Initialize otel at module scope before rendering
otel.init({
  serviceName: 'react-native-otel-example',
  serviceVersion: '0.1.0',
  exporter: new ConsoleSpanExporter(),
  metricExporter: new ConsoleMetricExporter(),
  logExporter: new ConsoleLogExporter(),
  sampleRate: 1.0,
  debug: true,
});

export default function App() {
  const [screen, setScreen] = useState<'home' | 'detail'>('home');
  const [spanCount, setSpanCount] = useState(0);

  useEffect(() => {
    // Simulate a screen view span
    const tracer = otel.getTracer();
    const span = tracer.startSpan('screen.view', {
      attributes: { 'app.screen.name': screen },
    });
    span.end();
    setSpanCount((c) => c + 1);
  }, [screen]);

  const handleCustomEvent = () => {
    const tracer = otel.getTracer();
    const span = tracer.startSpan('user.action', {
      attributes: { 'action.name': 'button.press', 'action.screen': screen },
    });
    span.addEvent('button_pressed', { timestamp: Date.now() });
    span.end();
    setSpanCount((c) => c + 1);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>react-native-otel Example</Text>
      <Text style={styles.subtitle}>Check Metro console for span output</Text>

      <Text style={styles.counter}>Spans emitted: {spanCount}</Text>

      <TouchableOpacity style={styles.button} onPress={handleCustomEvent}>
        <Text style={styles.buttonText}>Emit Custom Span</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.button, styles.navButton]}
        onPress={() => setScreen(screen === 'home' ? 'detail' : 'home')}
      >
        <Text style={styles.buttonText}>
          Navigate to {screen === 'home' ? 'Detail' : 'Home'}
        </Text>
      </TouchableOpacity>

      <Text style={styles.screen}>Current screen: {screen}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#f5f5f5',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#666',
    marginBottom: 24,
    textAlign: 'center',
  },
  counter: {
    fontSize: 16,
    marginBottom: 24,
    color: '#333',
  },
  button: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: 12,
    minWidth: 220,
    alignItems: 'center',
  },
  navButton: {
    backgroundColor: '#34C759',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  screen: {
    marginTop: 16,
    fontSize: 14,
    color: '#666',
  },
});
