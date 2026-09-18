from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "media" / "code-imagination-preview.png"
WIDTH, HEIGHT = 1440, 900


def font(path: str, size: int):
    return ImageFont.truetype(f"C:/Windows/Fonts/{path}", size)


UI = font("segoeui.ttf", 18)
UI_SMALL = font("segoeui.ttf", 15)
UI_BOLD = font("segoeuib.ttf", 18)
TITLE = font("segoeuib.ttf", 20)
CODE = font("consola.ttf", 18)
CODE_BOLD = font("consolab.ttf", 18)


img = Image.new("RGB", (WIDTH, HEIGHT), "#181818")
draw = ImageDraw.Draw(img)

# VS Code window chrome.
draw.rectangle((0, 0, WIDTH, 34), fill="#181818")
draw.text((18, 8), "Counter.tsx — Code Imagination", font=UI_SMALL, fill="#cccccc")
draw.rectangle((0, 34, WIDTH, 68), fill="#181818")
draw.text((14, 42), "File   Edit   Selection   View   Go   Run   Terminal   Help", font=UI_SMALL, fill="#cccccc")

# Activity bar and explorer.
draw.rectangle((0, 68, 52, HEIGHT - 24), fill="#181818")
draw.rectangle((52, 68, 260, HEIGHT - 24), fill="#202020")
for y, glyph in [(92, "▤"), (148, "⌕"), (204, "⑂"), (260, "▶"), (316, "◇")]:
    draw.text((16, y), glyph, font=TITLE, fill="#8c8c8c")
draw.rectangle((49, 305, 52, 350), fill="#39c5cf")
draw.text((16, 316), "◆", font=TITLE, fill="#39c5cf")
draw.text((68, 84), "EXPLORER", font=UI_SMALL, fill="#bbbbbb")
draw.text((68, 116), "⌄  CODE IMAGINATION", font=UI_BOLD, fill="#dddddd")
draw.text((84, 152), "⌄  examples", font=UI, fill="#cccccc")
draw.rectangle((58, 181, 257, 211), fill="#37373d")
draw.text((102, 185), "Counter.tsx", font=UI, fill="#ffffff")
draw.text((102, 218), "AsyncProfile.tsx", font=UI, fill="#cccccc")
draw.text((102, 251), "AngularCounter.ts", font=UI, fill="#cccccc")

# Editor and graph split.
EDITOR_X0, EDITOR_X1 = 260, 810
GRAPH_X0 = EDITOR_X1
draw.rectangle((EDITOR_X0, 68, EDITOR_X1, HEIGHT - 24), fill="#1e1e1e")
draw.rectangle((GRAPH_X0, 68, WIDTH, HEIGHT - 24), fill="#1b1b1b")
draw.line((GRAPH_X0, 68, GRAPH_X0, HEIGHT - 24), fill="#454545", width=1)

# Tabs.
draw.rectangle((EDITOR_X0, 68, EDITOR_X0 + 178, 105), fill="#1e1e1e")
draw.line((EDITOR_X0, 104, EDITOR_X0 + 178, 104), fill="#39c5cf", width=2)
draw.text((EDITOR_X0 + 18, 76), "Counter.tsx", font=UI, fill="#ffffff")
draw.text((EDITOR_X0 + 18, 119), "examples  ›  Counter.tsx", font=UI_SMALL, fill="#9d9d9d")

# Code editor content.
code_lines = [
    "import { useState } from 'react';",
    "import { nextCount } from './counterMath';",
    "",
    "export function Counter() {",
    "  const [count, setCount] = useState(0);",
    "",
    "  function increment() {",
    "    if (count < 10) {",
    "      setCount(nextCount(count));",
    "    }",
    "  }",
    "",
    "  return <button onClick={increment}>",
    "    Count: {count}",
    "  </button>;",
    "}",
]

line_y = 166
line_height = 31
highlight_line = 9
draw.rectangle((EDITOR_X0, line_y + (highlight_line - 1) * line_height - 4, EDITOR_X1, line_y + highlight_line * line_height - 3), fill="#273646")
draw.rectangle((EDITOR_X0, line_y + (highlight_line - 1) * line_height - 4, EDITOR_X0 + 4, line_y + highlight_line * line_height - 3), fill="#58a6ff")

for i, line in enumerate(code_lines, 1):
    y = line_y + (i - 1) * line_height
    draw.text((EDITOR_X0 + 18, y), str(i).rjust(2), font=CODE, fill="#858585")
    x = EDITOR_X0 + 64
    color = "#d4d4d4"
    if line.lstrip().startswith(("import", "export", "return", "if", "function")):
        color = "#c586c0"
    draw.text((x, y), line, font=CODE, fill=color)

# Graph panel header.
draw.rectangle((GRAPH_X0, 68, WIDTH, 132), fill="#202020")
draw.text((GRAPH_X0 + 20, 79), "Entire file", font=TITLE, fill="#f0f0f0")
draw.text((GRAPH_X0 + 20, 105), "Counter.tsx", font=UI_SMALL, fill="#a8a8a8")

def button(x1, y1, x2, y2, text):
    draw.rounded_rectangle((x1, y1, x2, y2), radius=4, fill="#3a3d41", outline="#606060")
    box = draw.textbbox((0, 0), text, font=UI_SMALL)
    draw.text(((x1 + x2 - (box[2] - box[0])) / 2, y1 + 8), text, font=UI_SMALL, fill="#ffffff")


button(1124, 81, 1246, 119, "Focus function")
button(1258, 81, 1342, 119, "Fit graph")
draw.ellipse((1360, 90, 1370, 100), fill="#3fb950")
draw.text((1377, 84), "LIVE", font=UI_SMALL, fill="#3fb950")

# Graph background grid.
for x in range(GRAPH_X0 + 18, WIDTH, 20):
    for y in range(150, HEIGHT - 38, 20):
        draw.ellipse((x, y, x + 1, y + 1), fill="#343434")

node_colors = {
    "event": "#39c5cf",
    "function": "#58a6ff",
    "condition": "#d2a8ff",
    "setter": "#ffa657",
    "state": "#3fb950",
    "render": "#f778ba",
}

nodes = {
    "event": (842, 214, 1012, 286, "Button click", "onClick event", "event"),
    "function": (1060, 214, 1230, 286, "increment()", "Focused function", "function"),
    "condition": (1260, 214, 1418, 286, "count < 10", "Condition", "condition"),
    "setter": (1060, 392, 1230, 470, "setCount(…)", "Updates count", "setter"),
    "state": (1260, 392, 1418, 470, "count", "Initial value: 0", "state"),
    "render": (1150, 578, 1334, 650, "UI re-renders", "React updates the UI", "render"),
}


def edge(points, label, active=False):
    color = "#f0f6fc" if active else "#8b949e"
    width = 4 if active else 2
    draw.line(points, fill=color, width=width, joint="curve")
    x2, y2 = points[-1]
    draw.polygon([(x2, y2), (x2 - 10, y2 - 6), (x2 - 10, y2 + 6)], fill=color)
    if label:
        mid = points[len(points) // 2]
        draw.text((mid[0] - 20, mid[1] - 24), label, font=UI_SMALL, fill="#bcbcbc")


edge([(1012, 250), (1060, 250)], "triggers")
edge([(1230, 250), (1260, 250)], "checks")
edge([(1339, 286), (1339, 340), (1040, 340), (1040, 431), (1060, 431)], "true", active=True)
edge([(1230, 431), (1260, 431)], "updates", active=True)
edge([(1339, 470), (1339, 540), (1242, 540), (1242, 578)], "triggers")

for key, (x1, y1, x2, y2, title, detail, kind) in nodes.items():
    color = node_colors[kind]
    active = key == "setter"
    if active:
        draw.rounded_rectangle((x1 - 5, y1 - 5, x2 + 5, y2 + 5), radius=10, fill="#344454")
    draw.rounded_rectangle((x1, y1, x2, y2), radius=7, fill="#252526", outline=color, width=4 if active else 2)
    draw.text((x1 + 13, y1 + 12), title, font=UI_BOLD, fill="#f3f3f3")
    draw.multiline_text((x1 + 13, y1 + 40), detail, font=UI_SMALL, fill="#b8b8b8", spacing=2)

# Footer/status bar.
draw.rectangle((0, HEIGHT - 24, WIDTH, HEIGHT), fill="#007acc")
draw.text((14, HEIGHT - 21), "⑂  main     ✓ 0     ⚠ 0", font=UI_SMALL, fill="#ffffff")
draw.text((1180, HEIGHT - 21), "TypeScript React    UTF-8", font=UI_SMALL, fill="#ffffff")

img.save(OUTPUT, optimize=True)
print(OUTPUT)
