# exeuntu (minimal)

A fork of [boldsoftware/exeuntu](https://github.com/boldsoftware/exeuntu), the
exe.dev base image, with the exe.dev-specific parts removed: Shelley and its
headless Chromium, the `exeuntu` helper CLI, the bundled coding agents and
their exe.dev plugins, `/exe.dev/setup`, the MOTD, nginx and the exe.dev
branding.

What's left is an Ubuntu 26.04 dev box that boots systemd as PID 1 and acts
like a small VM under [cyac](https://github.com/containmentzone/cyacrt):

- `/usr/local/bin/init` mounts cgroup2 if needed and execs systemd.
- The login user is `ubuntu` (uid 1000, passwordless sudo, lingering),
  advertised with the `cyac.nullvoid.space/login-user` label.
- `/etc/fstab` grows the root filesystem on `/dev/vda` at boot.
- The host provides `/etc/resolv.conf`, `/etc/hosts` and `/etc/hostname`;
  systemd-resolved is not installed.
- Tools: build-essential, Go, Python with pipx and uv, Node.js, git, gh,
  Docker (started on first use through docker.socket), and the usual CLI
  basics.
- The [pi](https://github.com/earendil-works/pi) coding agent, with
  [pi-web-cyac](https://github.com/containmentzone/pi-web-cyac) installed
  for `ubuntu`: run `pi` and type `/web`, or start it with
  `PI_WEB_AUTOSTART=1 pi`. It listens on 127.0.0.1:8787 and has no login
  of its own. To reach it from outside, set `PI_WEB_HOST` to the box's
  address and `cyac expose <box> 8787` (the proxy asks for a token), or to
  a Tailscale address, rather than to every interface.

pi-web-cyac comes from GitHub Packages, which needs a token with
`read:packages` even to install. The build takes it as the BuildKit secret
`npm_token`, so it stays out of the image; `make` reads it from
`$NPM_TOKEN`, or else from `gh auth token`:

```sh
NPM_TOKEN=ghp_... make
```

CI uses the job's `GITHUB_TOKEN`, which can read the package once the
package's settings (Manage Actions access) give this repository read
access, or a `PACKAGES_TOKEN` repository secret if one is set.
`NODE_VERSION`, `PI_VERSION` and `PI_WEB_VERSION` are build args;
`PI_WEB_VERSION` defaults to the latest release.

Build it with `make`. Running systemd under plain Docker works with the
flags in the Makefile's `run` target; the root grow unit fails there, since
there is no `/dev/vda`.

Apache 2.0, as upstream (see LICENSE).
