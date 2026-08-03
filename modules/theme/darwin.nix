# Darwin theming. The shared module handles the options and hands
# themeConstants to home-manager; the GTK/Qt/cursor config in home.nix is
# Linux-only, so there is nothing platform-specific to add yet.
{
  imports = [ ./shared.nix ];
}
