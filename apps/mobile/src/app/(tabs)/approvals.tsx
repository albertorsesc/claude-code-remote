import { ErrorBoundary } from '@/components/error-boundary';
import ApprovalsScreen from '@/screens/approvals';

export default function ApprovalsRoute() {
  return (
    <ErrorBoundary>
      <ApprovalsScreen />
    </ErrorBoundary>
  );
}
