/**
 * The top bar: an optional back chevron, a display-type title, and an optional cluster of right-hand
 * actions. Kept deliberately plain (no shadow, a single hairline under it) to match the Nocturne feel
 * where depth is stepped surfaces, not elevation.
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { colors, spacing, touchTarget, typography } from '@/theme/tokens';

interface AppBarProps {
  title: string;
  /** When provided, a back chevron is shown that calls this. */
  onBack?: () => void;
  /** Right-aligned actions (icon buttons, etc.). */
  right?: ReactNode;
}

export function AppBar({ title, onBack, right }: AppBarProps) {
  return (
    <View style={styles.root}>
      <View style={styles.side}>
        {onBack ? (
          <Pressable
            onPress={onBack}
            hitSlop={spacing.sm}
            style={styles.iconButton}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Feather name="chevron-left" size={26} color={colors.hi} />
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
        {title}
      </Text>
      <View style={[styles.side, styles.rightSide]}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  side: {
    minWidth: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
  },
  rightSide: {
    justifyContent: 'flex-end',
    gap: spacing.xs,
  },
  iconButton: {
    minWidth: touchTarget,
    minHeight: touchTarget,
    marginLeft: -spacing.sm,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  title: {
    ...typography.display,
    flex: 1,
    textAlign: 'center',
  },
});
