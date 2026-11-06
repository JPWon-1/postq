# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - Pending release

### Changed

- Renamed the npm launcher package from `postq` to `@rocknzero/postq`; the installed command remains `postq`.

### Fixed

- Release builds for both macOS targets now use `macos-latest` runners.

## [0.1.0] - 2026-11-06

### Added

- Local API client with collections, environments, request history, scenarios, schedules, realtime panels, and MCP tools.
- English and Korean UI, static web export, Rust CLI server, and Tauri desktop app.
- SQLite database and key backups, including automatic snapshots before pending migrations.
- Safe end-to-end test runner and local benchmark documentation.
