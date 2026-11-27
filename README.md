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
- `/home`, `/root`, `/var/log`, `/var/lib/tailscale`, `/var/lib/docker`,
  `/var/lib/containerd` and `/nix` are declared `VOLUME`s, so they persist when a box moves to a newer image while the
  rest of the root is replaced (once cyac reads image volumes; today it
  ignores them).
- The host provides `/etc/resolv.conf`, `/etc/hosts` and `/etc/hostname`;
  systemd-resolved is not installed.
- Tools: build-essential, Go, Python with pipx and uv, Node.js, git, gh,
  zellij, Docker (started on first use through docker.socket), and the
  usual CLI basics.
- [Lix](https://lix.systems) as a multi-user install with flakes on;
  `nix-daemon.socket` starts the daemon on first use, so `ubuntu` uses
  nix without sudo. `/nix` is a volume, so profiles and the store
  survive a move to a newer image; Lix itself then comes from the image
  only on first seed, and `sudo -i nix upgrade-nix` upgrades it.
- The [pi](https://github.com/earendil-works/pi) coding agent, with
  [pi-web-cyac](https://github.com/containmentzone/pi-web-cyac) installed
  for `ubuntu`. The user unit `pi.service` starts it at boot as `ubuntu`,
  in tmux (`tmux -L pi attach` to get the TUI), with the web UI on port
  8787 on all interfaces, so the cyac proxy can reach it at the box's
  address. The label `cyac.nullvoid.space/expose.pi=8787` makes
  `cyac expose <box>` serve it at `pi.<box>.<root domain>`. The web UI has no login of its own: the proxy asks for the box
  token, but other boxes on the same network reach it directly. Put
  overrides such as `PI_WEB_HOST=127.0.0.1` in `~/.config/pi-web.env`, and
  `systemctl --user stop pi` stops it.

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
`NODE_VERSION`, `ZELLIJ_VERSION`, `LIX_VERSION`, `PI_VERSION` and
`PI_WEB_VERSION` are build args;
`PI_WEB_VERSION` defaults to the latest release.

Build it with `make`. Running systemd under plain Docker works with the
flags in the Makefile's `run` target; the root grow unit fails there, since
there is no `/dev/vda`.

Apache 2.0, as upstream (see LICENSE).
