/**
 * Settings, grouped iOS-style: surface cards with hairline rows. It reports the real connection status
 * and the stored device identity, offers a local notification toggle (wiring for wake-on-approval
 * lands with push registration next), and ends with the destructive unpair action, which clears the
 * secure identity and returns to pairing.
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { AppBar } from '@/components/app-bar';
import { ErrorBanner } from '@/components/error-banner';
import { Screen } from '@/components/screen';
import { useIntervalNow } from '@/hooks/use-interval-now';
import { useFleetStore, type FleetStatus } from '@/store/fleet-store';
import { colors, radius, spacing, typography } from '@/theme/tokens';
import { formatRelative, shortId } from '@/utils/format';

const STATUS_LABEL: Record<FleetStatus, { label: string; color: string }> = {
  connected: { label: 'Connected', color: colors.ok },
  connecting: { label: 'Connecting', color: colors.accent },
  disconnected: { label: 'Offline', color: colors.mut },
  unpaired: { label: 'Not paired', color: colors.mut },
};

export default function SettingsScreen() {
  const router = useRouter();
  const now = useIntervalNow(1000);

  const device = useFleetStore((state) => state.device);
  const status = useFleetStore((state) => state.status);
  const sessions = useFleetStore((state) => state.fleet.sessions);
  const unpair = useFleetStore((state) => state.unpair);

  const [wakeForApprovals, setWakeForApprovals] = useState(true);

  const lastActivity = Object.values(sessions).reduce<number>((max, session) => Math.max(max, session.lastActivityAt), 0);
  const statusInfo = STATUS_LABEL[status];

  const onUnpair = async () => {
    await unpair();
    router.replace('/pair');
  };

  return (
    <Screen>
      <AppBar title="Settings" />
      <ErrorBanner />
      <ScrollView contentContainerStyle={styles.content}>
        <Group title="Daemon">
          <Row
            label="Connection"
            value={
              <View style={styles.statusValue}>
                <View style={[styles.dot, { backgroundColor: statusInfo.color }]} />
                <Text style={[styles.value, { color: statusInfo.color }]}>{statusInfo.label}</Text>
              </View>
            }
          />
          <Row label="Address" value={<Text style={styles.mono} numberOfLines={1}>{device?.record.daemonAddress ?? 'unknown'}</Text>} />
          <Row
            label="Last activity"
            value={<Text style={styles.value}>{lastActivity > 0 ? formatRelative(lastActivity, now) : 'no activity yet'}</Text>}
            last
          />
        </Group>

        <Group title="This device">
          <Row label="Name" value={<Text style={styles.value}>{device?.deviceName ?? 'this device'}</Text>} />
          <Row label="Device ID" value={<Text style={styles.mono}>{device ? shortId(device.record.deviceId) : 'unknown'}</Text>} />
          <Row
            label="Paired"
            value={<Text style={styles.value}>{device ? new Date(device.pairedAt).toLocaleDateString() : 'unknown'}</Text>}
            last
          />
        </Group>

        <Group title="Notifications">
          <Row
            label="Wake me for approvals"
            value={
              <Switch
                value={wakeForApprovals}
                onValueChange={setWakeForApprovals}
                trackColor={{ true: colors.accent, false: colors.line }}
                thumbColor={colors.hi}
                accessibilityLabel="Wake me for approvals"
              />
            }
            last
          />
        </Group>

        <Group>
          <Row
            label="Unpair this device"
            destructive
            onPress={onUnpair}
            accessibilityLabel="Unpair this device"
            last
          />
        </Group>
      </ScrollView>
    </Screen>
  );
}

interface GroupProps {
  title?: string;
  children: ReactNode;
}

function Group({ title, children }: GroupProps) {
  return (
    <View style={styles.group}>
      {title ? <Text style={styles.groupTitle}>{title}</Text> : null}
      <View style={styles.groupBody}>{children}</View>
    </View>
  );
}

interface RowProps {
  label: string;
  value?: ReactNode;
  onPress?: () => void;
  destructive?: boolean;
  last?: boolean;
  accessibilityLabel?: string;
}

function Row({ label, value, onPress, destructive = false, last = false, accessibilityLabel }: RowProps) {
  const inner = (
    <>
      <Text style={[styles.rowLabel, destructive && styles.destructive]}>{label}</Text>
      {value}
    </>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        style={({ pressed }) => [styles.row, !last && styles.rowDivider, pressed && styles.rowPressed]}
      >
        {inner}
      </Pressable>
    );
  }

  return <View style={[styles.row, !last && styles.rowDivider]}>{inner}</View>;
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.lg,
    gap: spacing.xl,
  },
  group: {
    gap: spacing.sm,
  },
  groupTitle: {
    ...typography.micro,
    marginLeft: spacing.xs,
  },
  groupBody: {
    backgroundColor: colors.surface1,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    overflow: 'hidden',
  },
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  rowPressed: {
    backgroundColor: colors.surface2,
  },
  rowLabel: {
    ...typography.body,
    flexShrink: 1,
  },
  destructive: {
    color: colors.err,
  },
  value: {
    ...typography.bodyMuted,
    flexShrink: 1,
    textAlign: 'right',
  },
  mono: {
    ...typography.mono,
    flexShrink: 1,
    textAlign: 'right',
  },
  statusValue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
