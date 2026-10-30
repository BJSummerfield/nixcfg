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
      acceptanceRole = "read-only";
    };
    scout = {
      description = "Finds facts in a repository with file and line evidence";
      tools = [
        "read"
        "grep"
        "find"
        "ls"
        "bash"
        "write"
      ];
      thinking = "medium";
      acceptanceRole = "read-only";
    };
    implementer = {
      description = "Carries out one task of a plan in its own worktree";
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
      acceptanceRole = "writer";
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
      acceptanceRole = "read-only";
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
        "defaultContext: fresh"
        "defaultProgress: false"
        "acceptanceRole: ${role.acceptanceRole}"
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
