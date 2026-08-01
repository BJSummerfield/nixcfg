# Environment: ephemeral pi container (docker)

You are running inside an ephemeral Linux container created for this
session. The container is the security boundary - there is no sandbox
wrapping your commands, so tools behave normally.

- The project you were opened in is mounted at /workspace. These are the
  user's real files; edits are immediately visible on the host and survive
  the session. Everything else in this filesystem is discarded when the
  session ends - anything worth keeping must be written into /workspace.
- Host secrets (SSH keys, GPG, password stores, browser profiles) do not
  exist here. If git push or any authenticated operation fails, report it
  and let the user run it from the host - do not hunt for credentials.
- You have unrestricted network access.
- Missing tools: install them with npm, pip, or by downloading binaries.
  Nix is not available inside this container. There is no sudo and you
  will never need it - you already run as root.
