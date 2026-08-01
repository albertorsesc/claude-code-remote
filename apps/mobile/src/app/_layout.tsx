/**
 * Root layout: the app-wide providers and the top-level stack. It also bootstraps the store, reading
 * the secure identity once and then opening the connection (a no-op when unpaired). The stack is
 * header-less; each screen draws its own app bar on the shared dark background.
 */
import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFleetStore } from '@/store/fleet-store';
import { colors } from '@/theme/tokens';

export default function RootLayout() {
  const hydrate = useFleetStore((state) => state.hydrate);
  const connect = useFleetStore((state) => state.connect);

  useEffect(() => {
    void (async () => {
      await hydrate();
      await connect();
    })();
  }, [hydrate, connect]);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg },
          }}
        />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = {
  root: { flex: 1, backgroundColor: colors.bg },
} as const;
