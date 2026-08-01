/**
 * The fleet: every live session, most recently active first. When approvals are waiting, a single
 * coral card sits above the list and routes to the Approvals tab with a live countdown to the soonest
 * auto-deny. Each session card taps through to its detail. Empty, connecting, and offline states are
 * all shown honestly from real store state, never faked.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import Feather from '@expo/vector-icons/Feather';
import type { SessionInfo } from '@claude-code-remote/protocol';
import { AppBar } from '@/components/app-bar';
import { Card } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { ErrorBanner } from '@/components/error-banner';
import { IconButton } from '@/components/icon-button';
import { Screen } from '@/components/screen';
import { StatePill } from '@/components/state-pill';
import { useIntervalNow } from '@/hooks/use-interval-now';
import { pendingApprovals, pendingCount, sessionList } from '@/core/state/fleetState';
import { useFleetStore } from '@/store/fleet-store';
import { colors, monoFamily, spacing, typography } from '@/theme/tokens';
import { formatCountdown, formatRelative } from '@/utils/format';

export default function FleetScreen() {
  const router = useRouter();
  const now = useIntervalNow(1000);

  const sessions = useFleetStore(useShallow((state) => sessionList(state.fleet)));
  const approvals = useFleetStore(useShallow((state) => pendingApprovals(state.fleet)));
  const approvalCount = useFleetStore((state) => pendingCount(state.fleet));
  const status = useFleetStore((state) => state.status);
  const refreshList = useFleetStore((state) => state.refreshList);

  const [refreshing, setRefreshing] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    refreshList();
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => setRefreshing(false), 700);
  }, [refreshList]);

  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  const soonestDeadline = approvals.length > 0 ? approvals[0].deadlineAt : null;

  const header =
    approvalCount > 0 ? (
      <Card
        onPress={() => router.push('/(tabs)/approvals')}
        accessibilityLabel={`${approvalCount} approvals waiting. Open approvals.`}
        borderColor={colors.urgent}
        style={styles.attention}
      >
        <View style={styles.attentionRow}>
          <Feather name="alert-circle" size={20} color={colors.urgent} />
          <View style={styles.attentionText}>
            <Text style={styles.attentionTitle}>
              {approvalCount} {approvalCount === 1 ? 'approval' : 'approvals'} waiting
            </Text>
            {soonestDeadline !== null ? (
              <Text style={styles.attentionSubtitle}>
                soonest denies in {formatCountdown(soonestDeadline - now)}
              </Text>
            ) : null}
          </View>
          <Feather name="chevron-right" size={20} color={colors.urgent} />
        </View>
      </Card>
    ) : null;

  return (
    <Screen>
      <AppBar
        title="Sessions"
        right={
          <>
            <IconButton icon="search" accessibilityLabel="Search sessions" onPress={() => undefined} />
            <IconButton icon="plus" accessibilityLabel="New session" onPress={() => undefined} />
          </>
        }
      />
      <ErrorBanner />
      {status !== 'connected' ? <ConnectionNote status={status} /> : null}

      <FlashList
        style={styles.list}
        data={sessions}
        // `now` ticks every second and drives the header auto-deny countdown and each row's relative
        // time, but it lives outside `data`; FlashList re-renders cells only when data/extraData
        // changes, so without this the countdowns and timestamps freeze between store events.
        extraData={now}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <SessionRow session={item} now={now} onPress={() => router.push(`/session/${item.id}`)} />
        )}
        ListHeaderComponent={header}
        ItemSeparatorComponent={Separator}
        ListEmptyComponent={
          <EmptyState
            icon="cpu"
            title="No sessions yet"
            subtitle="Sessions you start on your machine show up here."
          />
        }
        contentContainerStyle={styles.listContent}
        refreshing={refreshing}
        onRefresh={onRefresh}
      />
    </Screen>
  );
}

interface SessionRowProps {
  session: SessionInfo;
  now: number;
  onPress: () => void;
}

function SessionRow({ session, now, onPress }: SessionRowProps) {
  return (
    <Card onPress={onPress} accessibilityLabel={`Session ${session.label}, ${session.state}`}>
      <View style={styles.rowTop}>
        <Text style={styles.label} numberOfLines={1}>
          {session.label}
        </Text>
        <StatePill state={session.state} />
      </View>
      <Text style={styles.cwd} numberOfLines={1} ellipsizeMode="head">
        {session.cwd}
      </Text>
      <View style={styles.rowBottom}>
        <Text style={styles.model} numberOfLines={1}>
          {session.model ?? 'model pending'}
        </Text>
        <Text style={styles.activity}>{formatRelative(session.lastActivityAt, now)}</Text>
      </View>
    </Card>
  );
}

function ConnectionNote({ status }: { status: string }) {
  const label = status === 'connecting' ? 'Connecting to your daemon...' : 'Offline. Reconnects when the app is in front.';
  return (
    <View style={styles.connectionNote}>
      <Feather name={status === 'connecting' ? 'loader' : 'wifi-off'} size={14} color={colors.lo} />
      <Text style={styles.connectionText}>{label}</Text>
    </View>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  list: {
    flex: 1,
  },
  listContent: {
    padding: spacing.lg,
  },
  separator: {
    height: spacing.md,
  },
  attention: {
    marginBottom: spacing.md,
  },
  attentionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  attentionText: {
    flex: 1,
    gap: spacing.xs / 2,
  },
  attentionTitle: {
    ...typography.bodyStrong,
    color: colors.urgent,
  },
  attentionSubtitle: {
    ...typography.bodyMuted,
    fontFamily: monoFamily,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  label: {
    ...typography.title,
    flex: 1,
  },
  cwd: {
    ...typography.mono,
    marginTop: spacing.sm,
  },
  rowBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  model: {
    ...typography.mono,
    color: colors.mut,
    flex: 1,
  },
  activity: {
    ...typography.bodyMuted,
  },
  connectionNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  connectionText: {
    ...typography.bodyMuted,
  },
});
