from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw

API_ROOT = Path(__file__).resolve().parents[1]
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from app.services.contour_processor import ScanOptions, scan_image  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Create visual contour previews for scanner images.")
    parser.add_argument("images", nargs="+", type=Path)
    parser.add_argument("--out-dir", type=Path, default=Path("contour-previews"))
    parser.add_argument("--pixels-per-mm", type=float, default=3.0)
    parser.add_argument("--min-area-ratio", type=float, default=0.0025)
    args = parser.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)

    for image_path in args.images:
        response = scan_image(
            image_path.read_bytes(),
            ScanOptions(
                pixels_per_mm=args.pixels_per_mm,
                min_area_ratio=args.min_area_ratio,
                max_objects=12,
                smoothing=0.008,
            ),
        )
        image = Image.open(image_path).convert("RGB")
        draw = ImageDraw.Draw(image, "RGBA")

        for item in response.detected_objects:
            outer = [(point.x * args.pixels_per_mm, point.y * args.pixels_per_mm) for point in item.outer_contour]
            if len(outer) >= 3:
                draw.line(outer + [outer[0]], fill=(0, 122, 255, 255), width=5)
            for hole in item.holes:
                hole_points = [(point.x * args.pixels_per_mm, point.y * args.pixels_per_mm) for point in hole]
                if len(hole_points) >= 3:
                    draw.line(hole_points + [hole_points[0]], fill=(34, 197, 94, 255), width=4)

        target = args.out_dir / f"{image_path.stem}-contours.png"
        image.thumbnail((1400, 1400))
        image.save(target, "PNG", optimize=True)
        print(f"{target} - {len(response.detected_objects)} objects")


if __name__ == "__main__":
    main()
