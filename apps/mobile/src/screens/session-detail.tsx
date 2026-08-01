/**
 * Session detail placeholder. The transcript stream and the steer/interrupt controls are the next
 * increment; for now this confirms the route, the back navigation, and shows the session it will be
 * about. The reducer already keeps a bounded transcript per session, so the data is waiting for the UI.
 */
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { AppBar } from '@/components/app-bar';
import { Badge } from '@/components/badge';
import { EmptyState } from '@/components/empty-state';
import { Screen } from '@/components/screen';
import { StatePill } from '@/components/state-pill';
import { useFleetStore } from '@/store/fleet-store';
import { colors, spacing, typography } from '@/theme/tokens';

export default function SessionDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = useFleetStore((state) => state.fleet.sessions[id]);

  return (
    <Screen>
      <AppBar title={session?.label ?? 'Session'} onBack={() => router.back()} />
      {session ? (
        <View style={styles.header}>
          <Badge label={session.model ?? 'model pending'} color={colors.lo} />
          <StatePill state={session.state} />
        </View>
      ) : null}
      {session ? <Text style={styles.cwd} numberOfLines={1} ellipsizeMode="head">{session.cwd}</Text> : null}
      <EmptyState
        icon="message-square"
        title="Session detail coming next"
        subtitle="The live transcript and steering controls land in the next increment."
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  cwd: {
    ...typography.mono,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
});
