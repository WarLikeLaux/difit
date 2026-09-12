# Security policy for the local fork

This fork is a personal local Git diff viewer. Its security boundary is the authenticated Difit
HTTP interface, not `localhost` by itself. Git operations and editor launches explicitly requested
by the authenticated user remain intended functionality.

## Access model

- Browser access uses the configured HTTPS hub origin. The access key is generated locally and is
  entered only in the login form; it is never placed in a URL or browser storage.
- A successful login creates an opaque random session ID. Only its SHA-256 digest and server-side
  expiry are persisted. Browser sessions last at most 30 days and use a host-only
  `__Host-difit_session` cookie with `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/`.
- Logout revokes that browser session server-side. `difit auth revoke` revokes every browser
  session. `difit auth rotate` also replaces the browser access key. Existing SSE connections are
  revalidated and closed after expiry or revocation without stopping review servers.
- CLI commands use a separate opaque credential read automatically from a private local file.
  `difit auth rotate-cli` invalidates it and disconnects existing CLI watchers.
- Hub and viewer ports bind to loopback by default, but both still enforce authentication, Host,
  exact Origin, and Fetch Metadata checks. Forwarded headers are not trusted to construct the
  public origin. Direct HTTP viewer ports intentionally provide no browser-login downgrade.
- Responses use `Referrer-Policy: same-origin` so native same-origin login and logout forms retain
  a verifiable Origin. Cross-origin referrers remain suppressed, and `Origin: null` is not accepted
  globally.

Authentication state is stored under `${DIFIT_CONFIG_DIR:-~/.difit}/auth`. Directories are mode
`0700`; key, CLI credential, origin, and session files are mode `0600`. The browser access key must
be recoverable for `difit auth key`, so it is stored as a local secret rather than as a one-way
digest. Session tokens themselves are never stored verbatim. Changing the configured browser key
invalidates all sessions; changing the CLI token does not affect browser sessions.

## Untrusted content

Diff text, file names, comments, Markdown, SVG, and Mermaid input are untrusted. Rendering uses
text nodes or sanitization and restrictive CSP; active previews must remain isolated from the
privileged origin and may not load arbitrary remote resources. Passive Git diff operations disable
both external diff drivers and text conversion. Request bodies and displayed blobs have bounded
sizes, and repository-relative paths are checked before filesystem access.

## Network and supply chain

Starting the local server, leaving it idle, and viewing local diffs do not intentionally contact
analytics, CDNs, relays, or update services. Explicit GitHub/GitLab operations invoke the user's
authenticated `gh`/`glab` tools and may access those services. Opening a user-selected external
link or editor and running user-selected tools are also explicit actions. Packaging the VS Code
extension may fetch platform-specific `@parcel/watcher` archives from the npm registry; each
archive's digest is required to match the integrity value already pinned in `pnpm-lock.yaml` before
extraction.

The workspace lockfile covers the root package and the bundled VS Code extension. pnpm's build
allowlist limits dependency install scripts to the native/build tools required by this project.
CI uses frozen installs and fails on low-or-higher advisories in both production and development/
build dependencies. The transitive `@babel/core` used only by the lint plugin is pinned to a patched
Babel 7 release rather than hidden by a severity-wide audit exception. CI also runs CodeQL, scans
the current working tree and complete Git history in separate steps with a pinned/checksummed
Gitleaks binary in redacted mode, and verifies that Actions are pinned and checkout credentials are
not persisted. The weekly security job reports advisories; it never installs dependency updates
automatically.

## Reporting and limitations

Do not include real access keys, CLI tokens, session cookies, source files, or terminal history in
reports. This policy reduces the attack surface but is not a claim that every vulnerability is
excluded. A process already running as the same OS user can read user-owned files and is outside the
browser-origin boundary described here.
