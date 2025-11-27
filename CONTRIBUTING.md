# Contributing to Altegio.Pro MCP Server

Thanks for your interest in contributing! This guide will help you get started.

## Code of Conduct

By participating, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## How to Contribute

### Reporting Bugs

Before creating bug reports, check existing issues. Include:
- Clear title and description
- Steps to reproduce
- Expected vs actual behavior
- Environment details (Node.js version, OS)
- Error messages and stack traces

### Suggesting Features

Feature requests are tracked as GitHub issues. Include:
- Clear description of the proposed functionality
- Why this would be useful
- Alternatives you've considered

### Pull Requests

1. Fork the repo and create your branch from `main`
2. Follow coding standards below
3. Add tests for new functionality
4. Update documentation
5. Ensure tests pass: `npm test && npm run lint`

## Development Setup

### Prerequisites

- Node.js >= 18
- npm
- Git
- Altegio Partner Token from [developer.alteg.io](https://developer.alteg.io)

### Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/altegio-mcp.git
cd altegio-mcp

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env and add ALTEGIO_API_TOKEN

# Build and test
npm run build
npm test
```

### Project Structure

```
src/
  config/        # Configuration and validation
  providers/     # API clients (altegio-client.ts)
  tools/         # MCP tool handlers & registry
  types/         # TypeScript interfaces
  utils/         # Logging, errors, helpers
  __tests__/     # Jest unit tests
  index.ts       # stdio server entry
  http-server.ts # HTTP server entry

tests/           # Additional test files
examples/        # Usage examples
docs/            # Documentation
```

## Coding Standards

### TypeScript

- Use strict mode (already enabled)
- Type all function parameters and return values
- Avoid `any` - use `unknown` with type guards
- Use `interface` for objects, `type` for unions

### Formatting

- **Prettier** handles formatting (run `npm run format`)
- 2 spaces indentation
- Single quotes for strings
- Trailing commas in multiline

### Linting

```bash
npm run lint      # Check issues
npm run lint:fix  # Auto-fix issues
```

All warnings must be resolved before merging.

### Testing

- Write tests for all new features
- Maintain or improve coverage (currently 68 tests)
- Use Jest with descriptive test names
- Mock external dependencies
- Test edge cases and errors

Example test structure:

```typescript
describe('Feature', () => {
  it('should do something specific', async () => {
    // Arrange
    const client = new AltegioClient(config, testDir);

    // Act
    const result = await client.someMethod();

    // Assert
    expect(result).toBeDefined();
  });
});
```

Run tests:
```bash
npm test              # All tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage
```

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <description>

[optional body]
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `refactor`: Code refactoring
- `test`: Test changes
- `chore`: Build/tooling changes
- `ci`: CI/CD changes

**Examples:**
```
feat: add support for client management tools
fix: handle expired token refresh correctly
docs: update Claude Desktop setup guide
```

## Documentation

### Code Comments

Use JSDoc for public APIs:

```typescript
/**
 * Login to Altegio with email and password
 *
 * @param email - User's Altegio email
 * @param password - User's password
 * @returns Promise with login response
 * @throws {AuthenticationError} If credentials invalid
 */
async login(email: string, password: string): Promise<AltegioLoginResponse>
```

### README Updates

Update README.md when:
- Adding new tools
- Changing configuration options
- Modifying installation steps

## Development Workflow

1. **Create branch:** `git checkout -b feature/my-feature`
2. **Make changes:** Follow coding standards
3. **Test:** `npm test && npm run lint`
4. **Commit:** Use conventional commits
5. **Push:** `git push origin feature/my-feature`
6. **PR:** Open pull request with clear description

## CI/CD

Push to `main` triggers:
1. Cloud Build via GitHub trigger
2. Docker image build and push to Artifact Registry
3. Automatic deployment to Cloud Run staging

See [CI-CD.md](CI-CD.md) for details.

## Questions?

- Open an issue for general questions
- Check [GitHub Discussions](https://github.com/altegio/altegio-pro-mcp/discussions)
- Review existing documentation

## Recognition

Contributors are recognized in GitHub contributors page and release notes.

Thank you for contributing!
