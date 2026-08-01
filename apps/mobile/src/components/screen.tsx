/**
 * The base screen wrapper: fills the background and insets content below the status bar / notch. Every
 * screen sits inside one of these so the app-wide background and top safe area are handled once. The
 * bottom inset is left to whichever screen needs it (a footer action bar insets itself), so scrolling
 * content can run under the home indicator.
 */
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@/theme/tokens';

interface ScreenProps {
  children: ReactNode;
  /** Apply the top safe-area inset (default true). Set false when a child owns the top edge. */
  insetTop?: boolean;
}

export function Screen({ children, insetTop = true }: ScreenProps) {
  const insets = useSafeAreaInsets();
  return <View style={[styles.root, insetTop && { paddingTop: insets.top }]}>{children}</View>;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
});
