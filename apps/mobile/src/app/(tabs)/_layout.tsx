/**
 * The three-tab shell: Sessions, Approvals, Settings. The Approvals tab carries a live badge with the
 * number of pending approvals, so a decision that needs a human is visible without opening the tab.
 */
import { Tabs } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { pendingCount } from '@/core/state/fleetState';
import { useFleetStore } from '@/store/fleet-store';
import { colors } from '@/theme/tokens';

export default function TabsLayout() {
  const approvalCount = useFleetStore((state) => pendingCount(state.fleet));

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.mut,
        tabBarStyle: {
          backgroundColor: colors.surface1,
          borderTopColor: colors.line,
        },
      }}
    >
      <Tabs.Screen
        name="sessions"
        options={{
          title: 'Sessions',
          tabBarIcon: ({ color, size }) => <Feather name="grid" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="approvals"
        options={{
          title: 'Approvals',
          tabBarBadge: approvalCount > 0 ? approvalCount : undefined,
          tabBarIcon: ({ color, size }) => <Feather name="check-square" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => <Feather name="settings" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
