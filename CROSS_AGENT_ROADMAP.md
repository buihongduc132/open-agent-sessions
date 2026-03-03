# Cross-Agent Session Management Roadmap

This roadmap outlines the path to enabling seamless session transfer and management across OpenCode, Codex, and Claude CLI agents.

## Research Findings

### Existing Solutions

**Cross Agent Session Resumer (CASR)**
- Repository: https://github.com/Dicklesworthstone/cross_agent_session_resumer
- Language: Rust
- Approach: Converts between Codex, Claude, Gemini formats via canonical IR
- Key Insight: Canonical Intermediate Representation (IR) pattern is proven

**Agent Deck**
- Repository: https://github.com/asheshgoplani/agent-deck
- Language: Go
- Approach: Terminal session manager TUI for multiple agents
- Scope: Session management UI, not transfer/conversion

**Session Export Tools**
- claude-conversation-extractor (Python): Export Claude Code to markdown
- cctrace (Python): Export Claude Code sessions to markdown/XML
- claude-exporter (Chrome): Export Claude.ai conversations

### Session Storage Formats

**OpenCode**
- SQLite database: `~/.opencode/sessions.db`
- JSONL files: `~/.opencode/sessions.jsonl`
- Format: Structured messages with tool calls, parts, metadata

**Claude Code**
- JSONL files: `~/.claude/projects/*.jsonl`
- Format: Conversation history with tool usage
- Session ID based resumption via API

**Codex**
- Storage location: `~/.codex/` (to be verified)
- Format: Requires investigation

### Technical Challenges

1. **Message Format Differences**: Each agent structures messages differently
2. **Tool/Plugin Mapping**: Agent-specific tools need translation or omission
3. **Metadata Preservation**: Session metadata varies across platforms
4. **Context Limits**: Different agents have different context window sizes
5. **Attachment Handling**: Files, images, artifacts differ by agent

---

## Phase 1: Foundation

**Goal**: Complete unified session reading for OpenCode with full CLI

**Key Deliverables**:
- OpenCode adapter (SQLite + JSONL)
- Configuration system and adapter registry
- Session listing and detail retrieval
- CLI commands (list, detail, search)
- Message part parsing (text, tool, reasoning)

**Critical Requirement**: OpenCode adapter and CLI must be fully complete and tested before starting Phase 2. No multi-agent work begins until OpenCode is proven stable.

**Success Criteria**: Can list, view, search, and display sessions from any OpenCode instance via CLI

---

## Phase 2: Additional Adapters

**Goal**: Support Codex and Claude agents with read-only capabilities

**Key Deliverables**:
- Codex adapter with session listing and detail retrieval
- Claude adapter with JSONL parsing
- Unified operations across all three agents
- Cross-agent search functionality
- Adapter compatibility matrix documentation

**Research Requirements**:
- Verify Codex session storage location and format
- Analyze Claude Code JSONL structure
- Document message formats for both agents
- Map agent-specific metadata and tools

**Important**: No write/import functionality in this phase. Focus is read-only access to verify format understanding.

**Success Criteria**: Can list, view, and search sessions from OpenCode, Codex, and Claude (read-only)

---

## Phase 3: Session Export to Common Format

**Goal**: Export sessions to canonical format (read-only, no import yet)

**Key Deliverables**:
- Canonical Session Format (CSF) specification
- Export converters for all three agents
- Security and privacy filtering for attachments
- Context loss measurement and documentation
- Export compatibility matrix

**Canonical Session Format Requirements**:
- Agent-agnostic message structure
- Support for text, code, tool calls, reasoning
- Preserve timestamps and metadata
- Handle attachments with security controls
- Versioned format for future evolution

**Minimal Context Loss Criteria**:

*Preserved (Required)*:
- All user and assistant messages (text content)
- Message order and timestamps
- Session metadata (title, dates)

*Preserved (Best Effort)*:
- Tool calls and results
- Code blocks with language tags
- Reasoning blocks
- Attachments (with security filtering)

*Acceptable Loss*:
- Agent-specific UI state
- Temporary artifacts
- Agent-specific metadata
- Unsupported tool types

**Success Criteria**: Can export any session to CSF with >90% metadata preservation and documented context loss

---

## Phase 4: Export + Experimental Import

**Goal**: Enable session export and experimental import where write paths exist

**Key Deliverables**:
- Export to multiple formats (CSF JSON, Markdown, Plain text)
- Experimental import functionality with validation
- Direct transfer CLI convenience commands
- Compatibility checking and error reporting
- View-only mode via OAS viewer (always supported)

**Import Modes**:

| Agent | View Support | Resume Support | Notes |
|-------|-------------|----------------|-------|
| OpenCode | ✓ | Experimental | Write path needs verification |
| Codex | ✓ | Experimental | Write path needs verification |
| Claude | ✓ | Experimental | Write path needs verification |

**View Support**: Can display imported session in read-only mode
**Resume Support**: Can continue conversation from imported session

**Important**: Import is experimental and not guaranteed to work for all agents. Each agent must have documented write paths before import is attempted.

**Success Criteria**: Can export any session to CSF and view in OAS viewer. Import to destination agents is experimental and agent-dependent.

---

## Phase 5: Session Forking and Advanced Export

**Goal**: Advanced session manipulation and partial exports

**Key Deliverables**:
- Session forking to different agents
- Fork at specific message (branch conversation)
- Fork relationship tracking
- Partial session export (message ranges, filtered content)
- Enhanced metadata preservation with transfer history

**Fork Scenarios**:
- Fork to different agent for specialized task
- Fork at specific message to explore alternatives
- Multiple forks from same source
- Compare fork outcomes

**Success Criteria**: Can fork sessions and export partial sessions with full metadata tracking

---

## Phase 6: Plugin-Aware Features (Optional)

**Goal**: Advanced plugin-aware routing and analytics

**Status**: Optional - depends on stable tool registries and Phase 5 completion

**Key Deliverables**:
- Plugin-aware agent selection
- Batch operations for multiple sessions
- Session analytics and statistics
- Tool usage pattern analysis

**Prerequisites**:
- Stable tool/plugin registries for all agents
- Documented tool equivalents across agents
- Phase 5 fully complete and stable
- User demand validated

**Limitations**:
- Requires stable tool registries (may not exist)
- Tool names may change across versions
- Agent capabilities may vary
- Manual verification recommended

---

## Non-Goals (Scope Control)

To maintain focus and achievability, we explicitly exclude:

### Real-time Session Synchronization
- Sessions are not synced live across agents
- Transfers are explicit, one-time operations
- No automatic sync on session updates

### Bidirectional Real-Time Sync
- No live bidirectional synchronization between agents
- No automatic conflict resolution
- No real-time collaboration features

### Guaranteed Lossless Transfer
- Some context loss is acceptable and expected
- Agent-specific features may not transfer
- Tool calls may not be resumable in destination agent

### Multi-Agent Concurrent Editing
- Only one agent works on a session at a time
- No conflict resolution for concurrent edits

### Session Merging from Multiple Sources
- No automatic merging of divergent sessions
- Manual review is safer

### Agent-to-Agent Direct Communication
- Agents don't communicate directly with each other
- No agent orchestration

### Universal Plugin Compatibility
- Not all tools/plugins will work across agents
- No guarantee of tool equivalents

---

## Implementation Strategy

### Development Approach

1. **Test-Driven Development**: Write tests first for all features
2. **Incremental Delivery**: Ship working features early and often
3. **User Feedback**: Gather feedback at each phase
4. **Documentation First**: Document before implementing
5. **Backward Compatibility**: Maintain compatibility with previous versions

### Testing Strategy

**Unit Tests**: Adapter implementations, format converters, validation logic
**Integration Tests**: End-to-end transfer workflows, multi-agent operations
**Compatibility Tests**: Transfers between all agent pairs, metadata preservation

---

## Success Metrics

### Phase 1-2: Foundation
- Can list sessions from all three agents
- Can view session details with messages
- Can search across all agents
- CLI tool is usable for daily workflows

### Phase 3-4: Export/Import
- Can export any session to CSF
- CSF format is stable and versioned
- Metadata preservation rate > 90%
- Security/privacy filtering working

### Viewable vs. Resumable Transfer

**Viewable Transfer** (Primary Goal):
- Export session from source agent
- View/display session in destination agent (read-only)
- Success rate target: >95%

**Resumable Transfer** (Stretch Goal):
- Export session from source agent
- Import session to destination agent
- Continue conversation from imported session
- Success rate target: >50% (agent-dependent)

---

## Risk Mitigation

### Agent Format Changes
**Impact**: High - Could break adapters
**Mitigation**: Version detection, graceful degradation, regular testing

### Tool Incompatibility
**Impact**: Medium - Limits transfer usefulness
**Mitigation**: Comprehensive tool mapping, clear warnings, suggest alternatives

### Performance Issues
**Impact**: Medium - Poor user experience
**Mitigation**: Performance testing, streaming for large data, progress reporting

### Data Loss During Transfer
**Impact**: High - Loss of user work
**Mitigation**: Dry-run mode, validation and error reporting, backup recommendations

---

## Community and Ecosystem

### Collaboration Opportunities

**Cross Agent Session Resumer (CASR)**: Study their canonical IR approach
**Agent Deck**: Potential integration for UI
**Export Tool Authors**: Leverage existing export tools

### Standards and Specifications

**Canonical Session Format**: Publish specification, seek community feedback
**Tool Mapping Registry**: Community-maintained tool equivalents

---

## References

### Related Projects
- [Cross Agent Session Resumer (CASR)](https://github.com/Dicklesworthstone/cross_agent_session_resumer)
- [Agent Deck](https://github.com/asheshgoplani/agent-deck)
- [cctrace](https://github.com/jimmc414/cctrace)
- [claude-conversation-extractor](https://pypi.org/project/claude-conversation-extractor/)

### Documentation
- [OpenCode Agents](https://opencode.ai/docs/agents/)
- [Claude Agent SDK Sessions](https://platform.claude.com/docs/en/agent-sdk/sessions)
- [GitHub Copilot Sessions](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/track-copilot-sessions)
