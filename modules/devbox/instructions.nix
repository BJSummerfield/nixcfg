let
  llm = import ../local-llm/models.nix;
  model = llm.models.${llm.default};
  vars = {
    "@localModel@" = "pi/${llm.provider}/${llm.default}";
    "@localLanes@" = toString model.ninfer.maxConcurrency;
  };
  render =
    path:
    let
      text = builtins.replaceStrings (builtins.attrNames vars) (builtins.attrValues vars) (
        builtins.readFile path
      );
    in
    if builtins.length (builtins.split "@[A-Za-z]+@" text) == 1 then
      text
    else
      throw "${toString path} has a placeholder that instructions.nix does not define";
in
{
  inherit render;
  environment = render ./ENVIRONMENT.md;
  delegation = render ./delegation.md;
}
