/**
 * The live connection to a paired daemon: it wraps the verified transport (openWebSocket) with the
 * one reconnect trigger a phone actually needs, returning to the foreground. It builds the
 * SessionCrypto from the stored record, dials the daemon's ws:// address, and reports status and
 * events up to the store.
 *
 * Reconnect is deliberately minimal per the transport's own contract: no backoff, no network probing
 * (that would need a NetInfo dependency this app does not carry). When the socket drops, the next
 * foreground reopens it. Each reopen is a fresh hello, so the daemon re-sends the full session_list;
 * this favours a simple, dependency-free resync over seq-resume replay.
 */
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { openWebSocket, type Connection } from '@/core/transport';
import { sessionCryptoFromRecord, type DeviceRecord } from '@/core/protocol/pairing';
import type { ClientCommand, ServerEvent } from '@claude-code-remote/protocol';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface ConnectionHandlers {
  /** The monotonic outbound seq source (backed by the persisted counter). */
  nextSeq: () => number;
  /** Every authenticated server event, to fold into the fleet state. */
  onEvent: (event: ServerEvent, seq: number) => void;
  /** Status transitions, for the connection indicator. */
  onStatus: (status: ConnectionStatus) => void;
  /** The daemon rejected our hello (for example after a remote revoke). */
  onHelloRejected?: () => void;
}

export interface ManagedConnection {
  /** Open the socket and start reconnecting on foreground. */
  connect: () => void;
  /** Close the socket and stop reconnecting. */
  disconnect: () => void;
  /** Enqueue a command; returns the assigned seq, or null if there is no open socket yet. */
  send: (command: ClientCommand, reliable?: boolean) => number | null;
}

/** Create a managed connection for a paired device. Idempotent: connect() twice is a no-op while open. */
export function createConnection(record: DeviceRecord, handlers: ConnectionHandlers): ManagedConnection {
  const crypto = sessionCryptoFromRecord(record);
  let connection: Connection | null = null;
  let appStateSubscription: NativeEventSubscription | null = null;
  let closedByUser = false;

  const open = (): void => {
    if (connection) return;
    handlers.onStatus('connecting');
    connection = openWebSocket(
      record.daemonAddress,
      {
        deviceId: record.deviceId,
        crypto,
        nextSeq: handlers.nextSeq,
        onEvent: handlers.onEvent,
        onReady: () => handlers.onStatus('connected'),
        onHelloRejected: handlers.onHelloRejected,
      },
      () => {
        connection = null;
        if (!closedByUser) handlers.onStatus('disconnected');
      },
    );
  };

  return {
    connect: () => {
      closedByUser = false;
      if (!appStateSubscription) {
        appStateSubscription = AppState.addEventListener('change', (state: AppStateStatus) => {
          if (state === 'active' && !closedByUser && !connection) open();
        });
      }
      open();
    },

    disconnect: () => {
      closedByUser = true;
      appStateSubscription?.remove();
      appStateSubscription = null;
      connection?.close();
      connection = null;
      handlers.onStatus('disconnected');
    },

    send: (command, reliable = true) => (connection ? connection.controller.send(command, reliable) : null),
  };
}
