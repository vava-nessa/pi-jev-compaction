# 0.1.1 - key fingerprint

## The question this answers

"Is my key actually being used?" `key=set` says a key exists, not which one. When a request
lands in a TypeSafe account you did not expect, the only way to notice was to compare the
key by hand. TypeSafe's per-request usage makes this easy to miss: a short session costs a
fraction of a cent, so an account with no visible movement is exactly what correct behaviour
looks like.

## Changes

- `/jev` and the first debug log line now print a masked fingerprint, such as
  `key=apikey_263d61...cd4b`, instead of `key=set`. The extension never prints a full key,
  and the fingerprint is only a label: the raw key is still what travels in the
  `Authorization` header.
- `fingerprintApiKey()` is exported from `extensions/lib/config.ts` and covered by tests,
  including the rule that a short key is never echoed in full.

## Notes

TypeSafe bills input only, at $0.042 per million tokens, output free. Compacting a session
with 196 tool calls cost 78,174 input tokens, about a third of a cent.
