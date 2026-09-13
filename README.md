<h1 align="center">
  <img src="public/logo.png" alt="difit" width="260">
</h1>

<p align="center">
  <strong>English</strong> · <a href="./README-ru.md">Русский</a>
</p>

# Difit maintained fork

This is a maintained fork of [yoshiko-pg/difit](https://github.com/yoshiko-pg/difit), built for persistent local reviews shared between a browser and coding agents. It keeps difit’s GitHub-style diff viewer and adds a review hub, durable feedback delivery, a Codex plugin, and an MCP server.

Read the [upstream README](https://github.com/yoshiko-pg/difit#readme) for the full product overview, supported diff formats, keyboard shortcuts, and standard CLI usage. This README covers the fork-specific behavior and setup.

## What this fork changes

| Area              | Fork behavior                                                                                        | Practical effect                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Review hub        | `difit hub` serves reviews from multiple repositories on one origin                                  | Old and current reviews remain easy to find without tracking viewer ports                                    |
| Offline reviews   | The hub stores the last rendered diff, comments, and review state                                    | A review stays readable when its viewer stops or the checkout changes branch                                 |
| Agent inbox       | User replies and `To verify` transitions enter a durable, acknowledged event queue                   | Feedback waits for the agent attached to that exact review and survives restarts                             |
| Review identity   | Repository, branch, and diff base are part of the review identity                                    | Comments from an old branch are not delivered to an unrelated working tree                                   |
| Agent integration | One Codex plugin contains the `difit` skill and a stdio MCP server                                   | Agents can open reviews, read events, reply, edit comments, and update thread status through one integration |
| Review workflow   | Threads use `Open`, `Accepted`, `To verify`, `Ready`, and `Resolved` states                          | The agent can return a fix for verification; only the reviewer resolves the thread                           |
| GitLab            | The CLI detects merge requests and adds file and line links                                          | A local review can jump back to the matching GitLab MR context                                               |
| Security          | Hub and viewer requests require authentication and enforce host, origin, content, and Git boundaries | Loopback is not treated as a security boundary by itself                                                     |

The separate `difit-review` skill was intentionally removed. The maintained skill lives at [`plugins/difit/skills/difit`](plugins/difit/skills/difit), with [`skills/difit`](skills/difit) kept as a repository-local compatibility link.

## Install this fork

This repository does not publish a separate npm package. These upstream commands do **not** install the fork:

```sh
npx difit
npm install --global difit
npx skills add yoshiko-pg/difit
```

Install the `custom` branch from source instead. Node.js 21 or newer, Git, and pnpm 11.6.0 are required.

```sh
git clone --branch custom --single-branch https://github.com/WarLikeLaux/difit.git
cd difit
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm add --global .
difit --version
```

To update an existing installation:

```sh
git switch custom
git pull --ff-only origin custom
pnpm install --frozen-lockfile
pnpm build
pnpm add --global .
```

## Run the review hub

The browser dashboard is designed to sit behind a local HTTPS reverse proxy. The proxy and local hostname are environment configuration; they are not installed by difit.

For a proxy that maps `https://difit.local` to `127.0.0.1:4965`:

```sh
difit hub --host 127.0.0.1 --port 4965 --public-origin https://difit.local
```

Open the configured HTTPS origin. On first use, retrieve the browser access key in a trusted terminal and enter it on the login page:

```sh
difit auth key
```

Then start a review from the repository being reviewed:

```sh
difit . --include-untracked --background
```

The review appears in the hub. A working-tree review follows its original branch while connected. If that checkout moves to another branch, the stored review becomes read-only until a viewer reconnects with the same review identity. Comments added while it is offline remain queued.

Deleting a review from the dashboard permanently removes that review’s snapshot, comments, and pending events.

## Codex plugin and MCP

The plugin bundle is in [`plugins/difit`](plugins/difit). Its manifest installs the maintained skill and starts the MCP server with:

```sh
difit mcp
```

The `difit` executable must therefore be available on the MCP server’s `PATH`. Other MCP clients can use the checked-in [`plugins/difit/.mcp.json`](plugins/difit/.mcp.json) configuration:

```json
{
  "mcpServers": {
    "difit": {
      "command": "difit",
      "args": ["mcp"]
    }
  }
}
```

MCP and CLI commands talk to the same authenticated local API. The CLI remains the fallback when the plugin is unavailable.

In HAPI, start the viewer from the agent session’s shell so it inherits the current session identity. The viewer can then wake that session when feedback arrives. MCP handles later review operations; it should not start the HAPI-bound viewer from a long-lived process that lacks the current session context.

## CLI additions

The upstream diff targets still work. This fork adds the following entry points:

```sh
difit hub --host 127.0.0.1 --port 4965 --public-origin https://difit.local
difit mcp
difit review context --port <viewer-port>
difit comment events --port <viewer-port>
difit comment ack <through-seq> --port <viewer-port>
difit comment watch --port <viewer-port> --cursor-file <path>
```

The MCP server exposes the same review lifecycle: start or discover a review, inspect context and threads, receive and acknowledge events, create or edit messages, and change agent-owned thread states.

## Security boundary

Use the HTTPS hub for browser access. Direct HTTP viewer ports bind to loopback by default but do not provide a weaker browser login. CLI and MCP calls authenticate separately without putting credentials in URLs.

Diffs, filenames, comments, Markdown, SVG, and Mermaid input are treated as untrusted. The fork also disables executable Git diff converters for passive reads and checks repository-relative paths before filesystem access. See the [fork security policy](.github/SECURITY.md) for the complete trust model and limitations.

## Development and upstream updates

The default fork branch is `custom`. Run the standard checks before pushing changes:

```sh
pnpm check
pnpm test
pnpm build
```

Upstream changes are reviewed and merged into `custom`; do not reset `custom` to `upstream/main`, because that would discard the fork’s review lifecycle and security work.

```sh
git remote add upstream https://github.com/yoshiko-pg/difit.git # once
git fetch upstream
git switch custom
git merge --no-ff upstream/main
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

Resolve conflicts in favor of the fork’s documented behavior, especially authentication, content isolation, durable review identity, and the `custom`-branch CI policy. Dependency and security workflows report problems; they do not update packages automatically.

See [CHANGELOG.md](CHANGELOG.md) for upstream releases and [`.github/SECURITY.md`](.github/SECURITY.md) for fork-specific security details.

## License

[MIT](LICENSE), matching upstream.
