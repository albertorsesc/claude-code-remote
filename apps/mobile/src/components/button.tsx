/**
 * The one button. Four intents map to the Nocturne colour rules: primary is the amber accent, approve
 * is solid green, deny is an outlined red (weightier than ghost but not a solid alarm), and ghost is a
 * quiet surface. Every variant is at least 50 tall for a comfortable target and dips to 0.97 scale
 * while pressed. Colour is the only thing that changes between variants.
 */
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, typography } from '@/theme/tokens';

export type ButtonVariant = 'primary' | 'approve' | 'deny' | 'ghost';

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
}

interface VariantStyle {
  background: string;
  border: string;
  text: string;
}

const VARIANTS: Record<ButtonVariant, VariantStyle> = {
  primary: { background: colors.accent, border: colors.accent, text: colors.onAccent },
  approve: { background: colors.ok, border: colors.ok, text: colors.onOk },
  deny: { background: 'transparent', border: colors.err, text: colors.err },
  ghost: { background: colors.surface1, border: colors.line, text: colors.hi },
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  accessibilityLabel,
}: ButtonProps) {
  const palette = VARIANTS[variant];
  const isInactive = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={isInactive}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: isInactive, busy: loading }}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: palette.background, borderColor: palette.border },
        pressed && !isInactive && styles.pressed,
        isInactive && styles.inactive,
      ]}
    >
      <View style={styles.content}>
        {loading ? <ActivityIndicator color={palette.text} /> : <Text style={[styles.label, { color: palette.text }]}>{label}</Text>}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 50,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  label: {
    ...typography.bodyStrong,
    fontSize: 16,
  },
  pressed: {
    transform: [{ scale: 0.97 }],
  },
  inactive: {
    opacity: 0.5,
  },
});
