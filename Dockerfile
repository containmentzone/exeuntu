# syntax=docker/dockerfile:1

# A general-purpose Ubuntu 26.04 dev box that boots systemd as PID 1, forked
# from exe.dev's exeuntu with the exe.dev-specific parts removed.
FROM docker.io/library/ubuntu:26.04

SHELL ["/bin/bash", "-euxo", "pipefail", "-c"]

RUN apt-get update && \
	# Pull in fixes for packages already in the base layer.
	DEBIAN_FRONTEND=noninteractive apt-get -y \
		-o Dpkg::Options::=--force-confold \
		-o Dpkg::Options::=--force-confdef \
		dist-upgrade && \
	DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
		systemd systemd-sysv dbus dbus-user-session libpam-systemd \
		ca-certificates curl wget gnupg locales sudo less file tree xz-utils \
		vim-nox neovim git jq ripgrep sqlite3 unzip rsync man-db manpages \
		build-essential make golang-go python3-pip python-is-python3 pipx \
		iproute2 iputils-ping net-tools netcat-openbsd socat openssh-client \
		lsof psmisc procps htop btop ncdu tmux libcap2-bin bubblewrap \
		docker.io docker-buildx docker-compose-v2 && \
	locale-gen en_US.UTF-8 && \
	# Allow non-root users to use ping without sudo.
	setcap cap_net_raw=+ep /usr/bin/ping && \
	# The base image ships this to stop services starting during the build;
	# at runtime systemd is in charge.
	rm -f /usr/sbin/policy-rc.d && \
	rm -rf /var/lib/apt/lists/*

ARG GH_VERSION=2.97.0
RUN --mount=type=bind,source=install-gh.sh,target=/tmp/install-gh.sh \
	bash /tmp/install-gh.sh "${GH_VERSION}" && \
	gh --version

# The host writes /etc/resolv.conf; systemd-resolved would fight it.
RUN if dpkg -s systemd-resolved >/dev/null 2>&1; then apt-get purge -y systemd-resolved; fi

RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# Node.js from nodejs.org (pi needs >= 22.19, newer than some distro builds),
# checked against the release's SHASUMS256.txt.
ARG NODE_VERSION=24.22.3
RUN case "$(dpkg --print-architecture)" in \
		amd64) arch=x64 ;; arm64) arch=arm64 ;; \
		*) echo "no Node.js build for $(dpkg --print-architecture)"; exit 1 ;; \
	esac && \
	tarball="node-v${NODE_VERSION}-linux-${arch}.tar.xz" && \
	cd /tmp && \
	curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}" && \
	curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " ${tarball}\$" | sha256sum -c - && \
	tar -xJf "${tarball}" -C /usr/local --strip-components=1 --no-same-owner \
		--exclude CHANGELOG.md --exclude LICENSE --exclude README.md && \
	rm "${tarball}" && \
	node --version && npm --version

# zellij from its GitHub release. The release's .sha256sum is of the binary
# inside the tarball, not of the tarball itself.
ARG ZELLIJ_VERSION=0.45.1
RUN case "$(dpkg --print-architecture)" in \
		amd64) arch=x86_64 ;; arm64) arch=aarch64 ;; \
		*) echo "no zellij build for $(dpkg --print-architecture)"; exit 1 ;; \
	esac && \
	url="https://github.com/zellij-org/zellij/releases/download/v${ZELLIJ_VERSION}/zellij-${arch}-unknown-linux-musl" && \
	tmp="$(mktemp -d)" && \
	curl -fsSL --retry 5 "${url}.tar.gz" | tar -xzf - -C "${tmp}" && \
	echo "$(curl -fsSL --retry 5 "${url}.sha256sum" | cut -d' ' -f1)  ${tmp}/zellij" | sha256sum -c - && \
	install -m 0755 "${tmp}/zellij" /usr/local/bin/zellij && \
	rm -rf "${tmp}" && \
	zellij --version

# Lix (lix.systems), multi-user, from its release tarball checked against
# the .sha256 next to it. See install-lix.sh.
ARG LIX_VERSION=2.96.0
RUN --mount=type=bind,source=install-lix.sh,target=/tmp/install-lix.sh \
	bash /tmp/install-lix.sh "${LIX_VERSION}"

# The pi coding agent, system-wide. pi's own self-update needs sudo here,
# which the login user has.
ARG PI_VERSION=1.5.2
RUN npm install -g --no-fund --no-audit "@earendil-works/pi-coding-agent@${PI_VERSION}" && \
	npm cache clean --force && \
	pi --version

# Configure systemd for a VM-like box with no consoles, udev or modules of its
# own: the host sets up devices, /etc/hosts, /etc/hostname and resolv.conf.
RUN systemctl mask -- \
		getty.target \
		console-getty.service \
		systemd-random-seed.service \
		etc-resolv.conf.mount \
		etc-hosts.mount \
		etc-hostname.mount \
		-.mount \
		systemd-remount-fs.service \
		systemd-sysusers.service \
		systemd-update-done.service \
		systemd-update-utmp.service \
		systemd-journal-catalog-update.service \
		modprobe@.service \
		systemd-modules-load.service \
		systemd-udevd.service \
		systemd-udevd-control.socket \
		systemd-udevd-kernel.socket \
		systemd-udev-trigger.service \
		systemd-udev-settle.service \
		systemd-hwdb-update.service \
		ldconfig.service \
		systemd-ask-password-console.path \
		systemd-ask-password-wall.path \
		man-db.timer \
		dpkg-db-backup.timer \
		e2scrub_all.timer \
		apt-daily-upgrade.timer \
		apt-daily.timer && \
	# docker.socket stays enabled, so Docker starts on first use.
	systemctl disable docker.service containerd.service systemd-logind.service && \
	mkdir -p /etc/systemd/system.conf.d /etc/systemd/journald.conf.d && \
	printf '%s\n' '[Manager]' 'LogLevel=info' 'LogTarget=console' \
		'SystemCallArchitectures=native' 'DefaultOOMPolicy=continue' \
		> /etc/systemd/system.conf.d/container-overrides.conf && \
	printf '%s\n' '[Journal]' 'Storage=persistent' \
		> /etc/systemd/journald.conf.d/persistent.conf && \
	systemctl set-default multi-user.target

# The login user is the base image's ubuntu (uid 1000), with passwordless sudo
# and lingering so its user manager runs without a login.
RUN usermod -aG sudo,docker ubuntu && \
	echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ubuntu && \
	chmod 0440 /etc/sudoers.d/ubuntu && \
	mkdir -p /var/lib/systemd/linger && \
	touch /var/lib/systemd/linger/ubuntu

# Start pi (with the web UI) in ubuntu's user manager at boot. Enabled for
# ubuntu only, not --global: there is one port 8787 to bind.
COPY pi.service /etc/systemd/user/pi.service
RUN wants=/home/ubuntu/.config/systemd/user/default.target.wants && \
	mkdir -p "$wants" && \
	ln -s /etc/systemd/user/pi.service "$wants/pi.service" && \
	chown -R ubuntu:ubuntu /home/ubuntu/.config

# systemd-growfs@-.service grows the root filesystem when the disk grows.
RUN echo '/dev/vda / ext4 defaults,x-systemd.growfs 0 1' > /etc/fstab

COPY tmpfiles-tmp.conf /etc/tmpfiles.d/tmp.conf

COPY xterm-ghostty.terminfo /tmp/xterm-ghostty.terminfo
RUN tic -x - < /tmp/xterm-ghostty.terminfo && rm /tmp/xterm-ghostty.terminfo

USER ubuntu
WORKDIR /home/ubuntu
RUN echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && \
	echo 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"' >> ~/.bashrc && \
	echo 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"' >> ~/.profile && \
	touch ~/.hushlogin && \
	git config --global init.defaultBranch main

# The pi web UI (/web), as a personal pi package of the login user. It comes
# from GitHub Packages, which needs a read:packages token even to install, so
# the build takes the token as the secret npm_token (see the README). It only
# ever sits in a tmpfs, so it never lands in a layer or the build log. The
# image keeps just the scope-to-registry line, so a later `pi update` needs
# only a token added to ~/.npmrc.
ARG PI_WEB_VERSION=
RUN --mount=type=secret,id=npm_token,uid=1000,required=true \
	--mount=type=tmpfs,target=/tmp/npm \
	printf '%s\n' '@containmentzone:registry=https://npm.pkg.github.com' > ~/.npmrc && \
	cp ~/.npmrc /tmp/npm/npmrc && \
	sed -n '1s|^|//npm.pkg.github.com/:_authToken=|p' /run/secrets/npm_token >> /tmp/npm/npmrc && \
	NPM_CONFIG_USERCONFIG=/tmp/npm/npmrc \
		pi install "npm:@containmentzone/pi-web-cyac${PI_WEB_VERSION:+@${PI_WEB_VERSION}}" && \
	pi list && \
	rm -rf ~/.npm

# A pi extension that adds the models of the endpoints listed in
# ~/.pi/agent/endpoints (the image lists the usual cyac service names), with
# presets that pick a few models from services that list hundreds.
COPY --chown=ubuntu:ubuntu pi-endpoints.ts /home/ubuntu/.pi/agent/extensions/pi-endpoints.ts
COPY --chown=ubuntu:ubuntu endpoint-presets.json /home/ubuntu/.pi/agent/endpoint-presets.json
COPY --chown=ubuntu:ubuntu endpoints /home/ubuntu/.pi/agent/endpoints
USER root

RUN rm -rf /etc/update-motd.d/* /etc/motd

# Named init so runtimes that look for an init (cyac, exe.dev's exetini) exec
# it as PID 1 rather than forking it.
COPY init-wrapper.sh /usr/local/bin/init

# Empty, not removed: each box generates its own machine ID on first boot,
# and an absent file would make systemd preset (re-enable) every unit. Keep
# this last, so no later apt-get install bakes in an ID.
RUN : > /etc/machine-id && \
	ln -sf /etc/machine-id /var/lib/dbus/machine-id

LABEL "cyac.nullvoid.space/login-user"="ubuntu"
# `cyac expose <box>` serves pi.service's web UI at pi.<box>.<root domain>.
LABEL "cyac.nullvoid.space/expose.pi"="8787"
# What outlives the image: once cyac reads image volumes, a box that moves
# to a newer image gets a rebuilt root but keeps these, filled from the
# image only the first time. Homes, logs (the journal too), tailscale's
# node key, and Docker's images and containers (containerd's too, for
# Docker's containerd image store), and /nix, so nix profiles and the store
# survive (Lix itself then comes from the image only on first seed; upgrade
# it with the script on lix.systems/install). Not all of /var/lib: dpkg's database there
# describes /usr, which comes from the new image.
# Last, so no later build step writes into them.
VOLUME ["/home", "/root", "/var/log", "/var/lib/tailscale", "/var/lib/docker", "/var/lib/containerd", "/nix"]
CMD ["/usr/local/bin/init"]
