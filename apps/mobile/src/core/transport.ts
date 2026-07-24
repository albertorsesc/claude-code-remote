/**
 * The WebSocket transport: opens a connection to the daemon and drives a ClientController over it.
 * Uses the global `WebSocket`, which exists in Expo Go (React Native) and in Node, so no native
 * module and no dev client are needed. Each WebSocket message carries one newline-terminated frame,
 * which the controller's own framing handles, so this is a thin pipe.
 *
 * The controller is constructed here so its `write` can be bound to this socket; the caller supplies
 * everything else (crypto, seq, event handlers). Reconnect is the caller's concern (a phone reconnects
 * on foreground and network regain), so this just reports `onClose` and the caller reopens.
 */
import { ClientController, type ClientControllerOptions } from './protocol/clientController.ts';

export interface Connection {
  controller: ClientController;
  close(): void;
}

export function openWebSocket(
  url: string,
  opts: Omit<ClientControllerOptions, 'write'>,
  onClose?: () => void,
): Connection {
  const ws = new WebSocket(url);
  const controller = new ClientController({
    ...opts,
    write: (line) => { if (ws.readyState === WebSocket.OPEN) ws.send(line); },
  });
  ws.addEventListener('open', () => controller.connected());
  ws.addEventListener('message', (e) => controller.feed(typeof e.data === 'string' ? e.data : String(e.data)));
  ws.addEventListener('close', () => { controller.disconnected(); onClose?.(); });
  ws.addEventListener('error', () => { /* a close event always follows, which does the teardown */ });
  return { controller, close: () => ws.close() };
}
