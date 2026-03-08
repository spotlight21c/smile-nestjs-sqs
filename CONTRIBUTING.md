# Contributing

## Development

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
```

## Versioning Policy

This project uses release-please with Conventional Commits.

- Follow commit conventions for user-facing changes:

- `fix:` -> `patch`
- `feat:` -> `minor`
- `feat!:` or `BREAKING CHANGE:` footer -> `major`
- Do not manually edit `package.json` version.
