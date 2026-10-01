import assert from "node:assert/strict";
import test from "node:test";
import { migratePlaintextToKeychain, readKeychainSecret, type KeychainStore } from "./secrets";

function memoryKeychain(initial: Record<string, string> = {}): KeychainStore & { values: Record<string, string> } {
  const values = { ...initial };
  return {
    values,
    getSecret(id) {
      return Object.prototype.hasOwnProperty.call(values, id) ? values[id] : null;
    },
    setSecret(id, secret) {
      values[id] = secret;
    },
  };
}

test("readKeychainSecret returns the keychain value for an id", () => {
  const store = memoryKeychain({ "backdrop-api-key": "bd_live" });
  assert.equal(readKeychainSecret(store, "backdrop-api-key"), "bd_live");
});

test("readKeychainSecret still returns a legacy plaintext key", () => {
  const store = memoryKeychain();
  assert.equal(readKeychainSecret(store, "bd_legacy"), "bd_legacy");
});

test("readKeychainSecret returns empty when a keychain id is missing", () => {
  const store = memoryKeychain();
  assert.equal(readKeychainSecret(store, "backdrop-api-key"), "");
});

test("migratePlaintextToKeychain stores the raw key and returns the id", () => {
  const store = memoryKeychain();
  const id = migratePlaintextToKeychain(store, "bd_legacy", "backdrop-api-key");
  assert.equal(id, "backdrop-api-key");
  assert.equal(store.values["backdrop-api-key"], "bd_legacy");
  assert.equal(readKeychainSecret(store, id), "bd_legacy");
});

test("migratePlaintextToKeychain leaves an existing id alone", () => {
  const store = memoryKeychain({ "my-key": "bd_live" });
  assert.equal(migratePlaintextToKeychain(store, "my-key", "backdrop-api-key"), "my-key");
  assert.equal(store.values["backdrop-api-key"], undefined);
});

test("migratePlaintextToKeychain does not overwrite a different saved secret", () => {
  const store = memoryKeychain({ "backdrop-api-key": "bd_other" });
  const id = migratePlaintextToKeychain(store, "bd_legacy", "backdrop-api-key");
  assert.equal(id, "backdrop-api-key-imported");
  assert.equal(store.values["backdrop-api-key"], "bd_other");
  assert.equal(store.values["backdrop-api-key-imported"], "bd_legacy");
});
