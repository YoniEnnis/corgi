import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

type PlaidError = { error_message?: string; error_code?: string; display_message?: string };

function plaidConfig() {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) throw new Error("Set PLAID_CLIENT_ID and PLAID_SECRET in .env.local.");
  if (process.env.PLAID_ENV !== "sandbox") throw new Error("This integration only accepts PLAID_ENV=sandbox.");
  return { client_id: clientId, secret, baseUrl: "https://sandbox.plaid.com" };
}

export function isPlaidConfigured() {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET && process.env.PLAID_ENV === "sandbox");
}

export async function plaidPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const config = plaidConfig();
  const response = await fetch(config.baseUrl + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: config.client_id, secret: config.secret, ...body }),
    cache: "no-store",
  });
  const result = await response.json() as T & PlaidError;
  if (!response.ok) {
    throw new Error(result.display_message || result.error_message || ("Plaid request failed (" + response.status + (result.error_code ? ": " + result.error_code : "") + ")."));
  }
  return result;
}

function encryptionKey() {
  const configured = process.env.PLAID_TOKEN_ENCRYPTION_KEY;
  if (!configured) throw new Error("Set PLAID_TOKEN_ENCRYPTION_KEY before connecting a Plaid Sandbox account.");
  const key = Buffer.from(configured, "base64");
  if (key.length !== 32) throw new Error("PLAID_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return key;
}

export function encryptPlaidAccessToken(accessToken: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(accessToken, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptPlaidAccessToken(encrypted: string) {
  const [version, ivText, tagText, ciphertextText] = encrypted.split(":");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText) throw new Error("Stored Plaid access token has an unsupported format.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64")), decipher.final()]).toString("utf8");
}
