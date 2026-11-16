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
- Tools: build-essential, Go, Python with pipx and uv, git, gh, Docker
  (started on first use through docker.socket), and the usual CLI basics.

Build it with `make`. Running systemd under plain Docker works with the
flags in the Makefile's `run` target; the root grow unit fails there, since
there is no `/dev/vda`.

Apache 2.0, as upstream (see LICENSE).
