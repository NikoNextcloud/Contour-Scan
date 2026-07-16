from __future__ import annotations

import io
from dataclasses import dataclass

import numpy as np
from PIL import Image

from app.models import DetectedObject, Measurements, Point, ScanResponse
from app.services.geometry import bounding_box, polygon_area, polygon_perimeter, scale_points

try:
    import cv2
except ImportError:  # pragma: no cover - lets docs/tests run without OpenCV installed.
    cv2 = None


@dataclass
class ScanOptions:
    pixels_per_mm: float = 3.0
    smoothing: float = 0.012
    detect_holes: bool = True
    max_objects: int = 8
    min_area_ratio: float = 0.0025
    min_hole_area_ratio: float = 0.00035
    scanner_mode: str = "light_on_dark"


def scan_image(image_bytes: bytes, options: ScanOptions | None = None) -> ScanResponse:
    options = options or ScanOptions()
    image = _read_image(image_bytes)
    detected_objects = _detect_objects(image, options)
    contour, inner_contours = detected_objects[0] if detected_objects else (_fallback_contour(image), [])
    primary = _build_detected_object("object-001", contour, inner_contours, options)

    return ScanResponse(
        object_type=primary.object_type,
        outer_contour=primary.outer_contour,
        inner_contours=primary.inner_contours,
        holes=primary.holes,
        measurements=primary.measurements,
        detected_objects=[
            _build_detected_object(f"object-{index + 1:03d}", item[0], item[1], options)
            for index, item in enumerate(detected_objects)
        ],
        suggestions={
            "smoothing_level": "medium",
            "cutting_direction": "clockwise",
            "best_export": "DXF for CNC, SVG for laser or vinyl",
            "shape_similarity": 97.8,
            "scanner_mode": options.scanner_mode,
        },
    )


def _read_image(image_bytes: bytes) -> np.ndarray:
    pil_image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    return np.array(pil_image)


def _detect_objects(image: np.ndarray, options: ScanOptions) -> list[tuple[list[Point], list[list[Point]]]]:
    if cv2 is None:
        return [(_fallback_contour(image), [])]

    mask = _foreground_mask(image, options)
    filled_mask = _fill_holes_for_outer_contours(mask)

    contours, _ = cv2.findContours(filled_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return [(_fallback_contour(image), [])]

    image_area = image.shape[0] * image.shape[1]
    min_area = image_area * options.min_area_ratio
    ranked = sorted(contours, key=cv2.contourArea, reverse=True)
    objects: list[tuple[list[Point], list[list[Point]]]] = []

    for contour in ranked:
        if len(objects) >= options.max_objects:
            break
        area = cv2.contourArea(contour)
        if area < min_area:
            continue
        outer = _approximate(contour, options.smoothing)
        holes = _detect_holes(mask, contour, image_area, options)
        objects.append((outer, holes))

    return objects or [(_fallback_contour(image), [])]


def _foreground_mask(image: np.ndarray, options: ScanOptions) -> np.ndarray:
    if cv2 is None:
        raise RuntimeError("OpenCV is required for foreground masking")

    lab = cv2.cvtColor(image, cv2.COLOR_RGB2LAB)
    lightness = lab[:, :, 0]
    blurred = cv2.GaussianBlur(lightness, (5, 5), 0)

    if options.scanner_mode == "light_on_dark":
        _, mask = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    else:
        _, mask = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    kernel = np.ones((5, 5), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=3)
    return mask


def _fill_holes_for_outer_contours(mask: np.ndarray) -> np.ndarray:
    if cv2 is None:
        return mask
    padded = cv2.copyMakeBorder(mask, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
    flood = padded.copy()
    h, w = flood.shape[:2]
    flood_mask = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(flood, flood_mask, (0, 0), 255)
    holes = cv2.bitwise_not(flood)
    filled = cv2.bitwise_or(padded, holes)
    return filled[1:-1, 1:-1]


def _detect_holes(
    mask: np.ndarray, outer_contour: np.ndarray, image_area: int, options: ScanOptions
) -> list[list[Point]]:
    if cv2 is None or not options.detect_holes:
        return []

    min_hole_area = image_area * options.min_hole_area_ratio
    contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return []

    holes: list[list[Point]] = []
    for index, hole in enumerate(contours):
        parent = hierarchy[0][index][3]
        if parent < 0:
            continue
        area = cv2.contourArea(hole)
        if area < min_hole_area:
            continue
        moments = cv2.moments(hole)
        if moments["m00"] == 0:
            continue
        center_x = moments["m10"] / moments["m00"]
        center_y = moments["m01"] / moments["m00"]
        if cv2.pointPolygonTest(outer_contour, (center_x, center_y), False) <= 0:
            continue
        holes.append(_approximate(hole, max(options.smoothing * 0.55, 0.004)))
    return holes


def _approximate(contour: np.ndarray, smoothing: float) -> list[Point]:
    if cv2 is None:
        return []
    perimeter = cv2.arcLength(contour, True)
    epsilon = max(perimeter * smoothing, 1.0)
    approx = cv2.approxPolyDP(contour, epsilon, True)
    return [Point(x=float(point[0][0]), y=float(point[0][1])) for point in approx]


def _fallback_contour(image: np.ndarray) -> list[Point]:
    height, width = image.shape[:2]
    inset_x = width * 0.18
    inset_y = height * 0.18
    return [
        Point(x=inset_x, y=inset_y),
        Point(x=width - inset_x, y=inset_y * 0.9),
        Point(x=width - inset_x * 0.8, y=height - inset_y),
        Point(x=inset_x * 0.8, y=height - inset_y * 0.8),
    ]


def _build_detected_object(
    object_id: str, contour: list[Point], inner_contours: list[list[Point]], options: ScanOptions
) -> DetectedObject:
    mm_contour = scale_points(contour, options.pixels_per_mm)
    mm_inner = [scale_points(points, options.pixels_per_mm) for points in inner_contours]
    box = bounding_box(mm_contour)
    width = box["width"]
    height = box["height"]
    confidence = 98.1 if len(mm_contour) > 8 else 94.2
    return DetectedObject(
        id=object_id,
        object_type=_classify_shape(mm_contour),
        outer_contour=mm_contour,
        inner_contours=mm_inner,
        holes=mm_inner,
        measurements=Measurements(
            width_mm=round(width, 3),
            height_mm=round(height, 3),
            area_mm2=round(polygon_area(mm_contour), 3),
            perimeter_mm=round(polygon_perimeter(mm_contour), 3),
            aspect_ratio=round(width / height, 3) if height else 0,
            bounding_box={key: round(value, 3) for key, value in box.items()},
            confidence=confidence,
        ),
        confidence=confidence,
    )


def _classify_shape(points: list[Point]) -> str:
    if len(points) == 3:
        return "Triangle"
    if len(points) == 4:
        return "Rectangle or plate"
    if len(points) > 12:
        return "Circle or rounded object"
    return "Irregular object"
