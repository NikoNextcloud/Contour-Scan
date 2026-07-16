from __future__ import annotations

import json

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from app.models import ExportRequest, ScanResponse
from app.models import Measurements
from app.services.contour_processor import ScanOptions, scan_image
from app.services.exporters import export_csv, export_dxf, export_svg
from app.services.geometry import bounding_box, polygon_area, polygon_perimeter

app = FastAPI(
    title="ContourScan AI API",
    version="1.0.0",
    description="Image contour extraction, measurement, CAD export, and learning workflow API.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "contourscan-ai-api"}


@app.post("/scan", response_model=ScanResponse)
async def scan(file: UploadFile = File(...), pixels_per_mm: float = 3.0, smoothing: float = 0.012) -> ScanResponse:
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="No image uploaded")
    return scan_image(payload, ScanOptions(pixels_per_mm=pixels_per_mm, smoothing=smoothing))


@app.post("/remove-background")
async def remove_background(file: UploadFile = File(...)) -> dict[str, str]:
    await file.read()
    return {"status": "queued", "method": "opencv-grabcut-ready"}


@app.post("/detect-contour", response_model=ScanResponse)
async def detect_contour(file: UploadFile = File(...)) -> ScanResponse:
    return await scan(file)


@app.post("/measure")
def measure(request: ExportRequest) -> dict[str, object]:
    box = bounding_box(request.contour)
    width = box["width"]
    height = box["height"]
    measurements = Measurements(
        width_mm=round(width, 3),
        height_mm=round(height, 3),
        area_mm2=round(polygon_area(request.contour), 3),
        perimeter_mm=round(polygon_perimeter(request.contour), 3),
        aspect_ratio=round(width / height, 3) if height else 0,
        bounding_box={key: round(value, 3) for key, value in box.items()},
        confidence=100.0,
    )
    return {"measurements": measurements.model_dump(), "point_count": len(request.contour)}


@app.post("/export/{format_name}")
def export(format_name: str, request: ExportRequest) -> Response:
    selected = format_name.lower()
    if selected == "svg":
        return Response(export_svg(request.contour, request.units, request.precision), media_type="image/svg+xml")
    if selected == "dxf":
        return Response(export_dxf(request.contour, request.precision), media_type="application/dxf")
    if selected == "csv":
        return Response(export_csv(request.contour, request.precision), media_type="text/csv")
    if selected == "json":
        return Response(json.dumps([point.model_dump() for point in request.contour]), media_type="application/json")
    raise HTTPException(status_code=400, detail=f"Unsupported export format: {format_name}")


@app.get("/history")
def history() -> list[dict[str, object]]:
    return [
        {
            "id": "demo-scan-001",
            "object_type": "Rubber seal",
            "measurements": {"width_mm": 286.4, "height_mm": 214.8, "area_mm2": 42186},
            "exports": ["dxf", "svg", "json"],
        }
    ]


@app.delete("/history/{scan_id}")
def delete_history(scan_id: str) -> dict[str, str]:
    return {"status": "deleted", "id": scan_id}
