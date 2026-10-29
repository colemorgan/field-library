// Web Bluetooth adapter: finds the reader, opens rx/tx, and exposes the link interface used by
// RelaySession ({write, onData, onDisconnect, close}).
//
// Web Bluetooth does not expose the negotiated ATT MTU, so chunks are sized for the minimum
// MTU (23 -> 20-byte chunks) unless the caller passes a larger `mtu`.

import { MIN_MTU, NAME_PREFIX, RX_UUID, SERVICE_UUID, TX_UUID } from './protocol.js';

/** Why Web Bluetooth can't be used here, or null if it looks usable. */
export function bluetoothSupport(nav = globalThis.navigator, secure = globalThis.isSecureContext) {
  if (!secure) return 'insecure';
  if (!nav || !nav.bluetooth || typeof nav.bluetooth.requestDevice !== 'function') return 'unsupported';
  return null;
}

/** Resolves false when the browser reports no usable Bluetooth adapter. */
export async function bluetoothAvailable(nav = globalThis.navigator) {
  try {
    if (typeof nav.bluetooth.getAvailability === 'function') return await nav.bluetooth.getAvailability();
  } catch {
    /* fall through */
  }
  return true;
}

/**
 * Ask the user to pick a reader and connect to it.
 * @param {{bluetooth?: Bluetooth, mtu?: number, onStatus?: (text: string) => void}} [opts]
 */
export async function connectReader({ bluetooth = globalThis.navigator?.bluetooth, mtu = MIN_MTU, onStatus = () => {} } = {}) {
  // The 128-bit service UUID plus the name may not both fit in the 31-byte advertisement (the name
  // may be in the scan response), so accept either filter and list the service as optional.
  const device = await bluetooth.requestDevice({
    filters: [{ services: [SERVICE_UUID] }, { namePrefix: NAME_PREFIX }],
    optionalServices: [SERVICE_UUID],
  });

  const dataListeners = [];
  const disconnectListeners = [];
  let closed = false;
  let tx = null;

  const onValue = (event) => {
    const dv = event.target.value;
    const chunk = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
    for (const cb of dataListeners) cb(chunk);
  };
  const onGattDisconnected = () => {
    if (closed) return;
    closed = true;
    for (const cb of disconnectListeners) cb();
  };
  device.addEventListener('gattserverdisconnected', onGattDisconnected);

  onStatus(`Connecting to ${device.name ?? 'reader'}…`);
  let rx;
  try {
    ({ rx, tx } = await openCharacteristics(device, onValue, onStatus));
  } catch (err) {
    closed = true;
    device.removeEventListener('gattserverdisconnected', onGattDisconnected);
    if (device.gatt.connected) device.gatt.disconnect();
    throw err;
  }
  const writeChunk =
    typeof rx.writeValueWithResponse === 'function'
      ? (c) => rx.writeValueWithResponse(c)
      : (c) => rx.writeValue(c); // older Chrome / Bluefy

  return {
    name: device.name ?? 'reader',
    mtu,
    write: (chunk) => writeChunk(chunk),
    onData: (cb) => dataListeners.push(cb),
    onDisconnect: (cb) => disconnectListeners.push(cb),
    async close() {
      if (closed) return;
      closed = true;
      try {
        tx.removeEventListener('characteristicvaluechanged', onValue);
        if (device.gatt.connected) await tx.stopNotifications().catch(() => {});
      } finally {
        device.removeEventListener('gattserverdisconnected', onGattDisconnected);
        if (device.gatt.connected) device.gatt.disconnect();
      }
    },
  };
}

async function openCharacteristics(device, onValue, onStatus) {
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);
  const rx = await service.getCharacteristic(RX_UUID);
  const tx = await service.getCharacteristic(TX_UUID);

  // Both characteristics are encrypted: enabling notifications triggers pairing on first use, and
  // the OS shows the passkey dialog. Android sometimes fails the first attempt while pairing is in
  // progress, so retry once.
  onStatus('Securing the link — enter the passkey shown on the reader if asked…');
  tx.addEventListener('characteristicvaluechanged', onValue);
  try {
    await tx.startNotifications();
  } catch (err) {
    if (!device.gatt.connected) throw err;
    await new Promise((r) => setTimeout(r, 1000));
    await tx.startNotifications();
  }
  return { rx, tx };
}
