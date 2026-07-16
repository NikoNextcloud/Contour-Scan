# ContourScan AI

ContourScan AI is a full-stack web application for extracting production-ready object contours from photos and exporting them for CNC, laser cutting, vinyl cutting, printing, CAD, and manufacturing.

The repository is prepared for:

- Frontend deployment on Vercel
- Backend deployment on Render, Railway, or Docker
- GitHub Actions for build, lint, and tests
- Future AI model integration with OpenCV, ONNX Runtime, TensorFlow, PyTorch, OpenVINO, Cloudflare AI, Supabase, or vector databases

## Project Structure

```text
ContourScan-AI/
  apps/
    web/      Next.js 15, React 19, TypeScript, TailwindCSS, Framer Motion, React Konva
    api/      FastAPI, OpenCV, NumPy, Pillow, ezdxf, svgwrite
  .github/    CI workflow
  vercel.json
  render.yaml
  docker-compose.yml
```

## Features Included

- Modern SaaS dashboard
- Drag and drop image upload UI
- Camera-ready scanner workflow
- Calibration-ready measurement panel
- Interactive contour editor with draggable points
- Outer contour, inner contour, and hole color coding
- CAD tooling panels for DXF comparison, cut paths, lead-in, lead-out, offsets, tabs, and bridges
- Smart contour learning dashboard
- Object library categories
- Export targets: DXF, SVG, PNG, PDF, JSON, CSV, and G-Code
- FastAPI endpoints for scanning, contour detection, measurement, history, and export
- OpenCV contour pipeline with fallback behavior
- Multi-object detection for scans with several paper templates on one dark scanner mat
- Scanner mode tuned for light paper/card details on dark backgrounds
- Unit tests for geometry calculations

## Local Development

### Frontend

```bash
cd ContourScan-AI
npm install
npm run dev
```

Open `http://localhost:3000`.

### Backend

```bash
cd ContourScan-AI/apps/api
python -m venv .venv
.venv/Scripts/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Open `http://localhost:8000/docs`.

## Preview Real Scanner Images

After installing backend requirements, generate visual contour previews:

```bash
cd ContourScan-AI
python apps/api/tools/preview_contours.py sample-scans/MDS01782.png sample-scans/MDS01789.png sample-scans/MDS01790.png --out-dir sample-contours
```

Blue lines are outer contours. Green lines are detected holes or cut-outs.

## Environment Variables

Copy `.env.example` to `.env.local` for local work.

```env
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_APP_NAME=ContourScan AI
CONTOURSCAN_STORAGE=local
CONTOURSCAN_MAX_UPLOAD_MB=100
```

On Vercel, set `NEXT_PUBLIC_API_URL` to the deployed Render or Railway backend URL.

## Deploy Frontend to Vercel

1. Push this folder to a GitHub repository.
2. Open Vercel and import the repository.
3. Set the project root to `apps/web` if Vercel asks for it.
4. Add `NEXT_PUBLIC_API_URL` in Environment Variables.
5. Deploy.

The root `vercel.json` is included for monorepo deployment.

## Deploy Backend to Render

1. Push the repository to GitHub.
2. In Render, create a new Web Service.
3. Select the same repository.
4. Use `apps/api` as the root directory.
5. Build command:

```bash
pip install -r requirements.txt
```

6. Start command:

```bash
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

The included `render.yaml` can also be used as a blueprint.

## Docker

```bash
cd ContourScan-AI
docker compose up --build
```

Frontend: `http://localhost:3000`  
Backend: `http://localhost:8000`

## API

- `GET /health`
- `POST /scan`
- `POST /scan/multi`
- `POST /remove-background`
- `POST /detect-contour`
- `POST /measure`
- `POST /export/dxf`
- `POST /export/svg`
- `POST /export/csv`
- `POST /export/json`
- `GET /history`
- `DELETE /history/{id}`

## Future AI Architecture

The API is organized so model providers can be swapped without changing the frontend. Add model adapters under `apps/api/app/services/` for:

- ONNX Runtime
- TensorFlow
- PyTorch
- OpenVINO
- OpenCV DNN
- Cloudflare Workers AI
- Vectorize or Supabase vector search

## Dataset Export Roadmap

The data model is prepared for future export to:

- JSON
- COCO
- YOLO Segmentation
- Pascal VOC
- CSV
- Polygon coordinates
- Binary masks
- DXF
- SVG

## GitHub Checklist

```bash
git init
git add .
git commit -m "Initial ContourScan AI project"
git branch -M main
git remote add origin https://github.com/YOUR_USER/contourscan-ai.git
git push -u origin main
```
