# Compatibility modules

This directory contains the small contract and UI modules that the mobile
client previously imported from Hermes Desktop and the monorepo shared package.

They are intentionally mobile-owned so the standalone repository can be built
without a Hermes Agent checkout. Gateway wire contracts should remain
runtime-safe and additive; update these copies when the mobile contract needs a
new backend field.
