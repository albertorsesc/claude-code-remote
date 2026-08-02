/**
 * A surface: the first raised step above the background, outlined by a single hairline. Depth here is
 * the surface colour and the line, never a shadow. When given onPress it becomes a Pressable row with
 * a light pressed state; otherwise it is a plain container.
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { alpha, colors, radius, spacing } from '@/theme/tokens';

interface CardProps {
  children: ReactNode;
  onPress?: () => void;
  /** Accessibility label, required when onPress is set so the row is announced. */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  /** Border colour override, for the coral "attention" card. */
  borderColor?: string;
}

export function Card({ children, onPress, accessibilityLabel, style, borderColor }: CardProps) {
  const borderStyle = borderColor ? { borderColor } : null;

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [styles.card, borderStyle, pressed && styles.pressed, style]}
      >
        {children}
      </Pressable>
    );
  }

  return <View style={[styles.card, borderStyle, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface1,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    padding: spacing.lg,
  },
  pressed: {
    backgroundColor: alpha(colors.hi, 0.04),
  },
});
