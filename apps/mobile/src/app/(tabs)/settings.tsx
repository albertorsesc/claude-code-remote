import { ErrorBoundary } from '@/components/error-boundary';
import SettingsScreen from '@/screens/settings';

export default function SettingsRoute() {
  return (
    <ErrorBoundary>
      <SettingsScreen />
    </ErrorBoundary>
  );
}
