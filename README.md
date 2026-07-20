# ContourScan AI

**От снимка до DXF за секунди.** Извличане на външния контур на обект от снимка и експорт към DXF / SVG / PNG за CNC, лазерно рязане, винил и CAD — изцяло в браузъра, без сървър.

_From photo to DXF in seconds. Extract an object's outer contour from a photo and export to DXF / SVG / PNG for CNC, laser, vinyl and CAD — entirely in the browser, no server._

---

## 🇧🇬 Български

### Какво прави

1. **Сканиране** — качваш снимка (или снимаш с камерата) на обект върху контрастен фон.
2. **Детекция** — OpenCV.js (WebAssembly) намира външния контур и вътрешните дупки, филтрира шум и прах.
3. **Калибрация** — кликваш две точки върху предмет с известен размер (кредитна карта, монета, лист A4) и въвеждаш реалната дължина → всички размери стават в милиметри.
4. **Редакция** — влачиш точки, добавяш/триеш възли, изглаждаш или опростяваш контура.
5. **Експорт** — DXF (R12, слоеве LINE/CUT/MARK), SVG (в мм), PNG, JSON или CSV.

Снимките **не напускат устройството ти** — цялата обработка е локална. Историята се пази в браузъра (IndexedDB).

### Локално стартиране

```bash
npm install
npm run dev      # http://localhost:3000
```

Други команди:

```bash
npm run build    # продукционен build
npm run start    # стартиране на build-а
npm run lint     # проверка с ESLint
```

Изисква **Node.js 18+** (препоръчано 20/22).

### Публикуване във Vercel

1. Качи проекта в GitHub репо.
2. В [vercel.com](https://vercel.com) → **Add New → Project** → избери репото.
3. Framework preset: **Next.js** (разпознава се автоматично). Няма нужда от environment променливи.
4. **Deploy**. Готово — приложението е статично и се хоства на Vercel Hobby безплатно.

> OpenCV.js (~9 MB) се зарежда еднократно от официалния CDN на OpenCV при първото сканиране и се кешира от браузъра.

---

## 🇬🇧 English

### What it does

1. **Scan** — upload a photo (or use the camera) of an object on a contrasting background.
2. **Detect** — OpenCV.js (WebAssembly) finds the outer contour and inner holes, filtering noise.
3. **Calibrate** — click two points on an item of known size (credit card, coin, A4 sheet) and enter the real length → all dimensions become millimetres.
4. **Edit** — drag points, add/remove nodes, smooth or simplify the contour.
5. **Export** — DXF (R12, LINE/CUT/MARK layers), SVG (in mm), PNG, JSON or CSV.

Photos **never leave your device** — all processing is local. History is stored in the browser (IndexedDB).

### Run locally

```bash
npm install
npm run dev      # http://localhost:3000
```

Requires **Node.js 18+** (20/22 recommended).

### Deploy to Vercel

Push to GitHub, import the repo at [vercel.com](https://vercel.com), keep the auto-detected **Next.js** preset, and click **Deploy**. No environment variables required — the app is fully static.

---

## Tech stack

| Layer          | Choice                                                        |
| -------------- | ------------------------------------------------------------ |
| Framework      | Next.js 15 (App Router) + React 19                           |
| Language       | TypeScript (strict)                                          |
| Styling        | Tailwind CSS v4 (design tokens, dark/light)                  |
| Vision         | OpenCV.js (WASM): grayscale → threshold → morphology → findContours |
| Geometry       | Pure TS: shoelace area, rotating-calipers min-rect, RDP, Chaikin |
| Storage        | IndexedDB (history) + localStorage (settings)               |
| Export         | Hand-written DXF R12 & SVG (physical mm) writers             |

## Contour pipeline

```
grayscale → Gaussian blur → threshold (Otsu | adaptive)
          → auto-invert (from border pixels) → morphology (open + close)
          → findContours (RETR_CCOMP) → largest top-level contour = LINE
          → children above size threshold = CUT holes → approxPolyDP
```

## License

MIT — see [LICENSE](./LICENSE).
