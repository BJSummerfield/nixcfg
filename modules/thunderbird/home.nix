{ lib, config, ... }:
let
  inherit (lib) mkIf mkEnableOption;
  realName = "Brian Summerfield";
in
{
  options.mine.user.thunderbird.enable = mkEnableOption "Enable Thunderbird with the mail accounts";
  config = mkIf config.mine.user.thunderbird.enable {
    programs.thunderbird = {
      enable = true;
      profiles.default.isDefault = true;
    };

    accounts.email.accounts = {
      gmail = {
        primary = true;
        address = "brianjsummerfield@gmail.com";
        flavor = "gmail.com";
        inherit realName;
        thunderbird.enable = true;
      };
      live = {
        address = "bjsummerfield@live.com";
        flavor = "outlook.office365.com";
        inherit realName;
        thunderbird.enable = true;
      };
      brianjs = {
        address = "brian@brianjs.com";
        userName = "brian@brianjs.com";
        inherit realName;
        imap = {
          host = "mx1.brianjs.com";
          port = 993;
          tls.enable = true;
        };
        smtp = {
          host = "mx1.brianjs.com";
          port = 465;
          tls.enable = true;
        };
        thunderbird.enable = true;
      };
    };
  };
}
