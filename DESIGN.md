# Design notes

This file replaces an earlier, much longer design document. Comments in the source that
cite a numbered section (for example "section 13.6") refer to that retired document;
treat them as historical context, not as a live reference.

## Fixed points

- The engine is the only source of rule truth. The client derives everything it shows
  from a `PlayerView` projection and never reads authoritative state.
- Content is data. Card text, costs, handler IDs and the board live in
  `packages/content` and are generated from `content/` by `scripts/generate_decks.py`
  and `scripts/generate_board.py`.
- Every rule the engine fixes where a table might argue is a house rule in
  `packages/content/src/ruleset.ts` and is shown to players before a match starts.
- The pass-and-play build carries no network code; `scripts/check_build_privacy.mjs`
  asserts this from the emitted bundle.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Policy card | The question card answered each turn. |
| Archetype | Corporate, Nationalist, Populist or Reformer; each answer builds one. |
| Cash, Influence, Press, Faith | The four resources, one per archetype. |
| Breaking News | Cards dealt by volatile areas, resolved at end of turn. |
| Dirty Trick | Cards bought face down and played for effect. |
| Redistricting rights | Held by the seat with strictly the most voters in a zone. |
