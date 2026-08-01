/**
 * A small chip for a short label, most often a tool name (Bash, Edit, Read). Monospace, because the
 * label is machine data, on a slightly higher surface than its surroundings.
 */
import { StyleSheet, Text, View } from 'react-native';
import { colors, monoFamily, radius, spacing } from '@/theme/tokens';

interface BadgeProps {
  label: string;
  color?: string;
}

export function Badge({ label, color = colors.hi }: BadgeProps) {
  return (
    <View style={styles.badge}>
      <Text style={[styles.text, { color }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surface2,
    borderRadius: radius.card / 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs / 2,
  },
  text: {
    fontFamily: monoFamily,
    fontSize: 12,
    fontWeight: '600',
  },
});
