# Animated Devbox Story Presentation

## Problem

The devbox/workbox/paseo setup has a story worth telling to a developer
audience — how running Claude directly on a laptop led, step by step, to
isolated coding-agent containers on a server, driven remotely through paseo.
That story only exists today as git history and module comments. There is no
shareable artifact.

## Goal

A single self-contained HTML file (no external dependencies, works offline)
that tells the story as a click-driven animated slideshow. The right arrow
advances and *plays the transition* into the next slide; the left arrow
reverses it. The visual centerpiece is one persistent SVG "world" that morphs
between slides rather than cutting — the audience watches the trust boundary
physically move from "a wrapper around the agent on the laptop" to "a container
wall on a server".

Audience: developers and tech peers. Real details stay in (uid 1500, fine-
grained PATs, tailscale serve, sops), explained briefly rather than watered
down.

Non-goals: no build step, no framework, no telemetry, no autoplay mode, no
mobile-first layout (it should not break on a phone, but it is designed for a
laptop screen). The hallucinated-key incident is excluded from the story.

## Narrative: 12 slides, one morphing scene

Each slide is a *state of the world* — a camera position plus a set of element
states. Advancing applies the diff and CSS animates it.

1. **Title.** Near-black canvas, a single laptop glowing center. Title
   (working: "Planning with Claude, coding in a box") and a `→ to begin` hint.

2. **The incident.** A Claude glyph pulses on the laptop; a magenta tendril
   snakes from it toward a key icon labeled `~/.ssh`. Caption: the agent runs
   as you — your uid, your keys. Nothing between it and the filesystem but its
   own judgment. (Origin: Claude Code on the laptop tried to get at ssh keys.)

3. **Bubblewrap.** A thin dashed boundary draws itself around the agent glyph.
   Side panel: what bwrap is — unprivileged sandboxing via Linux namespaces
   (mount, pid, user, net); the layer under Flatpak. Pros animate in as green
   chips: no root daemon, fine-grained bind mounts, mask what you choose. Cons
   as magenta chips: the boundary is an allowlist you maintain — one missed
   bind is a hole; real agent tooling needs so many holes the wrapper becomes
   Swiss cheese. The boundary stays dashed on purpose.

4. **A container per repo.** The dashed wrapper morphs into a solid box: the
   ephemeral nspawn era (`modules/coding-agents`). Four slots appear; a repo
   folder flies in (only the caller's cwd is bind-mounted); on exit the
   container dissolves — root filesystem discarded. Pros: a full OS inside,
   the boundary is the container not a rule list, ephemeral by default. Cons:
   host network, host uid, one terminal = one session, Linux only.

5. **The Mac wall.** A MacBook slides in and the container fails to render on
   it — grey dashed outline, `namespaces: not found`. The realization, big
   type: stop bringing the sandbox to the machine — put the agent on a machine
   that *is* the sandbox.

6. **Enter the devbox.** Camera pans right; redtruck (the server) draws
   itself. A persistent NixOS container spawns inside, its `agent` user pinned
   to uid 1500 — deliberately outside the host uid range — on a private veth
   network. Key icons visibly stay outside the container wall, behind host
   glass: ssh, sops, and signing keys never enter. Sops secrets slide in as
   read-only bind mounts.

7. **Scoping the token.** The agent must push code, but a classic token is
   keys-to-everything. A GitHub glyph appears; a fine-grained PAT draws as a
   thin blue line from the box to an explicit allowlist of repos — other repos
   visibly unreachable. A branch-protection ruleset stands as the last guard.
   Line: the box holds a scoped key; GitHub holds the code.

8. **Paseo.** Inside the box the paseo daemon lights up on `:6767`, bound to
   localhost; a single blue door opens through the wall — `tailscale serve`,
   the only way in. Laptop, Mac, and phone dock at the canvas edge as thin
   clients on the tailnet mesh. Each session spawns a git worktree inside the
   box. Caption: plan from anywhere; the code never leaves the box.

9. **Contamination.** Zoom into the box: work repos and personal repos in the
   same filesystem, sharing the same token. A magenta haze bleeds between
   them. One box, one credential, two lives.

10. **Workbox.** The container module goes multi-instance: a second box splits
    off beside the first. Each holds its own GitHub token (different
    allowlists) and its own signing key — a commit's signature says which box
    made it. Personal and work can no longer touch.

11. **Scoreboard.** A four-column comparison animates in — raw laptop /
    bubblewrap / ephemeral container / server devbox — with rows for
    filesystem, network, credentials, portability, persistence. Cells fade in
    green/grey/magenta.

12. **The full picture.** Camera zooms out to the whole living system:
    redtruck with devbox + workbox, keys behind host glass, scoped token lines
    to GitHub, tailnet mesh to the devices, packets flowing. Closing line:
    "Keys stay on the host. Repos live in the container. GitHub holds the
    code."

## Visual system

Palette, taken from the NTT SamurAI site the presentation is styled after:

- Canvas `#141416` with a subtle radial vignette.
- Structure: 1–1.5px lines and labels in white / `#C4C4C5` / `#8F8F8F`.
  Roboto Thin / Roboto with system-font fallback (optionally an inlined woff2
  subset later; not required for v1).
- `#ED1566` magenta = danger: the ssh tendril, sandbox holes, contamination
  haze, red scoreboard cells.
- `#0072BC` blue = secured paths: tailscale serve, scoped PAT lines, sops
  mounts.
- `#889CE7` periwinkle = the planning layer: paseo daemon, clients, worktrees.
- Glow via SVG `drop-shadow`, active elements only.

Motion language — three verbs, used consistently:

- **Draw**: boundaries and connections animate with `stroke-dashoffset`.
- **Morph**: an element persists across slides and transitions its geometry
  and style — the dashed bwrap boundary becomes the solid container wall; the
  laptop becomes a thin client.
- **Dissolve/spawn**: containers scale+fade in from their parent; ephemeral
  ones dissolve on exit.

Camera moves are a CSS transform on a single `<g id="world">` group — the
world is one coordinate space and slides are camera positions plus element
states. The text panel sits in a consistent left column (~40%), cross-fading
per slide; pros/cons chips stagger in 80ms apart.

## Technical design

- One HTML file: inline SVG world, CSS custom properties + transitions,
  ~200 lines of vanilla JS. No dependencies, no network access.
- State machine: each slide is a declarative state object — a camera transform
  plus CSS classes per world element (`hidden`, `active`, `danger`, ...).
  Advancing applies the class diff; CSS transitions animate it. Reverse
  animations come free by applying the previous state.
- Multi-step beats within a slide (tendril reaches, then key flashes) are
  `transition-delay` chains — JS only ever swaps classes.
- Navigation: right arrow / space / click = next; left arrow = previous;
  slide dots at the bottom; URL hash (`#5`) deep-links a slide; `Esc` toggles
  a slide index.
- `prefers-reduced-motion`: states jump without animation.
- Performance: tens of SVG nodes, not thousands; transitions on `transform`
  and `opacity` where possible.

## Testing

Manual, against a checklist rather than automated: every slide reachable
forward and backward with correct end states; deep links land on the right
state; reduced-motion renders every final state correctly; file opens from
`file://` with no console errors and no network requests.

## Location

The artifact lives in this repo at `docs/presentations/devbox-story.html`
(new directory), since the repo it describes is its natural home.
