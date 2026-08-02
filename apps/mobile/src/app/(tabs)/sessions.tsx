import { ErrorBoundary } from '@/components/error-boundary';
import FleetScreen from '@/screens/fleet';

export default function SessionsRoute() {
  return (
    <ErrorBoundary>
      <FleetScreen />
    </ErrorBoundary>
  );
}
