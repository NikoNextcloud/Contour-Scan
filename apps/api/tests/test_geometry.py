from app.models import Point
from app.services.geometry import bounding_box, polygon_area, polygon_perimeter, scale_points


def test_polygon_area_for_square():
    points = [Point(x=0, y=0), Point(x=10, y=0), Point(x=10, y=10), Point(x=0, y=10)]
    assert polygon_area(points) == 100


def test_polygon_perimeter_for_square():
    points = [Point(x=0, y=0), Point(x=10, y=0), Point(x=10, y=10), Point(x=0, y=10)]
    assert polygon_perimeter(points) == 40


def test_bounding_box():
    points = [Point(x=2, y=4), Point(x=8, y=1), Point(x=5, y=12)]
    assert bounding_box(points) == {"x": 2, "y": 1, "width": 6, "height": 11}


def test_scale_points():
    points = [Point(x=20, y=10)]
    scaled = scale_points(points, 2)
    assert scaled[0].x == 10
    assert scaled[0].y == 5
