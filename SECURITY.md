# Security Policy

Noah is preparing for a public `0.1` beta. Treat the current project as early-stage software and do not use default development secrets in production.

## Supported Versions

Security support starts with the first public SemVer release.

| Version | Supported |
| --- | --- |
| `0.1.x` | Planned after `v0.1.0` |
| Unreleased source snapshots | Best effort only |

## Reporting A Vulnerability

Do not report vulnerabilities in public issues.

Use GitHub private vulnerability reporting when it is enabled for the public repository. Until then, contact the maintainers through a private channel and include:

- affected commit or version;
- vulnerable component;
- reproduction steps;
- impact;
- suggested mitigation, if known.

## Secret Handling

- Never commit real deployment secrets.
- Rotate any secret that appears in git history before making the repository public.
- Replace all placeholder tokens from `.env.*.example` before exposing a self-hosted deployment.

## Beta Limitations

The `0.1` beta is not a hardened multi-tenant SaaS distribution. Current known gaps include production auth hardening, fine-grained permissions, and complete operational monitoring.
