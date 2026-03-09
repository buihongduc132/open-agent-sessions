# Roadmap

This document outlines the development roadmap for open-agent-sessions.

## Vision

Build a unified session management library that enables developers to access, search, and manage AI coding agent sessions across multiple platforms through a single, consistent interface.

---

## Phase 1: Foundation

**Goal**: Establish core architecture and OpenCode adapter

**Key Deliverables**:
- YAML-based configuration system for multiple agent instances
- Adapter registry with validation and duplicate detection
- Data normalization layer for unified SessionSummary format
- OpenCode adapter supporting SQLite and JSONL storage
- Comprehensive test suite with TDD workflow

**Status**: Complete

---

## Phase 2: Core Features

**Goal**: Complete CLI tooling and session operations

**Key Deliverables**:
- CLI commands: list, detail, search
- Session detail retrieval with message filtering
- Content search across sessions
- Output formatting (table, JSON, YAML)
- Message part parsing (text, tool, reasoning)

**Status**: In Progress

---

## Phase 3: Additional Adapters

**Goal**: Extend support to Codex and Claude agents

**Key Deliverables**:
- Codex adapter with session listing and detail retrieval
- Claude Desktop adapter with JSONL parsing
- Unified operations across all three agents
- Cross-agent search functionality
- Adapter compatibility matrix documentation

**Prerequisites**: Phase 2 complete and stable

---

## Phase 4: Advanced Features

**Goal**: Enable advanced session manipulation and user interfaces

**Key Deliverables**:
- Session cloning between agents
- Terminal UI (TUI) for interactive browsing
- Advanced search with filters and regex support
- Export/import functionality (JSON, Markdown)
- Performance optimizations for large datasets

---

## Phase 5: Performance & Polish

**Goal**: Production-ready quality and developer experience

**Key Deliverables**:
- Lazy loading and pagination for large datasets
- Caching layer for improved performance
- Comprehensive API documentation and tutorials
- Plugin system for custom adapters
- Integration tests and CI/CD pipeline

---

## Phase 6: Ecosystem

**Goal**: Expand integration options and platform support

**Key Deliverables**:
- VS Code extension
- Web UI and REST API
- Session analytics and comparison tools
- Cross-platform support (Windows, macOS, Linux)
- Docker image and cloud deployment options

---

## Development Principles

1. **Stability**: Ensure core functionality is robust and well-tested
2. **Usability**: Make the library easy to use and understand
3. **Performance**: Optimize for large session datasets
4. **Compatibility**: Support multiple agent platforms
5. **Documentation**: Provide comprehensive guides and examples

---

## Contributing

Contributions are welcome!

1. Check existing issues and discussions
2. Open a feature request issue
3. Discuss the proposal via GitHub Discussions
4. Submit a pull request

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.
