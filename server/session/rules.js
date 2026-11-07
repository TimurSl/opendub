import { fail } from "./store.js";

// Match rules: host-edited during setup, locked once role selection opens (the
// same moment gameMode locks). Every key is validated here; unknown keys and
// out-of-range values are rejected. Later roadmap phases extend RULE_MODES and
// add `cards`.
export const RULE_MODES = Object.freeze(["character", "line"]);
export const TAKE_LIMIT_MAX = 20;
export const BLIND_KEYS = Object.freeze(["caption", "reference", "scene"]);

export function defaultBlind() { return { caption: false, reference: false, scene: false, share: 1 }; }
export function defaultRules() {
  return { mode: "character", takeLimit: 0, allowPlayerRetakes: true, blind: defaultBlind() };
}
export const blindActive = blind => !!blind && BLIND_KEYS.some(key => blind[key]) && blind.share > 0;

export function validateRules(rules, pack = null) {
  void pack; // Reserved: later rules depend on the selected pack (for example duet needs 2 x characters).
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) fail("Invalid rules");
  const known = new Set(Object.keys(defaultRules()));
  for (const key of Object.keys(rules)) if (!known.has(key)) fail("Unknown rule: " + key.slice(0, 40));
  const next = { ...defaultRules(), ...rules };
  if (!RULE_MODES.includes(next.mode)) fail("Invalid game mode");
  if (!Number.isInteger(next.takeLimit) || next.takeLimit < 0 || next.takeLimit > TAKE_LIMIT_MAX) fail("Take limit must be 0 (unlimited) to " + TAKE_LIMIT_MAX);
  if (typeof next.allowPlayerRetakes !== "boolean") fail("Invalid allowPlayerRetakes");
  const blind = Object.hasOwn(rules, "blind") ? rules.blind : {};
  if (!blind || typeof blind !== "object" || Array.isArray(blind)) fail("Invalid blind rules");
  for (const key of Object.keys(blind)) if (!Object.hasOwn(defaultBlind(), key)) fail("Unknown blind rule: " + key.slice(0, 40));
  next.blind = { ...defaultBlind(), ...blind };
  for (const key of BLIND_KEYS) if (typeof next.blind[key] !== "boolean") fail("Invalid blind " + key);
  if (typeof next.blind.share !== "number" || !Number.isFinite(next.blind.share) || next.blind.share < 0 || next.blind.share > 1) fail("Blind share must be between 0 and 1");
  return next;
}
