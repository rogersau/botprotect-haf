# HAFBot attribution

BotProtect is brought to you by [HAFBOT](https://github.com/rogersau/hafbot).
Its message normalization and detection behavior are adapted from HAFBot’s
Bot Defense, with independent persistence and gateway implementations.

Source reviewed: revision `41300d299943bb2e5c0d9785335364b72f22e4aa` of
`rogersau/hafbot`, particularly:

- `src/services/bot-defense/message-filter.ts`: NFKC/whitespace/case normalization,
  SHA-256 fingerprints, distinct-channel matching, bot/webhook/trusted-role
  exemptions, detector-specific message actions, and one unresolved flag per member.
- `docs-site/features/bot-defense.md`: setup guidance and moderator review behavior.
- `src/gateway.ts` and `src/durable-objects/gateway-session.ts`: Identify/Resume,
  persisted gateway state, and a Durable Object alarm model.

This application does not depend on HAFBot’s subscription, billing, shared bot,
database, or moderation services. Both detectors are available to every deployment.

The project owner selected MIT for this standalone application, including this
adaptation. This does not change the upstream HAFBot repository’s license.
Dependency license notices remain with their respective packages.

## DM Sans

The self-hosted DM Sans font is Copyright 2014 The DM Sans Project Authors
(https://github.com/googlefonts/dm-fonts), distributed under the SIL Open Font
License 1.1. The full notice is retained at `public/licenses/dm-sans.txt` and is
included in the deployed assets. The font remains licensed under OFL 1.1.
