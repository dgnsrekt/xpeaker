# Security Policy

Xpeaker is a browser extension. Because it runs inside your browser and can
read page content on the sites it's granted access to, I take security and
privacy reports seriously. Thanks for helping keep users safe.

## Supported versions

Only the latest published release receives security fixes. Please make sure
you're on the current version before reporting.

| Version        | Supported          |
| -------------- | ------------------ |
| Latest release | :white_check_mark: |
| Older releases | :x:                |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/dgnsrekt/xpeaker/security).
2. Click **Report a vulnerability** to open a private advisory.

If you can't use that, you may contact the maintainer directly at
**dgnsrekt@pm.me**.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a minimal example helps).
- The extension version and browser/OS you tested on.

## What to expect

- I'll acknowledge your report as soon as I'm able.
- I'll confirm the issue, work on a fix, and keep you updated on progress.
- Once a fix ships, I'm happy to credit you in the advisory unless you'd
  prefer to stay anonymous.

## Scope

In scope:

- The extension code in this repository (background, content, offscreen,
  popup, and options scripts).
- Handling of user data and permissions declared in `manifest.json`.

Out of scope:

- Vulnerabilities in vendored third-party libraries (e.g. the bundled
  Transformers.js / ONNX Runtime files under `vendor/`) — please report
  those upstream, though a heads-up here is welcome.
- Issues that require a compromised device or a malicious browser build.
