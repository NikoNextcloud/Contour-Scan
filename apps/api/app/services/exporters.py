from __future__ import annotations

import io

import ezdxf
import svgwrite

from app.models import Point


def export_svg(points: list[Point], units: str = "mm", precision: int = 3) -> str:
    width = max((point.x for point in points), default=100)
    height = max((point.y for point in points), default=100)
    drawing = svgwrite.Drawing(size=(f"{width}{units}", f"{height}{units}"))
    drawing.add(
        drawing.polygon(
            points=[(_round(point.x, precision), _round(point.y, precision)) for point in points],
            fill="none",
            stroke="#1d7afc",
            stroke_width=0.2,
        )
    )
    return drawing.tostring()


def export_dxf(points: list[Point], precision: int = 3) -> bytes:
    document = ezdxf.new("R2010")
    model_space = document.modelspace()
    closed_points = [(_round(point.x, precision), _round(point.y, precision)) for point in points]
    model_space.add_lwpolyline(closed_points, close=True, dxfattribs={"layer": "OUTER_CONTOUR"})
    stream = io.StringIO()
    document.write(stream)
    return stream.getvalue().encode("utf-8")


def export_csv(points: list[Point], precision: int = 3) -> str:
    lines = ["index,x,y"]
    for index, point in enumerate(points):
        lines.append(f"{index},{_round(point.x, precision)},{_round(point.y, precision)}")
    return "\n".join(lines)


def _round(value: float, precision: int) -> float:
    return round(value, max(0, min(precision, 8)))
