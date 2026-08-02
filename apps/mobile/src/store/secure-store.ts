/**
 * The device's persisted identity, kept in the OS secure enclave (iOS Keychain / Android Keystore)
 * via expo-secure-store. This holds the private key that authenticates the phone to its daemon, so it
 * never belongs in AsyncStorage or MMKV. Two things live here: the paired device (its DeviceRecord
 * plus a friendly name and paired date) and the monotonic outbound seq high-water mark, which must
 * survive launches so a reused seq can never replay a command.
 */
import * as SecureStore from 'expo-secure-store';
import type { DeviceRecord } from '@/core/protocol/pairing';
import { parseSeq, parseStoredDevice } from './persist-codec';

const DEVICE_KEY = 'ccr.device';
const SEQ_KEY = 'ccr.seq';

/** The paired device as the app stores it: the core record plus app-level metadata. */
export interface StoredDevice {
  record: DeviceRecord;
  /** Human name for this phone, shown in settings and sent as the decider on an approval. */
  deviceName: string;
  /** When pairing completed, epoch milliseconds. */
  pairedAt: number;
}

/** Load the paired device, or null if this phone has never paired (or the entry is unreadable). */
export async function loadStoredDevice(): Promise<StoredDevice | null> {
  return parseStoredDevice(await SecureStore.getItemAsync(DEVICE_KEY));
}

/** Persist the paired device. The DeviceRecord inside is JSON encoded. */
export async function saveStoredDevice(device: StoredDevice): Promise<void> {
  await SecureStore.setItemAsync(DEVICE_KEY, JSON.stringify(device));
}

/** Forget this device entirely (unpair): the identity and the seq counter both go. */
export async function clearStoredDevice(): Promise<void> {
  await SecureStore.deleteItemAsync(DEVICE_KEY);
  await SecureStore.deleteItemAsync(SEQ_KEY);
}

/** The persisted outbound seq high-water mark (0 if never set). */
export async function loadSeq(): Promise<number> {
  return parseSeq(await SecureStore.getItemAsync(SEQ_KEY));
}

/** Persist the outbound seq high-water mark. */
export async function saveSeq(seq: number): Promise<void> {
  await SecureStore.setItemAsync(SEQ_KEY, String(seq));
}
