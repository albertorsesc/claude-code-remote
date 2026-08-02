/**
 * The entry gate. While the secure identity is still loading it shows a quiet spinner; then it routes
 * to pairing when this phone has never paired, or into the tabs when it has.
 */
import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useFleetStore } from '@/store/fleet-store';
import { colors } from '@/theme/tokens';

export default function Index() {
  const hydrated = useFleetStore((state) => state.hydrated);
  const status = useFleetStore((state) => state.status);

  if (!hydrated) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (status === 'unpaired') {
    return <Redirect href="/pair" />;
  }

  return <Redirect href="/(tabs)/sessions" />;
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
});
