/**
 * The session state indicator: a coloured label on a ~15% wash of its own colour, with a 6px LED dot.
 * For live states (working, waiting_approval) the dot pulses, unless the OS "reduce motion" setting is
 * on, in which case it holds steady. The colour, label, and whether it pulses all come from stateColor,
 * so the mapping has one home.
 */
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import type { SessionState } from '@claude-code-remote/protocol';
import { alpha, radius, spacing, stateColor, typography } from '@/theme/tokens';
import { useReducedMotion } from '@/hooks/use-reduced-motion';

interface StatePillProps {
  state: SessionState;
}

export function StatePill({ state }: StatePillProps) {
  const { color, label, pulse } = stateColor(state);
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(1);

  const shouldPulse = pulse && !reducedMotion;

  useEffect(() => {
    if (shouldPulse) {
      opacity.value = withRepeat(withTiming(0.3, { duration: 700, easing: Easing.inOut(Easing.quad) }), -1, true);
    } else {
      cancelAnimation(opacity);
      opacity.value = 1;
    }
    return () => cancelAnimation(opacity);
  }, [shouldPulse, opacity]);

  const dotStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <View
      style={[styles.pill, { backgroundColor: alpha(color, 0.15) }]}
      accessibilityRole="text"
      accessibilityLabel={`Status: ${label}`}
    >
      <Animated.View style={[styles.led, { backgroundColor: color }, dotStyle]} />
      <Text style={[typography.micro, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    gap: spacing.xs,
  },
  led: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
