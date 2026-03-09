# Purpose

## Project Vision

The open-agent-sessions project aims to unify session reading and management across multiple CLI AI agents (OpenCode, Codex, Claude) to enable seamless cross-agent workflows.

### Core Capabilities

1. **Unified Session Reader**: Single interface to read sessions from any CLI agent
   - Access sessions from OpenCode, Codex, and Claude through one API
   - Normalize session data into a common format
   - Support multiple storage backends (SQLite, JSONL, etc.)

2. **Cross-Agent Session Transfer**: Transfer conversations/sessions between agents
   - Move a session from OpenCode to Codex or Claude
   - Preserve conversation history and context
   - Maintain metadata and session state

3. **Seamless Resume**: Continue work in a different agent without context loss
   - Pick up where you left off in a different agent
   - Full conversation history available
   - Tool and plugin context preserved where possible

4. **Session Forking**: Branch conversations to different agents
   - Create a copy of a session in another agent
   - Experiment with different agents on the same problem
   - Compare agent capabilities and responses

5. **Plugin Utilization**: Leverage agent-specific plugins by moving sessions to the agent with needed capabilities
   - Identify which agent has the required plugins/tools
   - Transfer session to the agent with the best capabilities
   - Enable specialized workflows across agents

## Current State

### Implemented
- OpenCode adapter with full support for:
  - SQLite database sessions
  - JSONL file sessions
  - Session listing with sorting
  - Session detail retrieval
  - Session search
- Configuration system for managing multiple agent instances
- Adapter registry for extensible agent support
- Session data normalization across different formats

### In Progress
- CLI commands for session operations
- Session detail retrieval with message filtering
- Terminal UI for interactive browsing

### Planned
- Codex adapter implementation
- Claude adapter implementation
- Session transfer/cloning functionality
- Cross-agent compatibility layer

## Future Vision

Enable developers to:

### Workflow Flexibility
- **Start work in OpenCode**, transfer to Codex for specific tooling
  - Example: Begin debugging in OpenCode, move to Codex for specialized analysis tools
- **Fork a session to Claude** for different model capabilities
  - Example: Use Claude's reasoning for complex architectural decisions
- **Resume interrupted work** in any compatible agent
  - Example: Start on desktop, continue on laptop with different agent
- **Maintain full conversation history** across agent boundaries
  - No context loss when switching agents
  - Complete audit trail of work across platforms

### Agent-Specific Strengths
- **OpenCode**: Fast iteration, integrated development workflows
- **Codex**: Specialized code analysis and refactoring tools
- **Claude**: Advanced reasoning and architectural guidance

### Use Cases

1. **Multi-Agent Development Workflow**
   - Use OpenCode for rapid prototyping
   - Transfer to Codex for code review and optimization
   - Fork to Claude for architectural review

2. **Specialized Tool Access**
   - Start in your preferred agent
   - Transfer to agent with specific plugins when needed
   - Return to original agent with enhanced context

3. **Cross-Agent Collaboration**
   - Share sessions across different agents seamlessly
   - Maintain consistent conversation history
   - Enable agent-agnostic workflows

4. **Experimentation and Comparison**
   - Fork sessions to test different agents on same problem
   - Compare agent responses and capabilities
   - Choose best agent for specific tasks

## Technical Philosophy

### Design Principles

1. **Read-Only by Default**: Session reading is non-destructive
2. **Explicit Transfers**: Session transfers require explicit user action
3. **Metadata Preservation**: Maintain as much context as possible during transfers
4. **Graceful Degradation**: Handle incompatibilities transparently
5. **Extensibility**: Easy to add new agent adapters

### Non-Goals

To maintain focus and achievability, we explicitly exclude:

1. **Real-time session synchronization**: Sessions are not synced live across agents
2. **Multi-agent concurrent editing**: Only one agent works on a session at a time
3. **Session merging from multiple sources**: No automatic merging of divergent sessions
4. **Agent-to-agent direct communication**: Agents don't communicate directly with each other
5. **Session history rewriting**: Original session data is preserved

## Success Metrics

The project will be considered successful when:

1. Developers can list and search sessions across all three agents (OpenCode, Codex, Claude)
2. Sessions can be transferred between agents with minimal context loss
3. The transfer process is simple and intuitive (single command)
4. Session data is preserved accurately during transfers
5. The tool is reliable enough for daily development workflows

## Roadmap Alignment

This purpose statement aligns with the phased roadmap:

- **Phase 1-2**: Foundation and core features (session reading)
- **Phase 3**: Additional adapters (Codex, Claude)
- **Phase 4**: Cross-agent transfer capabilities
- **Phase 5**: Advanced features and polish
- **Phase 6**: Ecosystem and integrations

See [CROSS_AGENT_ROADMAP.md](CROSS_AGENT_ROADMAP.md) for detailed implementation roadmap.

---

Last updated: March 3, 2026
