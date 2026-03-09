# Contributing to open-agent-sessions

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing to the project.

## Code of Conduct

This project adheres to the Contributor Covenant Code of Conduct. By participating, you are expected to uphold this code. Please report unacceptable behavior by opening a GitHub Issue on this repository.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/yourusername/open-agent-sessions.git`
3. Install dependencies: `bun install`
4. Create a branch: `git checkout -b feature/your-feature-name`
5. Make your changes
6. Run tests: `bun test`
7. Commit your changes
8. Push to your fork
9. Open a Pull Request

## Development Philosophy

### Test-Driven Development (TDD)

This project strictly follows TDD principles:

1. **Write tests first**: Before implementing any feature, write tests that describe the expected behavior
2. **Red-Green-Refactor cycle**:
   - Red: Write a failing test
   - Green: Write minimal code to make the test pass
   - Refactor: Improve code while keeping tests green
3. **Test coverage**: All new features must have comprehensive test coverage
4. **No untested code**: Code without tests will not be merged

### Example TDD Workflow

```bash
# 1. Write a failing test
# Edit test/my-feature.test.ts

# 2. Run tests to see it fail
bun test test/my-feature.test.ts

# 3. Implement minimal code to pass
# Edit src/my-feature.ts

# 4. Run tests to see it pass
bun test test/my-feature.test.ts

# 5. Refactor if needed
# Edit src/my-feature.ts

# 6. Ensure all tests still pass
bun test
```

## Testing Guidelines

### Writing Tests

- Use descriptive test names that explain the behavior being tested
- Follow the Arrange-Act-Assert pattern
- Test edge cases and error conditions
- Keep tests focused and independent
- Use test fixtures for complex data

### Test Organization

```typescript
import { describe, test, expect } from "bun:test";

describe("MyFeature", () => {
  describe("methodName", () => {
    test("should handle normal case", () => {
      // Arrange
      const input = "test";
      
      // Act
      const result = myMethod(input);
      
      // Assert
      expect(result).toBe("expected");
    });

    test("should throw error for invalid input", () => {
      expect(() => myMethod(null)).toThrow("Invalid input");
    });
  });
});
```

### Running Tests

```bash
# Run all tests
bun test

# Run specific test file
bun test test/config.test.ts

# Run tests matching pattern
bun test --test-name-pattern "OpenCode"

# Watch mode for development
bun test --watch
```

## Code Style

### TypeScript Guidelines

- Use TypeScript strict mode
- Provide explicit types for function parameters and return values
- Avoid `any` type; use `unknown` if type is truly unknown
- Use interfaces for object shapes
- Use type aliases for unions and complex types

### Naming Conventions

- **Files**: kebab-case (e.g., `session-registry.ts`)
- **Classes**: PascalCase (e.g., `SessionRegistry`)
- **Functions**: camelCase (e.g., `listSessions`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `DEFAULT_TIMEOUT`)
- **Interfaces**: PascalCase (e.g., `SessionSummary`)
- **Types**: PascalCase (e.g., `AgentKind`)

### Code Organization

- One feature per file
- Export public API from index.ts
- Keep functions small and focused
- Use meaningful variable names
- Add comments for complex logic only

## Pull Request Process

### Before Submitting

1. Ensure all tests pass: `bun test`
2. Verify TypeScript compilation: `bun build`
3. Update documentation if needed
4. Add tests for new features
5. Follow the code style guidelines

### PR Description Template

```markdown
## Description
Brief description of the changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
- [ ] All existing tests pass
- [ ] New tests added for new features
- [ ] Manual testing performed

## Checklist
- [ ] Code follows project style guidelines
- [ ] Tests written following TDD approach
- [ ] Documentation updated
- [ ] No breaking changes (or documented if necessary)
```

### Review Process

1. Pull requests will be reviewed
2. Address any feedback or requested changes
3. Once approved, the PR will be merged
4. Contributions will be credited in the changelog

## Feature Requests and Bug Reports

### Reporting Bugs

Use the bug report template and include:

- Clear description of the bug
- Steps to reproduce
- Expected behavior
- Actual behavior
- Environment details (OS, Bun version, etc.)
- Relevant logs or error messages

### Requesting Features

Use the feature request template and include:

- Clear description of the feature
- Use case and motivation
- Proposed API or interface
- Alternative solutions considered

## Development Setup

### Prerequisites

- [Bun](https://bun.sh) v1.0 or higher
- Git
- Text editor or IDE with TypeScript support

### Project Structure

```
src/
├── adapters/       # Platform-specific implementations
├── cli/            # Command-line interface
├── config/         # Configuration management
├── core/           # Core functionality
├── tui/            # Terminal UI
└── index.ts        # Public API

test/               # Test files (mirror src/ structure)
```

### Adding a New Adapter

1. Create adapter file in `src/adapters/`
2. Implement the `Adapter` interface
3. Write comprehensive tests in `test/`
4. Update adapter factory in `src/adapters/index.ts`
5. Update documentation

### Adding a New CLI Command

1. Create command file in `src/cli/`
2. Implement command logic
3. Write tests in `test/`
4. Update CLI entry point
5. Update README with usage examples

## Documentation

- Keep README.md up to date
- Document public APIs with JSDoc comments
- Update ROADMAP.md for significant features
- Add examples for new features

## Questions?

- Open a discussion on GitHub
- Check existing issues and PRs
- Review the documentation

Thank you for contributing to open-agent-sessions!
