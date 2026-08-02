/**
 * A calm, centred message for when a list is empty or a screen is not ready yet. A muted icon, a
 * title, and an optional line of context. No call to action by default: emptiness here is a normal
 * resting state, not an error.
 */
import type { ComponentProps } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { colors, spacing, typography } from '@/theme/tokens';

interface EmptyStateProps {
  icon: ComponentProps<typeof Feather>['name'];
  title: string;
  subtitle?: string;
}

export function EmptyState({ icon, title, subtitle }: EmptyStateProps) {
  return (
    <View style={styles.root}>
      <Feather name={icon} size={40} color={colors.mut} />
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xxl,
    gap: spacing.sm,
  },
  title: {
    ...typography.title,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  subtitle: {
    ...typography.bodyMuted,
    textAlign: 'center',
  },
});
