# The shared Hermes agent profiles, applied by ./hermes.nix to every devbox
# instance that runs Hermes. Data only: the option surface, the defaults and
# the config.yaml/.env generation live in ./hermes-profiles.nix, and
# `mine.system.devboxes.<name>.hermesProfiles.enable = false` opts one instance
# out of the whole set.
#
# Each entry is a `mine.hermes.agentProfiles.profiles.<name>` submodule, so at
# minimum it may state `description`, `backend`, `model`, `thinking` and
# `toolsets`; everything else has a default. Adding a role here gives it to
# both containers at once - there is no per-instance profile list on purpose.
#
# Empty for now: the roles land here in a follow-up.
{ }
