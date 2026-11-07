import { fail } from "./store.js";

// Match rules: host-edited during setup, locked once role selection opens (the
// same moment gameMode locks). Every key is validated here; unknown keys and
// out-of-range values are rejected. Later roadmap phases extend RULE_MODES and
// add `blind` and `cards`.
export const RULE_MODES = Object.freeze(["character", "line"]);
export const TAKE_LIMIT_MAX = 20;

export function defaultRules() {
  return { mode: "character", takeLimit: 0, allowPlayerRetakes: true };
}

export function validateRules(rules, pack = null) {
  void pack; // Reserved: later rules depend on the selected pack (for example duet needs 2 x characters).
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) fail("Invalid rules");
  const known = new Set(Object.keys(defaultRules()));
  for (const key of Object.keys(rules)) if (!known.has(key)) fail("Unknown rule: " + key.slice(0, 40));
  const next = { ...defaultRules(), ...rules };
  if (!RULE_MODES.includes(next.mode)) fail("Invalid game mode");
  if (!Number.isInteger(next.takeLimit) || next.takeLimit < 0 || next.takeLimit > TAKE_LIMIT_MAX) fail("Take limit must be 0 (unlimited) to " + TAKE_LIMIT_MAX);
  if (typeof next.allowPlayerRetakes !== "boolean") fail("Invalid allowPlayerRetakes");
  return next;
}
