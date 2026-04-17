#!/bin/bash
set -e

# Eject any mounted Rolloc volumes
hdiutil detach /Volumes/Rolloc 2>/dev/null || true

# Clean up temp DMG files
rm -f src-tauri/target/release/bundle/macos/rw.*.dmg

# Build the app
bun run tauri build --bundles app

# Create DMG manually (Tauri's bundler is flaky on macOS)
cd src-tauri/target/release/bundle/macos
rm -f Rolloc_*.dmg
hdiutil create -volname "Rolloc" -srcfolder Roloc.app -ov -format UDZO Roloc_0.1.0_aarch64.dmg

echo "✓ DMG created: src-tauri/target/release/bundle/macos/Rolloc_0.1.0_aarch64.dmg"
