import { ErrorBoundary } from '@/components/error-boundary';
import SessionDetailScreen from '@/screens/session-detail';

export default function SessionRoute() {
  return (
    <ErrorBoundary>
      <SessionDetailScreen />
    </ErrorBoundary>
  );
}
