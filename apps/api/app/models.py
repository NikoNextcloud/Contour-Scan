from pydantic import BaseModel, Field


class Point(BaseModel):
    x: float
    y: float


class Measurements(BaseModel):
    width_mm: float
    height_mm: float
    area_mm2: float
    perimeter_mm: float
    aspect_ratio: float
    bounding_box: dict[str, float]
    confidence: float


class ScanResponse(BaseModel):
    object_type: str = "Irregular object"
    outer_contour: list[Point]
    inner_contours: list[list[Point]] = Field(default_factory=list)
    holes: list[list[Point]] = Field(default_factory=list)
    measurements: Measurements
    suggestions: dict[str, str | float]


class ExportRequest(BaseModel):
    contour: list[Point]
    format: str = "svg"
    units: str = "mm"
    precision: int = 3
