{
  lib,
  buildHomeAssistantComponent,
  fetchFromGitHub,
  home-assistant,
}:

buildHomeAssistantComponent rec {
  owner = "vasqued2";
  domain = "teamtracker";
  version = "0.18.4";

  src = fetchFromGitHub {
    inherit owner;
    repo = "ha-teamtracker";
    tag = "v${version}";
    hash = "sha256-B7XszI5Ge4avnbKEk1HZaVWaxexfqTLadd5B5vLLa8w=";
  };

  dependencies = with home-assistant.python3Packages; [
    aiofiles
    arrow
    async-timeout
    jmespath
  ];

  meta = {
    description = "Live sports scores sensor for Home Assistant";
    homepage = "https://github.com/vasqued2/ha-teamtracker";
    license = lib.licenses.gpl3Only;
  };
}
