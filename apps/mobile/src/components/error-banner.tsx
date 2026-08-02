/**
 * A transient, dismissible banner for the last daemon or connection error. It reads straight from the
 * store, so any action that sets an error surfaces it wherever the banner is mounted. Tapping it
 * clears the error. Renders nothing when there is no error.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { alpha, colors, radius, spacing, typography } from '@/theme/tokens';
import { useFleetStore } from '@/store/fleet-store';

export function ErrorBanner() {
  const error = useFleetStore((state) => state.error);
  const clearError = useFleetStore((state) => state.clearError);

  if (!error) return null;

  return (
    <Pressable
      onPress={clearError}
      accessibilityRole="button"
      accessibilityLabel={`Dismiss error: ${error}`}
      style={styles.banner}
    >
      <Feather name="alert-triangle" size={16} color={colors.err} />
      <Text style={styles.text} numberOfLines={3}>
        {error}
      </Text>
      <View style={styles.dismiss}>
        <Feather name="x" size={16} color={colors.lo} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.err,
    backgroundColor: alpha(colors.err, 0.12),
  },
  text: {
    ...typography.body,
    flex: 1,
    color: colors.hi,
  },
  dismiss: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
