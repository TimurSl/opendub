import { fail } from "./store.js";

// Match rules: host-edited during setup, locked once role selection opens (the
// same moment gameMode locks). Every key is validated here; unknown keys and
// out-of-range values are rejected.
export const RULE_MODES = Object.freeze(["character", "line", "duet", "relay"]);
// Modes whose ownership lives in lineAssignments. Character mode alone keeps the live role mapping.
export const LINE_STYLE_MODES = Object.freeze(["line", "duet", "relay"]);
export const isLineStyle = mode => LINE_STYLE_MODES.includes(mode);
export const TAKE_LIMIT_MAX = 20;
export const BLIND_KEYS = Object.freeze(["caption", "reference", "scene"]);
export const RELAY_EVERY_MAX = 20;
export const SPEED_SECONDS = Object.freeze({ min: 3, max: 60 });
export const CARD_DEALS = Object.freeze(["per-player", "per-line", "per-character"]);
export const CARD_KINDS = Object.freeze(["performance", "effect", "constraint"]);

export function defaultBlind() { return { caption: false, reference: false, scene: false, share: 1 }; }
export function defaultSpeed() { return { enabled: false, lineTimeLimitSec: 10 }; }
export function defaultCards() { return { enabled: false, deckId: null, deal: "per-player", kinds: [...CARD_KINDS] }; }
export function defaultRules() {
  return {
    mode: "character", takeLimit: 0, allowPlayerRetakes: true, blind: defaultBlind(),
    relayEvery: 3, speed: defaultSpeed(), mystery: false, cards: defaultCards(),
  };
}
export const blindActive = blind => !!blind && BLIND_KEYS.some(key => blind[key]) && blind.share > 0;

function nested(rules, key, defaults, label) {
  const value = Object.hasOwn(rules, key) ? rules[key] : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid " + label + " rules");
  for (const name of Object.keys(value)) if (!Object.hasOwn(defaults, name)) fail("Unknown " + label + " rule: " + name.slice(0, 40));
  return { ...defaults, ...value };
}

export function validateRules(rules, pack = null) {
  void pack; // Reserved: later rules may depend on the selected pack.
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) fail("Invalid rules");
  const known = new Set(Object.keys(defaultRules()));
  for (const key of Object.keys(rules)) if (!known.has(key)) fail("Unknown rule: " + key.slice(0, 40));
  const next = { ...defaultRules(), ...rules };
  if (!RULE_MODES.includes(next.mode)) fail("Invalid game mode");
  if (!Number.isInteger(next.takeLimit) || next.takeLimit < 0 || next.takeLimit > TAKE_LIMIT_MAX) fail("Take limit must be 0 (unlimited) to " + TAKE_LIMIT_MAX);
  if (typeof next.allowPlayerRetakes !== "boolean") fail("Invalid allowPlayerRetakes");
  next.blind = nested(rules, "blind", defaultBlind(), "blind");
  for (const key of BLIND_KEYS) if (typeof next.blind[key] !== "boolean") fail("Invalid blind " + key);
  if (typeof next.blind.share !== "number" || !Number.isFinite(next.blind.share) || next.blind.share < 0 || next.blind.share > 1) fail("Blind share must be between 0 and 1");

  if (!Number.isInteger(next.relayEvery) || next.relayEvery < 1 || next.relayEvery > RELAY_EVERY_MAX) fail("Relay hand-over must be every 1 to " + RELAY_EVERY_MAX + " lines");
  next.speed = nested(rules, "speed", defaultSpeed(), "speed");
  if (typeof next.speed.enabled !== "boolean") fail("Invalid speed switch");
  if (!Number.isInteger(next.speed.lineTimeLimitSec) || next.speed.lineTimeLimitSec < SPEED_SECONDS.min || next.speed.lineTimeLimitSec > SPEED_SECONDS.max) fail(`Speed time limit must be ${SPEED_SECONDS.min} to ${SPEED_SECONDS.max} seconds`);
  // Speed rounds are one take, no retakes. The server enforces both, so the rules say so.
  if (next.speed.enabled) { next.takeLimit = 1; next.allowPlayerRetakes = false; }

  if (typeof next.mystery !== "boolean") fail("Invalid mystery switch");
  if (next.mystery && !isLineStyle(next.mode)) fail("Mystery needs Line, Duet or Relay mode, where the host or the game decides who records what");

  next.cards = nested(rules, "cards", defaultCards(), "cards");
  if (typeof next.cards.enabled !== "boolean") fail("Invalid cards switch");
  if (next.cards.deckId !== null && (typeof next.cards.deckId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(next.cards.deckId))) fail("Invalid deck");
  if (!CARD_DEALS.includes(next.cards.deal)) fail("Invalid card deal");
  if (next.cards.deal === "per-character" && next.mode !== "character") fail("Per-character cards need Character mode");
  if (!Array.isArray(next.cards.kinds) || !next.cards.kinds.length || next.cards.kinds.some(kind => !CARD_KINDS.includes(kind)) || new Set(next.cards.kinds).size !== next.cards.kinds.length) fail("Choose at least one card kind");
  next.cards.kinds = CARD_KINDS.filter(kind => next.cards.kinds.includes(kind));
  return next;
}
