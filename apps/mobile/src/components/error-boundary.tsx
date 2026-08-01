/**
 * A feature-screen error boundary. React still has no hook equivalent for componentDidCatch, so this
 * stays a class. It catches a render-time crash in a screen and shows a recoverable fallback instead
 * of a blank app, with a retry that remounts the subtree.
 */
import { Component, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '@/theme/tokens';
import { Button } from './button';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <View style={styles.root}>
        <Text style={styles.title}>This screen hit an error</Text>
        <Text style={styles.message} numberOfLines={4}>
          {error.message}
        </Text>
        <View style={styles.action}>
          <Button label="Try again" variant="ghost" onPress={this.reset} />
        </View>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.xxl,
    gap: spacing.md,
  },
  title: {
    ...typography.title,
    color: colors.err,
    textAlign: 'center',
  },
  message: {
    ...typography.bodyMuted,
    textAlign: 'center',
  },
  action: {
    marginTop: spacing.sm,
    alignSelf: 'stretch',
  },
});
