import { setWorkerUrl } from 'maplibre-gl'
// MapLibre draws lines and shapes in a background worker. It normally finds that worker file
// next to its own code, but Vite moves its code, so the worker was never found: markers showed
// but no line could be drawn. Point MapLibre at a worker Vite has bundled itself.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

setWorkerUrl(workerUrl)
