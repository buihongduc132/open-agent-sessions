# Cross-Agent Roadmap Refinement Summary

**Date**: March 3, 2026  
**Status**: Refined based on verifier feedback

## Overview

The cross-agent roadmap has been refined to address all critical concerns raised by the verifier. The roadmap is now more realistic, achievable, and properly scoped.

## Critical Issues Addressed

### 1. Bidirectional Import Dependencies (Phase 4)
**Issue**: Bidirectional import depends on undocumented write paths  
**Resolution**:
- Phase 4 renamed to "Export to CSF + Read-Only Imports (Where Supported)"
- Import marked as EXPERIMENTAL, not guaranteed
- Added clear definition of "import" per agent (view vs. resume)
- Write paths must be verified before import is attempted
- View-only mode always supported as fallback

### 2. Direct Transfer Scope Creep (Phase 5)
**Issue**: Direct transfer was just a UX wrapper, should be merged  
**Resolution**:
- Direct transfer merged into Phase 4 as CLI convenience
- Phase 5 renamed to "Session Forking and Advanced Export"
- Focus shifted to forking, partial export, metadata preservation
- Removed redundant transfer functionality

### 3. Plugin-Aware Routing Speculation (Phase 6)
**Issue**: Plugin-aware routing is speculative without tool registries  
**Resolution**:
- Phase 6 renamed to "Optional: Plugin-Aware Features"
- Marked explicitly as OPTIONAL
- Added clear dependencies and prerequisites
- Documented limitations (requires stable tool registries)
- Can be skipped if prerequisites not met

### 4. Rollback on Failure Unrealistic
**Issue**: Automatic rollback may be unrealistic for import operations  
**Resolution**:
- Changed "Rollback on failure" to "Validation and error reporting"
- Clarified: source data unchanged on failure (no rollback needed)
- Added dry-run validation mode
- Emphasized graceful degradation (fall back to view-only)

### 5. CLI Doesn't Exist Yet (Phase 1)
**Issue**: Phase 1 must complete CLI before multi-agent work  
**Resolution**:
- Added explicit requirement: CLI must be complete before Phase 2
- Added "Critical Requirement" section in Phase 1
- Emphasized OpenCode must be fully stable before other adapters
- Updated success criteria to include CLI completion

## Missing Elements Added

### 1. Codex Storage Verification Plan
**Added**:
- Risk gate between Phase 1 and Phase 2
- Explicit Codex format verification requirement
- Research tasks marked as CRITICAL
- Versioned adapter compatibility matrix

### 2. Clear Definition of "Import" Per Agent
**Added**:
- Table showing view vs. resume support per agent
- Clear distinction between viewable and resumable transfer
- Agent-specific import capabilities documented
- Success metrics separated for view vs. resume

### 3. Security/Privacy for Attachments and Tool Outputs
**Added**:
- Security and Privacy section in Phase 3
- Attachment handling with security filtering
- Tool output sanitization
- PII filtering and redaction
- Privacy-preserving export options

### 4. Versioned Adapter Compatibility Matrix
**Added**:
- Compatibility matrix in Phase 2
- Version tracking for adapters and formats
- Status column (Stable, Research, Experimental)
- Notes on format verification needs

### 5. Criteria for "Minimal Context Loss"
**Added**:
- Detailed "Minimal Context Loss Criteria" section
- Preserved (Required) vs. Preserved (Best Effort) vs. Acceptable Loss
- Measurement metrics with specific targets
- Message preservation rate: >99%
- Metadata preservation rate: >90%
- Tool call preservation rate: >80%

## New Section: Risk Gates and Verification

Added comprehensive risk gates between all phases:

### Phase 1 → 2 Gate
- OpenCode CLI fully functional
- Adapter tested with real sessions
- No critical bugs

### Phase 2 → 3 Gate
- Codex format confirmed and documented
- Read-only adapters validated
- Compatibility matrix complete

### Phase 3 → 4 Gate
- CSF export validated with real sessions
- Security/privacy filtering tested
- Context loss within acceptable limits

### Phase 4 → 5 Gate
- At least one import path proven
- User feedback incorporated
- Security controls tested

### Phase 5 → 6 Gate
- User demand for Phase 6 confirmed
- Tool registries available and stable
- Phase 5 fully complete

Each gate includes:
- Clear criteria
- Verification method
- Failure handling

## Updated Non-Goals

Added to scope control:

1. **Bidirectional Real-Time Sync**: No live synchronization
2. **Guaranteed Lossless Transfer**: Some context loss acceptable
3. **Universal Plugin Compatibility**: Tool ecosystems differ

## Updated Success Metrics

### Separated Viewable vs. Resumable Transfer

**Viewable Transfer** (Primary Goal):
- Export + view in destination (read-only)
- Success rate target: >95%

**Resumable Transfer** (Stretch Goal):
- Export + import + continue conversation
- Success rate target: >50% (agent-dependent)

### Phase-Specific Metrics

- Phase 1-2: Read-only adapters stable
- Phase 3-4: Export working, import experimental
- Phase 5: Forking and partial export
- Phase 6: Optional features (if prerequisites met)

## Updated Timeline

Adjusted to be more realistic:

| Phase | Version | Target | Change |
|-------|---------|--------|--------|
| 1 | v0.2.0 | Q1 2026 | No change |
| 2 | v0.3.0 | Q2 2026 | No change |
| 3 | v0.4.0 | Q3 2026 | No change |
| 4 | v0.5.0 | Q4 2026 | Extended from Q3-Q4 |
| 5 | v0.6.0 | Q1 2027 | Extended from Q4 2026 |
| 6 | v0.7.0+ | Q2 2027+ | Extended from 2027+ |

## Key Changes Summary

### Phase 1 (v0.2.0)
- ✅ Added CLI completion requirement
- ✅ Added session detail parsing and display
- ✅ Emphasized OpenCode must be complete before Phase 2

### Phase 2 (v0.3.0)
- ✅ Added risk gate from Phase 1
- ✅ Marked adapters as READ-ONLY
- ✅ Added versioned compatibility matrix
- ✅ Emphasized format verification

### Phase 3 (v0.4.0)
- ✅ Renamed to "Session Export to Common Format"
- ✅ Removed import functionality (deferred to Phase 4)
- ✅ Added security/privacy handling
- ✅ Added minimal context loss criteria

### Phase 4 (v0.5.0)
- ✅ Renamed to "Export to CSF + Read-Only Imports (Where Supported)"
- ✅ Import marked as EXPERIMENTAL
- ✅ Added clear definition of import per agent
- ✅ Merged direct transfer from old Phase 5
- ✅ Changed rollback to validation and error reporting

### Phase 5 (v0.6.0)
- ✅ Renamed to "Session Forking and Advanced Export"
- ✅ Removed direct transfer (merged to Phase 4)
- ✅ Focus on forking and partial export
- ✅ Added metadata preservation

### Phase 6 (v0.7.0+)
- ✅ Renamed to "Optional: Plugin-Aware Features"
- ✅ Marked explicitly as OPTIONAL
- ✅ Added clear dependencies
- ✅ Moved analytics and batch operations here

## Verification Checklist

All verifier concerns addressed:

- [x] Bidirectional import dependencies documented
- [x] Direct transfer merged into Phase 4
- [x] Plugin-aware routing marked as optional
- [x] Rollback reworded to validation
- [x] CLI completion required before Phase 2
- [x] Codex storage verification plan added
- [x] Clear definition of "import" per agent
- [x] Security/privacy for attachments
- [x] Versioned adapter compatibility matrix
- [x] Criteria for "minimal context loss"
- [x] Risk gates between all phases
- [x] Updated non-goals
- [x] Separated viewable vs. resumable transfer
- [x] Realistic timeline

## Next Steps

1. **Request Re-Verification**: Submit refined roadmap to verifier
2. **Gather Feedback**: Collect feedback on refinements
3. **Finalize Phase 1**: Complete OpenCode CLI and adapter
4. **Begin Phase 2**: Start Codex/Claude research after Phase 1 gate

## Conclusion

The roadmap is now:
- **Realistic**: Achievable goals with clear prerequisites
- **Properly Scoped**: No scope creep, clear non-goals
- **Risk-Aware**: Risk gates prevent building on unstable foundations
- **User-Focused**: Viewable transfer as primary goal, resumable as stretch
- **Flexible**: Optional Phase 6 can be skipped if prerequisites not met

The refined roadmap addresses all verifier concerns and provides a solid foundation for cross-agent session management.
