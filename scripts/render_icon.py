from pathlib import Path
from PIL import Image, ImageDraw

SCALE = 4
SIZE = 128
canvas = Image.new("RGBA", (SIZE * SCALE, SIZE * SCALE), (0, 0, 0, 0))
draw = ImageDraw.Draw(canvas)

def box(values):
    return tuple(value * SCALE for value in values)

draw.rounded_rectangle(box((5, 5, 123, 123)), radius=25 * SCALE, fill="#161b22", outline="#30363d", width=2 * SCALE)

# Code brackets frame the live mental model.
draw.line([box((42, 32)), box((25, 64)), box((42, 96))], fill="#58a6ff", width=8 * SCALE, joint="curve")
draw.line([box((86, 32)), box((103, 64)), box((86, 96))], fill="#58a6ff", width=8 * SCALE, joint="curve")

# Connected semantic nodes represent event → state → render flow.
points = [(52, 45), (75, 64), (52, 83)]
draw.line([box(points[0]), box(points[1]), box(points[2])], fill="#8b949e", width=4 * SCALE, joint="curve")
for (x, y), color in zip(points, ("#39c5cf", "#ffa657", "#3fb950")):
    draw.ellipse(box((x - 8, y - 8, x + 8, y + 8)), fill=color, outline="#f0f6fc", width=2 * SCALE)

canvas.resize((SIZE, SIZE), Image.Resampling.LANCZOS).save(Path(__file__).parents[1] / "media" / "icon.png")
