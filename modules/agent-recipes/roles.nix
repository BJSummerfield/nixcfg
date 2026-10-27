let
  toolNotes = {
    pi = {
      searchTool = "Search with `web_search`, several queries per call, always with `workflow: \"none\"`: raw results, no summary call. Never fetch a page.";
      pageTool = "Save the page to the page path with `save_page` and read its outline; then `grep` and read ranges of the saved file, following the reading rule above. If `save_page` reports it cannot handle the URL (a PDF, a video, a GitHub page), use `fetch_content` and page through the rest with `get_search_content`.";
    };
    claude = {
      searchTool = "Search with WebSearch, several queries as needed. Never fetch a page.";
      pageTool = "Fetch the URL with WebFetch, asking it for the passages that bear on the goal word for word, section by section; there is no saved page, so a passage's location is the heading it sits under. If a fetch returns a summary instead of the page's own words, say so in the closing line.";
    };
  };

  yaml =
    v:
    if builtins.isBool v then
      (if v then "true" else "false")
    else if builtins.isString v then
      builtins.toJSON v
    else
      toString v;

  prompt =
    harness: role:
    let
      notes = toolNotes.${harness};
    in
    builtins.replaceStrings (map (n: "@${n}@") (builtins.attrNames notes)) (builtins.attrValues notes) (
      builtins.readFile ./prompts/common.md + "\n" + builtins.readFile ./prompts/${role}.md
    );

  claudeAgentFile =
    name: role:
    "---\nname: ${name}\ndescription: ${yaml role.description}\ntools: ${role.claude.tools}\nmodel: ${role.claude.model}\n---\n\n"
    + prompt "claude" name;
in
{
  inherit prompt claudeAgentFile;

  roles = {
    planner = {
      description = "Writes the implementation plan and task specs from gathered facts, or splits a research goal into angles";
      tools = [
        "read"
        "grep"
        "find"
        "ls"
        "bash"
        "write"
      ];
      thinking = "xhigh";
      output = "plan.md";
      timeoutMs = 3600000;
      budget = {
        tokens = 130000;
        reserve = 40000;
        action = "stop";
      };
      claude = {
        tools = "Read, Grep, Glob, Bash, Write";
        model = "opus";
      };
    };
    scout = {
      description = "Finds facts in a repository and reports them with file and line evidence";
      tools = [
        "read"
        "grep"
        "find"
        "ls"
        "bash"
        "write"
      ];
      thinking = "medium";
      output = "scout.md";
      timeoutMs = 1200000;
      budget = {
        tokens = 100000;
        reserve = 20000;
        action = "stop";
      };
      claude = {
        tools = "Read, Grep, Glob, Bash, Write";
        model = "sonnet";
      };
    };
    locator = {
      description = "Lists the files and line ranges in a repository that bear on one question, without reading them";
      tools = [
        "read"
        "grep"
        "find"
        "ls"
        "bash"
        "write"
      ];
      thinking = "medium";
      output = "locator.md";
      timeoutMs = 1200000;
      budget = {
        tokens = 100000;
        reserve = 20000;
        action = "stop";
      };
      claude = {
        tools = "Read, Grep, Glob, Bash, Write";
        model = "sonnet";
      };
    };
    searcher = {
      description = "Finds candidate sources for one angle of a question and lists them, without reading them";
      tools = [
        "read"
        "write"
        "web_search"
      ];
      thinking = "medium";
      output = "searcher.md";
      timeoutMs = 1200000;
      budget = {
        tokens = 60000;
        reserve = 20000;
        action = "stop";
      };
      claude = {
        tools = "Read, Write, WebSearch";
        model = "haiku";
      };
    };
    extractor = {
      description = "Reads one source and copies out what bears on the goal, verbatim, with locations";
      tools = [
        "read"
        "grep"
        "write"
        "save_page"
        "fetch_content"
        "get_search_content"
      ];
      thinking = "medium";
      output = "extractor.md";
      timeoutMs = 1200000;
      budget = {
        tokens = 60000;
        reserve = 20000;
        action = "stop";
      };
      claude = {
        tools = "Read, Grep, Write, WebFetch";
        model = "sonnet";
      };
    };
    synthesizer = {
      description = "Merges findings into one cited document in the requested format";
      tools = [
        "read"
        "grep"
        "find"
        "ls"
        "write"
      ];
      thinking = "xhigh";
      output = "synthesis.md";
      timeoutMs = 2400000;
      budget = {
        tokens = 130000;
        reserve = 40000;
        action = "unread";
      };
      claude = {
        tools = "Read, Grep, Glob, Write";
        model = "opus";
      };
    };
    implementer = {
      description = "Executes one task spec in its own worktree; with a brief, prepares branches, merges and writes PR text";
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
      output = "result.md";
      timeoutMs = 3600000;
      budget = {
        tokens = 100000;
        reserve = 30000;
        action = "commit";
      };
      acceptance = "writer";
      claude = {
        tools = "Read, Grep, Glob, Bash, Edit, Write";
        model = "sonnet";
      };
    };
    reviewer = {
      description = "Reviews a diff, plan or research deliverable, verdict first, and runs the check itself";
      tools = [
        "read"
        "grep"
        "find"
        "ls"
        "bash"
        "write"
      ];
      thinking = "xhigh";
      output = "review.md";
      timeoutMs = 3600000;
      budget = {
        tokens = 130000;
        reserve = 40000;
        action = "unread";
      };
      claude = {
        tools = "Read, Grep, Glob, Bash, Write";
        model = "opus";
      };
    };
    mutator = {
      description = "Breaks the changed lines of a diff one at a time and reports the breaks the check does not catch, as patches";
      tools = [
        "read"
        "grep"
        "find"
        "ls"
        "bash"
        "write"
      ];
      thinking = "medium";
      output = "mutations.md";
      timeoutMs = 3600000;
      budget = {
        tokens = 100000;
        reserve = 30000;
        action = "stop";
      };
      claude = {
        tools = "Read, Grep, Glob, Bash, Write";
        model = "sonnet";
      };
    };
  };
}
