import * as SecureStore from "expo-secure-store";

export interface Credentials {
  endpoint: string;
  token: string;
}

const KEY = "xum.mobile.connection";

export async function loadCredentials(): Promise<Credentials | null> {
  const stored = await SecureStore.getItemAsync(KEY);
  if (!stored) return null;
  try {
    const value: unknown = JSON.parse(stored);
    if (
      typeof value === "object" &&
      value !== null &&
      "endpoint" in value &&
      typeof value.endpoint === "string" &&
      "token" in value &&
      typeof value.token === "string"
    )
      return { endpoint: value.endpoint, token: value.token };
  } catch {
    // Corrupted device storage must not prevent connecting to a server again.
  }
  await clearCredentials();
  return null;
}

export async function saveCredentials(value: Credentials): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(value), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearCredentials(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
