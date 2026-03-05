# Security Policy

## Supported Versions

We release patches for security vulnerabilities. Currently supported versions:

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | [SUPPORTED]        |

## Reporting a Vulnerability

We take the security of open-agent-sessions seriously. If you believe you have found a security vulnerability, please report it to us as described below.

### Please Do Not

- Open a public GitHub issue for security vulnerabilities
- Disclose the vulnerability publicly before it has been addressed

### Please Do

1. **Email us directly** at security@example.com <!-- TODO: Update with actual security contact email -->
2. **Provide detailed information** including:
   - Description of the vulnerability
   - Steps to reproduce the issue
   - Potential impact
   - Suggested fix (if any)
3. **Allow time for response**: We aim to respond within 48 hours
4. **Work with us**: We may need additional information to understand and address the issue

### What to Expect

1. **Acknowledgment**: We will acknowledge receipt of your vulnerability report within 48 hours
2. **Assessment**: We will assess the vulnerability and determine its impact and severity
3. **Fix Development**: We will work on a fix and keep you informed of progress
4. **Disclosure**: Once a fix is available, we will:
   - Release a security patch
   - Publish a security advisory
   - Credit you for the discovery (unless you prefer to remain anonymous)

### Security Update Process

When a security vulnerability is confirmed:

1. A fix will be developed in a private repository
2. A security advisory will be drafted
3. A new version will be released with the fix
4. The security advisory will be published
5. Users will be notified through:
   - GitHub Security Advisories
   - Release notes
   - Project README

## Security Best Practices

When using open-agent-sessions:

### Configuration Files

- Store configuration files securely
- Do not commit configuration files with sensitive paths to version control
- Use environment variables for sensitive configuration when possible
- Restrict file permissions on configuration files

### Database Access

- Ensure session databases have appropriate file permissions
- Do not expose session databases over network shares
- Back up session data securely
- Consider encrypting sensitive session data at rest

### API Usage

- Validate all input when using the programmatic API
- Handle errors appropriately to avoid information leakage
- Use the latest version of the library
- Keep dependencies up to date

### Session Data

- Session data may contain sensitive information
- Implement appropriate access controls
- Consider data retention policies
- Sanitize session data before sharing or exporting

## Known Security Considerations

### Session Data Privacy

Session data may contain:
- User prompts and AI responses
- File paths and directory structures
- Code snippets and project information
- Potentially sensitive conversation history

**Recommendation**: Treat session databases and JSONL files as sensitive data.

### File System Access

The library reads from:
- SQLite database files
- JSONL files
- Configuration files

**Recommendation**: Ensure proper file permissions and access controls.

### Dependencies

This project uses:
- Bun runtime
- TypeScript
- Minimal external dependencies

**Recommendation**: Regularly update dependencies and monitor for security advisories.

## Security Checklist for Contributors

When contributing code:

- [ ] No hardcoded credentials or sensitive data
- [ ] Input validation for all user-provided data
- [ ] Proper error handling without information leakage
- [ ] No SQL injection vulnerabilities (use parameterized queries)
- [ ] File path validation to prevent directory traversal
- [ ] Appropriate file permission checks
- [ ] Dependencies are up to date
- [ ] Security implications documented

## Disclosure Policy

We follow responsible disclosure principles:

1. Security issues are fixed privately
2. Fixes are released before public disclosure
3. Security advisories are published after fixes are available
4. Credit is given to security researchers (with permission)

## Contact

For security concerns, please contact: security@example.com <!-- TODO: Update with actual security contact email -->

For general questions, use GitHub Issues or Discussions.

## Updates to This Policy

This security policy may be updated from time to time. Please check back periodically for changes.

Last updated: March 2, 2026
