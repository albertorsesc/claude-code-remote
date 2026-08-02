import { ErrorBoundary } from '@/components/error-boundary';
import ApprovalScreen from '@/screens/approval';

export default function ApprovalRoute() {
  return (
    <ErrorBoundary>
      <ApprovalScreen />
    </ErrorBoundary>
  );
}
