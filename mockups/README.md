# Tile design mockups

Design mockups for the unified ROLLER check-in tile format — reviewed and tweaked here **before** any change is ported into the live userscript (`../venue-roller-checkin.user.js`). These files do **not** affect the live script; Tampermonkey only fetches the `.user.js`.

## Files
- `tile-mockups.html` — self-contained mockup of all 8 tile scenarios (inline CSS/JS, no external assets). Renders the new tile system: top `Name:`/`Photo:` status readout, photo-or-placeholder middle, red prompts + "ACTION REQUIRED" only when needed, constant bottom bar (tier · guest · Confirm-I.D. shield), animated birthday flag, and the locked-shield-until-action interactions on tiles 3/6/7/8.

## How to resume the edit loop (with Claude)
1. Ask Claude to open `mockups/tile-mockups.html` for editing.
2. Give feedback one change at a time; Claude edits the file and **republishes the Artifact to the same URL** so you refresh and see it.
   - Live Artifact URL: https://claude.ai/code/artifact/a25d3e6e-039e-4cf9-a158-34d459f623cd
   - To update that exact artifact from a future session, pass its URL to the Artifact tool.
3. When the design is signed off, port it into `../venue-roller-checkin.user.js` (bump `@version`, push to `main`), then pull the update via the raw URL.

## Scenarios in the mockup
1 paidmember/misalign (Mismatched — assignment error only) · 2 casual · 3 alert (add photo) · 5 no overlays · 6 mismatch/similar · 7 mismatch+alert · 8 family (names required) · 9 membership-found panel. (Visiting overlay dropped; name-meaning removed.)
