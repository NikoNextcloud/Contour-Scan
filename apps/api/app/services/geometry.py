from __future__ import annotations

from math import hypot

from app.models import Point


def polygon_area(points: list[Point]) -> float:
    if len(points) < 3:
        return 0.0
    total = 0.0
    for index, point in enumerate(points):
        nxt = points[(index + 1) % len(points)]
        total += point.x * nxt.y - nxt.x * point.y
    return abs(total) / 2.0


def polygon_perimeter(points: list[Point]) -> float:
    if len(points) < 2:
        return 0.0
    total = 0.0
    for index, point in enumerate(points):
        nxt = points[(index + 1) % len(points)]
        total += hypot(nxt.x - point.x, nxt.y - point.y)
    return total


def bounding_box(points: list[Point]) -> dict[str, float]:
    if not points:
        return {"x": 0, "y": 0, "width": 0, "height": 0}
    xs = [point.x for point in points]
    ys = [point.y for point in points]
    return {
        "x": min(xs),
        "y": min(ys),
        "width": max(xs) - min(xs),
        "height": max(ys) - min(ys),
    }


def scale_points(points: list[Point], pixels_per_mm: float) -> list[Point]:
    scale = pixels_per_mm if pixels_per_mm > 0 else 1.0
    return [Point(x=point.x / scale, y=point.y / scale) for point in points]
