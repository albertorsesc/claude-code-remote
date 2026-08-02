/**
 * Pairing placeholder. The camera and QR decode land in the next increment; the pairing logic behind
 * it is already wired (the store's pair() action drives decodePairCode, startPairing, and
 * completePairOverWebSocket), so this screen only needs the camera to feed it a scanned code. The
 * reticle here is drawn with plain bordered Views, not SVG, matching the no-new-native-dependency rule.
 */
import { StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { AppBar } from '@/components/app-bar';
import { Screen } from '@/components/screen';
import { colors, radius, spacing, typography } from '@/theme/tokens';

export default function PairScreen() {
  return (
    <Screen>
      <AppBar title="Pair" />
      <View style={styles.body}>
        <View style={styles.reticle} accessible accessibilityLabel="QR scanner placeholder">
          <View style={[styles.corner, styles.topLeft]} />
          <View style={[styles.corner, styles.topRight]} />
          <View style={[styles.corner, styles.bottomLeft]} />
          <View style={[styles.corner, styles.bottomRight]} />
          <Feather name="maximize" size={40} color={colors.mut} />
        </View>

        <Text style={styles.title}>Scan to pair</Text>
        <Text style={styles.body_text}>
          On your machine, run the daemon and show its pairing QR. Camera scanning arrives in the next
          increment. Once it scans a code, this phone mints its identity, completes the handshake over
          your tailnet, and stores the keys in the secure enclave.
        </Text>
      </View>
    </Screen>
  );
}

const RETICLE_SIZE = 220;
const CORNER = 34;

const styles = StyleSheet.create({
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xxl,
    gap: spacing.xl,
  },
  reticle: {
    width: RETICLE_SIZE,
    height: RETICLE_SIZE,
    borderRadius: radius.sheet,
    backgroundColor: colors.surface1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  corner: {
    position: 'absolute',
    width: CORNER,
    height: CORNER,
    borderColor: colors.accent,
  },
  topLeft: {
    top: spacing.md,
    left: spacing.md,
    borderTopWidth: 2,
    borderLeftWidth: 2,
    borderTopLeftRadius: spacing.sm,
  },
  topRight: {
    top: spacing.md,
    right: spacing.md,
    borderTopWidth: 2,
    borderRightWidth: 2,
    borderTopRightRadius: spacing.sm,
  },
  bottomLeft: {
    bottom: spacing.md,
    left: spacing.md,
    borderBottomWidth: 2,
    borderLeftWidth: 2,
    borderBottomLeftRadius: spacing.sm,
  },
  bottomRight: {
    bottom: spacing.md,
    right: spacing.md,
    borderBottomWidth: 2,
    borderRightWidth: 2,
    borderBottomRightRadius: spacing.sm,
  },
  title: {
    ...typography.display,
    fontSize: 22,
    textAlign: 'center',
  },
  body_text: {
    ...typography.bodyMuted,
    textAlign: 'center',
    lineHeight: 21,
  },
});
