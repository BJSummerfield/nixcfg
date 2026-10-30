let
  roles = {
    planner = {
      description = "Turns a goal and gathered facts into a plan of small tasks";
      tools = [
        "read"
        "grep"
        "find"
        "ls"
        "bash"
        "write"
      ];
      thinking = "xhigh";
    };
    scout = {
      description = "Finds facts in a repository or on this box, with evidence";
      tools = [
        "read"
        "grep"
        "find"
        "ls"
        "bash"
        "write"
      ];
      thinking = "medium";
    };
    implementer = {
      description = "Carries out one piece of work";
      tools = [
        "read"
        "grep"
        "find"
        "ls"
        "bash"
        "edit"
        "write"
      ];
      thinking = "medium";
    };
    reviewer = {
      description = "Reviews a change or a plan and runs the check itself";
      tools = [
        "read"
        "grep"
        "find"
        "ls"
        "bash"
        "write"
      ];
      thinking = "xhigh";
    };
  };

  frontmatter =
    name: role:
    let
      lines = [
        "name: ${name}"
        "description: ${builtins.toJSON role.description}"
        "tools: ${builtins.concatStringsSep ", " role.tools}"
        "thinking: ${role.thinking}"
        "output: ${name}.md"
        "systemPromptMode: replace"
        "inheritProjectContext: true"
        "inheritGlobalContext: true"
        "inheritSkills: false"
        "acceptance: {\"level\":\"none\",\"reason\":\"reports go to the session\"}"
      ];
    in
    "---\n" + builtins.concatStringsSep "\n" lines + "\n---\n\n";

in
{
  inherit roles;
  agentFiles = builtins.mapAttrs (
    name: role:
    frontmatter name role
    + builtins.readFile ./agents/common.md
    + "\n"
    + builtins.readFile ./agents/${name}.md
  ) roles;
}
