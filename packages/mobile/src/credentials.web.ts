import type { Credentials } from "./credentials";

// Browser previews have no Keychain. Never persist the server token in web storage.
export async function loadCredentials(): Promise<Credentials | null> {
  return null;
}
export async function saveCredentials(_value: Credentials): Promise<void> {}
export async function clearCredentials(): Promise<void> {}
