"use client";

import { useMemo, useState } from "react";
import { Circle, Group, Layer, Line, Rect, Stage, Text } from "react-konva";
import { ContourPoint } from "@/lib/utils";

type EditorCanvasProps = {
  initialPoints: ContourPoint[];
};

export function EditorCanvas({ initialPoints }: EditorCanvasProps) {
  const [points, setPoints] = useState(initialPoints);
  const flatPoints = useMemo(() => points.flatMap((point) => [point.x, point.y]), [points]);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <Stage width={620} height={430} className="max-w-full">
        <Layer>
          <Rect x={0} y={0} width={620} height={430} fill="#f6f7f8" />
          {Array.from({ length: 16 }).map((_, index) => (
            <Line
              key={`v-${index}`}
              points={[index * 40, 0, index * 40, 430]}
              stroke="#d8dde3"
              strokeWidth={1}
            />
          ))}
          {Array.from({ length: 11 }).map((_, index) => (
            <Line
              key={`h-${index}`}
              points={[0, index * 40, 620, index * 40]}
              stroke="#d8dde3"
              strokeWidth={1}
            />
          ))}
          <Group>
            <Line
              points={flatPoints}
              closed
              stroke="#1d7afc"
              strokeWidth={3}
              fill="rgba(29, 122, 252, 0.1)"
              tension={0.18}
            />
            {points.map((point, index) => (
              <Circle
                key={`${point.x}-${point.y}-${index}`}
                x={point.x}
                y={point.y}
                radius={7}
                fill="#ffffff"
                stroke="#1d7afc"
                strokeWidth={3}
                draggable
                onDragMove={(event) => {
                  const next = [...points];
                  next[index] = { x: event.target.x(), y: event.target.y() };
                  setPoints(next);
                }}
              />
            ))}
          </Group>
          <Line points={[458, 92, 526, 92, 526, 160, 458, 160]} closed stroke="#ef4444" strokeWidth={2} dash={[8, 6]} />
          <Circle x={492} y={126} radius={26} stroke="#22c55e" strokeWidth={2} dash={[7, 5]} />
          <Text x={20} y={388} text="Outer contour: blue  |  Cut-outs: red  |  Holes: green" fontSize={14} fill="#384150" />
        </Layer>
      </Stage>
    </div>
  );
}
