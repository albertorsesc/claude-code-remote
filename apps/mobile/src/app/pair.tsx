import { ErrorBoundary } from '@/components/error-boundary';
import PairScreen from '@/screens/pair';

export default function PairRoute() {
  return (
    <ErrorBoundary>
      <PairScreen />
    </ErrorBoundary>
  );
}
