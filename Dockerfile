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
		ca-certificates curl wget gnupg locales sudo less file tree \
		vim-nox neovim git jq ripgrep sqlite3 unzip rsync man-db manpages \
		build-essential make golang-go python3-pip python-is-python3 pipx \
		iproute2 iputils-ping net-tools netcat-openbsd socat openssh-client \
		lsof psmisc procps htop btop ncdu libcap2-bin bubblewrap \
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

# systemd-growfs@-.service grows the root filesystem when the disk grows.
RUN echo '/dev/vda / ext4 defaults,x-systemd.growfs 0 1' > /etc/fstab

COPY tmpfiles-tmp.conf /etc/tmpfiles.d/tmp.conf

# cyac networks are IPv4-only; without this apt tries every AAAA first and
# prints a "Network is unreachable" line for each before falling back.
RUN echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4

COPY xterm-ghostty.terminfo /tmp/xterm-ghostty.terminfo
RUN tic -x - < /tmp/xterm-ghostty.terminfo && rm /tmp/xterm-ghostty.terminfo

USER ubuntu
WORKDIR /home/ubuntu
RUN echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && \
	echo 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"' >> ~/.bashrc && \
	echo 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"' >> ~/.profile && \
	touch ~/.hushlogin && \
	git config --global init.defaultBranch main
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
CMD ["/usr/local/bin/init"]
