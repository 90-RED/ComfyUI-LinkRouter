# ComfyUI-LinkRouter ☕

[![Buy me a coffee](https://img.buymeacoffee.com/button-api/?text=Buy+me+a+coffee&emoji=☕&slug=90red&button_colour=FFDD00&font_colour=000000&font_family=Bree&outline_colour=000000&coffee_colour=ffffff)](https://buymeacoffee.com/90red)

> **I'm new to all this — first plugin, first GitHub repo, learning as I go.**
> If you find bugs, have ideas, or just want to help a beginner out, I'd be incredibly grateful. 
> Bug reports, PRs, suggestions, or just [buying me a coffee](https://buymeacoffee.com/90red) ☕ — every bit of support honestly makes my day. Thank you! 🙏

---

**Object-avoiding orthogonal link routing for ComfyUI.** Links automatically detour around nodes with smooth right-angle paths — no more spaghetti lines.

![demo](screenshots/demo.gif)

## Features

- 🔀 **Auto-detour** — links route around nodes instead of passing through them
- 🖱️ **Smooth dragging** — anti-flicker stickiness keeps shapes stable while you drag
- ✨ **Flow animation** — dots / pills / arrows / ovals / dashes on hover or selection
- 🎯 **Highlight & dim** — selected node's links brighten, others fade to focus
- 🎛️ **Floating bar** — quick toggles for routing, link style, flow mode, and settings
- ⚙️ **Full settings panel** — everything adjustable with live preview
- 🚀 **Zero performance cost** — pure browser canvas, no GPU/VRAM impact

## Installation

### ComfyUI Manager (recommended)
Search `LinkRouter` and install.

### Manual
```bash
cd ComfyUI/custom_nodes/
git clone https://github.com/90-RED/ComfyUI-LinkRouter
```
Then reload ComfyUI with `Ctrl+R`.

## Usage

LinkRouter is enabled by default. A floating bar appears on the right:

| 🔀 | Toggle routing |
| 🌊📐➖ | Cycle official link styles |
| ✨➤◾ | Cycle flow markers (animated/static/none) |
| ⚙️ | Open settings |
| 🐞 | Debug overlay |
| ✥ | Drag to move |

All visual parameters are in **Settings → LinkRouter**.

## Credits

- **Algorithm**: Wybrow, Marriott, Stuckey — *"Orthogonal Connector Routing"* (Graph Drawing 2009)
- **Incremental routing**: Wybrow et al. — *"Incremental Connector Routing"* (GD 2005)
- **Inspiration**: libavoid (Adaptagrams), react-flow-smart-edge, JointJS
- All code is original JavaScript — no third-party dependencies

## License

Apache-2.0 — see [LICENSE](LICENSE).
