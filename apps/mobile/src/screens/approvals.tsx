/**
 * Everything waiting on a human decision, soonest auto-deny first. Each row headlines with the tool
 * and the command (or the model's own description when it wrote one), names the session, and counts
 * down to the deadline. Tapping opens the decision screen.
 */
import { StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import type { PendingApproval, SessionInfo } from '@claude-code-remote/protocol';
import { AppBar } from '@/components/app-bar';
import { Badge } from '@/components/badge';
import { Card } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { ErrorBanner } from '@/components/error-banner';
import { Screen } from '@/components/screen';
import { useIntervalNow } from '@/hooks/use-interval-now';
import { pendingApprovals } from '@/core/state/fleetState';
import { useFleetStore } from '@/store/fleet-store';
import { colors, spacing, typography } from '@/theme/tokens';
import { firstLine, formatCountdown } from '@/utils/format';

/** The best one-line headline for an approval: the model's description, else the command, else the tool. */
function headline(approval: PendingApproval): string {
  if (approval.description) return approval.description;
  const command = approval.toolInput?.command;
  if (typeof command === 'string' && command.trim()) return firstLine(command);
  return approval.toolName;
}

export default function ApprovalsScreen() {
  const router = useRouter();
  const now = useIntervalNow(1000);

  const approvals = useFleetStore(useShallow((state) => pendingApprovals(state.fleet)));
  const sessions = useFleetStore((state) => state.fleet.sessions);

  return (
    <Screen>
      <AppBar title="Approvals" />
      <ErrorBanner />
      <FlashList
        style={styles.list}
        data={approvals}
        // Each row's per-second countdown reads `now`, which is outside `data`; FlashList only
        // re-renders cells on a data/extraData change, so this keeps the countdowns live.
        extraData={now}
        keyExtractor={(item) => item.toolUseId}
        renderItem={({ item }) => (
          <ApprovalRow
            approval={item}
            session={sessions[item.sessionId]}
            now={now}
            onPress={() => router.push(`/approval/${item.toolUseId}`)}
          />
        )}
        ItemSeparatorComponent={Separator}
        ListEmptyComponent={
          <EmptyState icon="check-circle" title="Nothing waiting on you." subtitle="Approvals appear here the moment a tool call needs a decision." />
        }
        contentContainerStyle={styles.listContent}
      />
    </Screen>
  );
}

interface ApprovalRowProps {
  approval: PendingApproval;
  session: SessionInfo | undefined;
  now: number;
  onPress: () => void;
}

function ApprovalRow({ approval, session, now, onPress }: ApprovalRowProps) {
  const remaining = approval.deadlineAt - now;
  const urgent = remaining <= 30_000;

  return (
    <Card onPress={onPress} accessibilityLabel={`Approval for ${approval.toolName} in ${session?.label ?? 'a session'}`}>
      <View style={styles.rowTop}>
        <Badge label={approval.toolName} color={colors.accent} />
        <Text style={[styles.countdown, urgent && styles.countdownUrgent]}>
          {formatCountdown(remaining)}
        </Text>
      </View>
      <Text style={styles.headline} numberOfLines={2}>
        {headline(approval)}
      </Text>
      <Text style={styles.session} numberOfLines={1}>
        {session?.label ?? approval.sessionId}
      </Text>
    </Card>
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
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  countdown: {
    ...typography.mono,
    color: colors.lo,
    fontSize: 14,
  },
  countdownUrgent: {
    color: colors.urgent,
    fontWeight: '600',
  },
  headline: {
    ...typography.body,
    marginTop: spacing.md,
  },
  session: {
    ...typography.bodyMuted,
    marginTop: spacing.sm,
  },
});
