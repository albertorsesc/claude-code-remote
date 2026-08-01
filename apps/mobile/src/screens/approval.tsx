/**
 * The decision screen. It shows exactly what a tool wants to do, how long until the bridge auto-denies
 * it, and gives two large, unambiguous choices. Allow is a solid green button on top, Deny an outlined
 * red one below, both full width and safe-area aware. An optional note travels with the decision. If
 * the request has already been resolved (decided elsewhere or expired), the screen says so instead of
 * offering stale buttons.
 */
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PendingApproval } from '@claude-code-remote/protocol';
import { AppBar } from '@/components/app-bar';
import { Badge } from '@/components/badge';
import { Button } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { Screen } from '@/components/screen';
import { useIntervalNow } from '@/hooks/use-interval-now';
import { useFleetStore } from '@/store/fleet-store';
import { colors, monoFamily, radius, spacing, typography } from '@/theme/tokens';
import { formatCountdown } from '@/utils/format';

/** The raw tool input, rendered as the command when there is one, else pretty JSON. */
function inputText(approval: PendingApproval): string {
  const command = approval.toolInput?.command;
  if (typeof command === 'string') return command;
  try {
    return JSON.stringify(approval.toolInput, null, 2);
  } catch {
    return String(approval.toolInput);
  }
}

export default function ApprovalScreen() {
  const router = useRouter();
  const { toolUseId } = useLocalSearchParams<{ toolUseId: string }>();
  const now = useIntervalNow(1000);
  const insets = useSafeAreaInsets();

  const approval = useFleetStore((state) => state.fleet.approvals[toolUseId]);
  const sessionLabel = useFleetStore((state) => (approval ? state.fleet.sessions[approval.sessionId]?.label : undefined));
  const decide = useFleetStore((state) => state.decide);

  const [note, setNote] = useState('');

  if (!approval) {
    return (
      <Screen>
        <AppBar title="Approval" onBack={() => router.back()} />
        <EmptyState
          icon="check-circle"
          title="Already handled"
          subtitle="This request was decided or it expired, so there is nothing left to do."
        />
      </Screen>
    );
  }

  const remaining = approval.deadlineAt - now;
  const window = Math.max(1, approval.deadlineAt - approval.requestedAt);
  const fraction = Math.max(0, Math.min(1, remaining / window));
  const urgent = remaining <= 30_000;
  const barColor = urgent ? colors.urgent : colors.accent;

  const submit = (decision: 'allow' | 'deny') => {
    decide(approval.toolUseId, decision, note.trim() || undefined);
    router.back();
  };

  return (
    <Screen>
      <AppBar title="Approval" onBack={() => router.back()} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top + 56}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.metaRow}>
            <Badge label={approval.toolName} color={colors.accent} />
            {sessionLabel ? <Text style={styles.session}>{sessionLabel}</Text> : null}
          </View>

          <Text style={styles.title}>{approval.description ?? approval.toolName}</Text>

          <View style={styles.codeBlock}>
            <Text style={styles.code}>{inputText(approval)}</Text>
          </View>

          <View style={styles.timer}>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${fraction * 100}%`, backgroundColor: barColor }]} />
            </View>
            <Text style={[styles.timerLabel, urgent && { color: colors.urgent }]}>
              Auto-denies in {formatCountdown(remaining)} if nobody decides
            </Text>
          </View>

          <Text style={styles.noteLabel}>Note (optional)</Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="Why you are allowing or denying"
            placeholderTextColor={colors.mut}
            multiline
            style={styles.noteInput}
            accessibilityLabel="Decision note"
          />
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
          <Button
            label="Allow"
            variant="approve"
            onPress={() => submit('allow')}
            accessibilityLabel={`Allow ${approval.toolName}`}
          />
          <View style={styles.footerGap} />
          <Button
            label="Deny"
            variant="deny"
            onPress={() => submit('deny')}
            accessibilityLabel={`Deny ${approval.toolName}`}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  scroll: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  session: {
    ...typography.micro,
  },
  title: {
    ...typography.display,
    fontSize: 22,
  },
  codeBlock: {
    backgroundColor: colors.surface2,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    padding: spacing.md,
  },
  code: {
    fontFamily: monoFamily,
    fontSize: 13,
    lineHeight: 19,
    color: colors.hi,
  },
  timer: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  track: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surface2,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: radius.pill,
  },
  timerLabel: {
    ...typography.bodyMuted,
  },
  noteLabel: {
    ...typography.micro,
    marginTop: spacing.sm,
  },
  noteInput: {
    ...typography.body,
    minHeight: 72,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.surface1,
    padding: spacing.md,
    textAlignVertical: 'top',
  },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: colors.bg,
  },
  footerGap: {
    height: spacing.md,
  },
});
