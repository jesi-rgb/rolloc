#!/bin/bash
set -e

# Eject any mounted Roloc volumes
hdiutil detach /Volumes/Roloc 2>/dev/null || true

# Clean up temp DMG files
rm -f src-tauri/target/release/bundle/macos/rw.*.dmg

# Build the app
bun run tauri build --bundles app

# Create DMG manually (Tauri's bundler is flaky on macOS)
cd src-tauri/target/release/bundle/macos
rm -f Roloc_*.dmg
hdiutil create -volname "Roloc" -srcfolder Roloc.app -ov -format UDZO Roloc_0.1.0_aarch64.dmg

echo "✓ DMG created: src-tauri/target/release/bundle/macos/Roloc_0.1.0_aarch64.dmg"
