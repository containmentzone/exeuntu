#!/usr/bin/env bash
# Multi-user Lix from its release tarball. The tarball is just a store
# closure (store/ and .reginfo), with no installer script, so this does
# what an installer would: build users, store, default profile, nix.conf,
# shell hooks and the systemd units. No systemd runs during the build, so
# the units are only linked and enabled; they start at boot.
set -euo pipefail

version="${1:-}"
[[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "invalid Lix version: ${1:-}" >&2
    exit 1
}

case "$(dpkg --print-architecture)" in
amd64) arch=x86_64 ;;
arm64) arch=aarch64 ;;
*)
    echo "no Lix build for $(dpkg --print-architecture)" >&2
    exit 1
    ;;
esac

name="lix-${version}-${arch}-linux"
url="https://releases.lix.systems/lix/lix-${version}/${name}.tar.xz"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

curl -fsSL --retry 5 --retry-delay 2 "${url}.sha256" -o "${tmp}/sha256"
curl -fsSL --retry 5 --retry-delay 2 "${url}" -o "${tmp}/${name}.tar.xz"
expected="$(cut -d' ' -f1 "${tmp}/sha256")"
[[ "${expected}" =~ ^[0-9a-f]{64}$ ]] || {
    echo "missing checksum for ${name}.tar.xz" >&2
    exit 1
}
echo "${expected}  ${tmp}/${name}.tar.xz" | sha256sum -c - >/dev/null
tar -xJf "${tmp}/${name}.tar.xz" -C "${tmp}"
dir="${tmp}/${name}"

# Build users with fixed ids, as the old installer made them, so they match
# a /nix volume kept from an earlier image.
groupadd --gid 30000 nixbld
for i in $(seq 1 32); do
    useradd --uid $((30000 + i)) --gid nixbld --groups nixbld \
        --home-dir /var/empty --no-create-home --shell /usr/sbin/nologin \
        --comment "Nix build user ${i}" "nixbld${i}"
done

mkdir -p /etc/nix
printf '%s\n' 'build-users-group = nixbld' \
    'experimental-features = nix-command flakes' >/etc/nix/nix.conf

install -d -m 0755 /nix /nix/var /nix/var/nix
install -d -m 1775 -g nixbld /nix/store
cp -RP --preserve=mode,timestamps "${dir}"/store/* /nix/store/
chmod -R a-w "${dir}"/store/* /nix/store/*

lix=
cacert=
for p in "${dir}"/store/*; do
    case "${p##*/}" in
    *-lix-"${version}") lix="/nix/store/${p##*/}" ;;
    *-nss-cacert-*) cacert="/nix/store/${p##*/}" ;;
    esac
done
[[ -x "${lix}/bin/nix-store" && -n "${cacert}" ]] || {
    echo "no lix-${version} or nss-cacert in ${name}" >&2
    exit 1
}
"${lix}/bin/nix-store" --load-db <"${dir}/.reginfo"
"${lix}/bin/nix-env" -p /nix/var/nix/profiles/default -i "${lix}" "${cacert}"

# Shells: login shells read profile.d, interactive ones (tmux and zellij
# panes) bash.bashrc. User services get PATH from environment.d; 99-nix
# sorts after Ubuntu's 99-environment, which sets PATH outright.
hook='/nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh'
printf '# Nix\nif [ -e %s ]; then . %s; fi\n# End Nix\n' "${hook}" "${hook}" |
    tee /etc/profile.d/nix.sh >>/etc/bash.bashrc
mkdir -p /etc/environment.d
echo 'PATH=$HOME/.nix-profile/bin:/nix/var/nix/profiles/default/bin:$PATH' \
    >/etc/environment.d/99-nix.conf

# Lix's socket units accept each connection into a nix-daemon@ instance, so
# nix-daemon starts on first use.
units=/nix/var/nix/profiles/default/lib/systemd/system
ln -sfn /nix/var/nix/profiles/default/lib/tmpfiles.d/nix-daemon.conf \
    /etc/tmpfiles.d/nix-daemon.conf
systemctl link "${units}/nix-daemon@.service"
systemctl enable "${units}/nix-daemon.socket"

/nix/var/nix/profiles/default/bin/nix --version
