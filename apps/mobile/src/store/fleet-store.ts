/**
 * The app's single global store (zustand v5). It binds the pure fleet reducer to React: every server
 * event folds through applyEvent, and every screen action turns into a ClientCommand on the wire. The
 * live connection and seq counter are side effects, so they live in module scope rather than in the
 * rendered state, which stays a plain, serialisable snapshot of the fleet.
 */
import { AppState } from 'react-native';
import { create } from 'zustand';
import { applyEvent, emptyFleetState, type FleetState } from '@/core/state/fleetState';
import { createConnection, type ConnectionStatus, type ManagedConnection } from './connection';
import { createSeqCounter } from './seq';
import { clearStoredDevice, loadStoredDevice, saveStoredDevice, loadSeq, saveSeq, type StoredDevice } from './secure-store';
import { decodePairCode, deviceRecordFromPaired, startPairing } from '@/core/protocol/pairing';
import { completePairOverWebSocket } from '@/core/pair-transport';
import type { EffortLevel, PermissionMode } from '@claude-code-remote/protocol';

export type FleetStatus = 'unpaired' | ConnectionStatus;

export interface SpawnOptions {
  cwd: string;
  label?: string;
  disallowedTools?: string[];
  model?: string;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
}

export interface FleetStore {
  /** True once secure storage has been read at least once, so the gate knows how to route. */
  hydrated: boolean;
  status: FleetStatus;
  fleet: FleetState;
  error: string | null;
  device: StoredDevice | null;

  hydrate: () => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => void;
  pair: (code: string, deviceName: string) => Promise<void>;
  unpair: () => Promise<void>;
  decide: (toolUseId: string, decision: 'allow' | 'deny', reason?: string) => void;
  interrupt: (sessionId: string) => void;
  sendText: (sessionId: string, text: string) => void;
  spawn: (options: SpawnOptions) => void;
  refreshList: () => void;
  loadHistory: (limit?: number) => void;
  clearError: () => void;
}

/** The live connection. Not part of the rendered state (it is a side effect, not a value). */
let managed: ManagedConnection | null = null;

export const useFleetStore = create<FleetStore>()((set, get) => {
  const ensureConnection = async (): Promise<ManagedConnection | null> => {
    const device = get().device;
    if (!device) return null;
    if (!managed) {
      const seq = await createSeqCounter({ loadSeq, saveSeq });
      managed = createConnection(device.record, {
        nextSeq: seq.next,
        onEvent: (event) => set((state) => ({ fleet: applyEvent(state.fleet, event) })),
        onStatus: (status: ConnectionStatus) => set({ status }),
        onHelloRejected: () => set({ error: 'The daemon rejected this device. It may have been unpaired remotely.' }),
        subscribeForeground: (onForeground) => {
          const sub = AppState.addEventListener('change', (state) => { if (state === 'active') onForeground(); });
          return () => sub.remove();
        },
      });
    }
    return managed;
  };

  /** Who a decision is attributed to on the wire: the device's friendly name, falling back to its id. */
  const decider = (): string => {
    const device = get().device;
    return device?.deviceName ?? device?.record.deviceId ?? 'unknown-device';
  };

  const requireSend = (command: Parameters<ManagedConnection['send']>[0], notConnectedMessage: string, reliable = true): void => {
    const seq = managed?.send(command, reliable);
    if (seq == null) set({ error: notConnectedMessage });
  };

  return {
    hydrated: false,
    status: 'unpaired',
    fleet: emptyFleetState,
    error: null,
    device: null,

    hydrate: async () => {
      const device = await loadStoredDevice();
      set({ device, hydrated: true, status: device ? 'disconnected' : 'unpaired' });
    },

    connect: async () => {
      const connection = await ensureConnection();
      if (!connection) {
        set({ status: 'unpaired' });
        return;
      }
      connection.connect();
    },

    disconnect: () => {
      managed?.disconnect();
    },

    pair: async (code, deviceName) => {
      const payload = decodePairCode(code);
      const attempt = startPairing(payload, deviceName);
      if (!attempt.target) {
        throw new Error('This daemon has no WebSocket address, so a phone cannot reach it.');
      }
      const { deviceId } = await completePairOverWebSocket(attempt.target, attempt.completePair);
      const record = deviceRecordFromPaired(deviceId, attempt, payload);
      const stored: StoredDevice = { record, deviceName, pairedAt: Date.now() };
      await saveStoredDevice(stored);
      // A new identity needs a fresh connection built from the new record.
      managed?.disconnect();
      managed = null;
      set({ device: stored, status: 'disconnected', fleet: emptyFleetState, error: null });
      await get().connect();
    },

    unpair: async () => {
      managed?.disconnect();
      managed = null;
      await clearStoredDevice();
      set({ device: null, status: 'unpaired', fleet: emptyFleetState, error: null });
    },

    decide: (toolUseId, decision, reason) => {
      requireSend({ type: 'decide', toolUseId, decision, reason, by: decider() }, 'Not connected, so the decision was not sent.');
    },

    interrupt: (sessionId) => {
      requireSend({ type: 'interrupt', sessionId }, 'Not connected, so the interrupt was not sent.');
    },

    sendText: (sessionId, text) => {
      requireSend({ type: 'send', sessionId, text }, 'Not connected, so the message was not sent.');
    },

    spawn: (options) => {
      requireSend({ type: 'spawn', ...options }, 'Not connected, so the session was not started.');
    },

    refreshList: () => {
      // A one-shot read: reissued fresh on reconnect rather than buffered for resend.
      managed?.send({ type: 'list' }, false);
    },

    loadHistory: (limit) => {
      managed?.send({ type: 'history', limit }, false);
    },

    clearError: () => set({ error: null }),
  };
});
