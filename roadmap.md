# Roadmap

- [x] Clone sparkle-glm-forge into this project and install dependencies
- [x] Store all Pixazo keys + Z.ai key as encrypted secrets (never in code)
- [x] Prompt rebuild: one identity line per character, location/action first,
      candid staging, sheet/portrait guards, cross-batch continuity
- [x] Fix Scene rewrites composition; Reroll only changes the seed
- [x] Automatic image review with GLM-4.6V-Flash (sketch / sheet / wrong scene /
      blank background / front-facing / duplicate / text) + one corrective redraw
- [x] Fix long-run quality threshold: global verification numbering, queued image
      reviews, independent review cooldown, and rejection of known-bad redraws
- [x] Lock the main character as an unmarried 23-year-old adult man in every panel
- [x] Stop twin/duplicate figures: a character's repeated description right after
      their name is collapsed, so each person is described exactly once
- [x] Clean age wording ("a 60-year-old man", not the whole look sentence)
- [x] Wordless-picture rule stated early, so signage/captions stop appearing
- [ ] Reference-image character locking — not possible on Flux.1 Schnell (text-only);
      needs an image model with reference/character conditioning
- [ ] Run the complete 00:00–05:05 script and verify every image against its
      exact timestamped line and final renderer prompt; rerun every mismatch

## Rebuild in this project (Sep 2026)
- [x] Project code brought in and dependencies installed
- [x] All 10 Pixazo keys + Z.ai key stored as encrypted secrets (server-only)
- [x] Prompt batching removed: one writing request per timestamp, whole script
      as context, larger detail budget per prompt
- [x] Each image starts rendering the instant its own prompt lands (writing and
      drawing run together, no waiting for the full prompt list)
- [x] Explicit fighting / magic / ability / battlefield detail rule in the writer
- [x] Lanes tuned (6 per user, 2 per key over 10 keys) so 2-3 people can run
      the service at the same time
