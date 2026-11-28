# Living Workspace original artwork

Samara, Flax, and Mallow are first-party UAP seed-pod illustrations. The editable SVG source is embedded in `web/src/components/studio/AgentPortrait.tsx` (SHA-256 `491e40cb922013432c4c231b91938a3af939de5eb6d72cccd62a74636f42681b`, 6631 bytes) and covered by the repository MIT license. This source record complements the existing manifest, which scans separately bundled media files rather than TSX.

Each pod has a distinct authored outline, woven surface and stitched seam; the only animation input is the actual UI state, rendered as static expression changes. The roster, header and empty chat share the same art selection; the selection currently derives from the existing agent ID and does not change it. Rooms and classic layout keep existing icons. No asset, code, texture, mesh, or shader from any reference repository was copied or bundled. No remote font or GPU rendering is required. Nightly OpenBot informed the tactile direction only; Open Bot Avatar is recorded as a possible reference in `TRACEABILITY.md`, not a dependency.

Preview with the authenticated browser test (`CHROMIUM_PATH=/usr/bin/chromium npm run test:browser`). A user-editable, server-stored appearance profile and real media-driven expressions are separate work and not implemented by this artwork.
