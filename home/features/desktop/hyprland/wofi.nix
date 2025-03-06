{ ... }:
{
  programs.wofi = {
    enable = true;
    settings = {
      columns = 2;
      allow_images = true;
      launch_prefix = "uwsm app --";
    };
  };
}
