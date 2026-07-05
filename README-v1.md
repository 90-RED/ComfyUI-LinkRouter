# ComfyUI-LinkRouter

**Object-avoiding orthogonal link routing for ComfyUI.**

Links automatically detour around nodes with smooth right-angle paths — no more spaghetti lines passing through other nodes. Pure frontend JavaScript, zero Python logic, zero dependencies, zero impact on generation performance or VRAM.

![demo](screenshots/demo.gif)

## Features

- **Orthogonal edge routing** — right-angle lines that flow around obstacles, based on the same algorithm used by Inkscape and JointJS (Wybrow et al., GD'09)
- **Incremental rerouting** — only the links affected by your drag are recalculated; most drags update 3-5 links
- **Anti-flicker** — path stickiness keeps link shapes stable while dragging, with optimal reroute after settling
- **Flow animation** — animated markers (dots / pills / arrows / ovals / dashes) on hovered or selected links
- **Highlight & dim** — select a node → its links brighten, unrelated links dim to focus attention
- **Floating button bar** — quick access: toggle routing, cycle official link styles, cycle flow modes, open settings
- **Full settings panel** — everything adjustable via ComfyUI Settings with live preview
- **Subgraph compatible** — handles ComfyUI's virtual subgraph IO nodes correctly
- **Smart during runs** — auto-pauses or throttles animations while workflows execute, saving CPU

## Screenshots

| Before | After |
|--------|-------|
| ![](screenshots/before.png) | ![](screenshots/after.png) |

## Installation

### Via ComfyUI Manager (recommended)
Search for "LinkRouter" in ComfyUI Manager and click Install.

### Manual
```bash
cd ComfyUI/custom_nodes/
git clone https://github.com/90-RED/ComfyUI-LinkRouter
```

Restart ComfyUI (or reload the web UI with Ctrl+R).

## Usage

Once installed, LinkRouter is **enabled by default**. A floating button bar appears on the right side of the canvas:

| Button | Action |
|--------|--------|
| 🔀 | Toggle LinkRouter on/off |
| 🌊📐➖ | Cycle official link styles (Spline / Linear / Straight) |
| ✨➤◾ | Cycle flow marker modes (animated / static arrows / none) |
| ⚙️ | Open ComfyUI Settings → LinkRouter panel |
| 🐞 | Toggle debug overlay (red = obstacle boxes, blue = waypoints) |
| ✖ | Hide the floating bar |
| ✥ | Drag to reposition |

All visual parameters are configurable in **Settings → LinkRouter**.

## Settings

| Section | Setting | Default | Description |
|---------|---------|---------|-------------|
| General | Enabled | true | Master on/off switch |
| General | FloatingBar | true | Show/hide floating button bar |
| Routing | Clearance | 16 | Minimum gap between links and nodes (4–120) |
| Routing | ClearanceMode | uniform | uniform (one value) or per-side (L/R/T/B) |
| Routing | BendPenalty | 40 | Higher = straighter routes, lower = tighter detours (10–150) |
| Routing | DragStickiness | true | Anti-flicker while dragging |
| Lines | Width | 3 | Line width (1–16) |
| Lines | SelectBoost | 1.35× | Highlighted line width multiplier |
| Lines | Outline | true | Dark outline around lines (official ComfyUI style) |
| Line Corners | Mode | per-line | Rounded corner mode (per-line / per-corner / off) |
| Line Corners | Radius | 8 | Corner radius (0–24) |
| Highlight | HoverAnimation | true | Flow animation on hovered node's links |
| Highlight | SelectHighlight | true | Highlight selected node + dim unrelated |
| Highlight | SelectAnimation | true | Flow animation on selected node's links |
| Marker Animation | Mode | animated | animated / static arrows / none |
| Marker Animation | Style | pill | dots / pill / arrow / oval / dash |
| Marker Animation | Speed | 60 | px/s (10–240) |
| Marker Animation | MaxFPS | 30 | Animation frame cap (5–60) |
| Marker Animation | WhileRunning | off | off / low fps (10) / unchanged |

## Performance

- Build OVG: ~11ms (60 nodes)
- Route one link: ~2.5ms average
- Full recalc (80 links): ~200ms worst case
- Incremental: typically 3-5 links re-routed per drag (~10ms)
- **Zero impact on generation**: all routing runs in the browser canvas thread, completely separate from the Python/GPU backend

## Technical Background

This plugin implements the **Orthogonal Visibility Graph + A\*** algorithm from:

> M. Wybrow, K. Marriott, P.J. Stuckey — *"Orthogonal Connector Routing"*, Graph Drawing 2009, LNCS 5849

The same algorithm family powers **libavoid** (used by Inkscape and JointJS). The implementation is pure JavaScript, written from scratch — no libavoid code is used, and the plugin has no C/C++ dependencies.

Key design: soft-cost edge tiers instead of hard blocking. Nodes close together cause stub points to land inside each other's margin zones; hard blocking makes routing fail for those links. LinkRouter's three-tier system (free space / margin zone / node body) ensures 100% routing success while only crossing through nodes when they genuinely overlap.

Incremental rerouting with path stickiness follows concepts from the same authors' *"Incremental Connector Routing"* (GD'05).

## Credits

- **Algorithm**: Wybrow, Marriott, Stuckey — "Orthogonal Connector Routing" (GD'09)
- **Incremental concept**: Wybrow et al. — "Incremental Connector Routing" (GD'05)
- **Inspiration**: libavoid (Adaptagrams), react-flow-smart-edge, JointJS
- All code is original JavaScript implementation, no third-party dependencies

## License

MIT — see [LICENSE](LICENSE) for details.
