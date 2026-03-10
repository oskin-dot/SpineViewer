import { Component, type ErrorInfo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { Application, Container, RenderTexture } from "pixi.js";
import { Spine } from "pixi-spine";
import {
  advanceSpineAnimation,
  analyzeSpineFiles,
  createSpineInstance,
  formatDuration,
  formatRuntimeLabel,
  getAnimationDuration,
  loadSpineAsset,
  startSpineAnimation,
  setSpineAnimationTime,
  type LoadedSpineAsset,
} from "./utils/spine";

const EXPORT_PADDING = 8;
const UI_SYNC_INTERVAL = 80;
const PREVIEW_SAMPLE_FPS = 30;
const MAX_PREVIEW_SAMPLES = 180;

type LoadState = "idle" | "loading" | "ready" | "error";
type BoundsRect = { x: number; y: number; width: number; height: number };

function clampFps(value: number) {
  if (!Number.isFinite(value)) {
    return 30;
  }

  return Math.min(60, Math.max(1, Math.round(value)));
}

function clampSpeed(value: number) {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.min(3, Math.max(0.1, Number(value.toFixed(2))));
}

function clampZoom(value: number) {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.min(3, Math.max(0.2, Number(value.toFixed(2))));
}

function sanitizeFilename(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9-_]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || "animation";
}

function buildFrameTimes(duration: number, fps: number) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return [0];
  }

  const times: number[] = [];
  const step = 1 / fps;
  let time = 0;

  while (time < duration) {
    times.push(Number(time.toFixed(6)));
    time += step;
  }

  if (!times.length || Math.abs(times[times.length - 1] - duration) > 1e-4) {
    times.push(Number(duration.toFixed(6)));
  }

  return times;
}

function buildPreviewSampleTimes(duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return [0];
  }

  const sampleCount = Math.min(MAX_PREVIEW_SAMPLES, Math.max(PREVIEW_SAMPLE_FPS, Math.ceil(duration * PREVIEW_SAMPLE_FPS)));
  const times: number[] = [];

  for (let index = 0; index < sampleCount; index += 1) {
    const progress = sampleCount === 1 ? 0 : index / (sampleCount - 1);
    times.push(Number((duration * progress).toFixed(6)));
  }

  return times;
}

function getUnscaledBounds(spine: Spine) {
  const previousScaleX = spine.scale.x;
  const previousScaleY = spine.scale.y;

  spine.scale.set(1);
  const bounds = spine.getLocalBounds();
  spine.scale.set(previousScaleX, previousScaleY);

  return bounds;
}

function fitSpineToViewport(spine: Spine, width: number, height: number, bounds: BoundsRect, zoom: number) {
  const contentWidth = Math.max(bounds.width, 1);
  const contentHeight = Math.max(bounds.height, 1);
  const padding = Math.max(24, Math.min(width, height) * 0.04);
  const baseScale = Math.min(
    Math.max(0.01, (width - padding * 2) / contentWidth),
    Math.max(0.01, (height - padding * 2) / contentHeight)
  );
  const scale = Math.max(0.01, baseScale * zoom);

  spine.scale.set(scale);
  spine.position.set(width / 2 - (bounds.x + bounds.width / 2) * scale, height / 2 - (bounds.y + bounds.height / 2) * scale);
}

function measureAnimationBounds(spine: Spine, animationName: string, times: number[]) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let previousTime = 0;

  startSpineAnimation(spine, animationName, false);

  for (const time of times) {
    const delta = Math.max(0, time - previousTime);

    if (delta > 0) {
      advanceSpineAnimation(spine, delta);
    }

    previousTime = time;
    const bounds = getUnscaledBounds(spine);

    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function measureBoundsForAnimation(asset: LoadedSpineAsset, animationName: string) {
  const duration = getAnimationDuration(asset.animations, animationName);
  const probe = createSpineInstance(asset.skeletonData);

  try {
    return measureAnimationBounds(probe, animationName, buildPreviewSampleTimes(duration));
  } finally {
    probe.destroy({ children: true });
  }
}

async function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Не удалось собрать PNG-кадр."));
        return;
      }

      resolve(blob);
    }, "image/png");
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatSpeedLabel(value: number) {
  return `${value.toFixed(2)}x`;
}

function formatZoomLabel(value: number) {
  return `${Math.round(value * 100)}%`;
}

type SpinePreviewProps = {
  asset: LoadedSpineAsset | null;
  animationName: string;
  isLooping: boolean;
  isPlaying: boolean;
  playbackSpeed: number;
  zoom: number;
  restartToken: number;
  onTimeChange: (time: number) => void;
  onPlaybackFinished: () => void;
  onError: (message: string) => void;
};

function SpinePreview({
  asset,
  animationName,
  isLooping,
  isPlaying,
  playbackSpeed,
  zoom,
  restartToken,
  onTimeChange,
  onPlaybackFinished,
  onError,
}: SpinePreviewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application<HTMLCanvasElement> | null>(null);
  const spineRef = useRef<Spine | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const currentTimeRef = useRef(0);
  const lastUiSyncRef = useRef(0);
  const lastFrameTimestampRef = useRef<number | null>(null);
  const finishedRef = useRef(false);
  const layoutBoundsRef = useRef<BoundsRect | null>(null);
  const animationRef = useRef(animationName);
  const assetRef = useRef(asset);
  const playingRef = useRef(isPlaying);
  const loopingRef = useRef(isLooping);
  const speedRef = useRef(playbackSpeed);
  const zoomRef = useRef(zoom);
  const onTimeChangeRef = useRef(onTimeChange);
  const onPlaybackFinishedRef = useRef(onPlaybackFinished);
  const onErrorRef = useRef(onError);

  const layoutPreview = useCallback(() => {
    if (!spineRef.current || !appRef.current) {
      return;
    }

    fitSpineToViewport(
      spineRef.current,
      appRef.current.screen.width,
      appRef.current.screen.height,
      layoutBoundsRef.current ?? getUnscaledBounds(spineRef.current),
      zoomRef.current
    );
  }, []);

  useEffect(() => {
    animationRef.current = animationName;
  }, [animationName]);

  useEffect(() => {
    assetRef.current = asset;
  }, [asset]);

  useEffect(() => {
    playingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    loopingRef.current = isLooping;
  }, [isLooping]);

  useEffect(() => {
    speedRef.current = playbackSpeed;
  }, [playbackSpeed]);

  useEffect(() => {
    zoomRef.current = zoom;
    layoutPreview();
  }, [layoutPreview, zoom]);

  useEffect(() => {
    onTimeChangeRef.current = onTimeChange;
  }, [onTimeChange]);

  useEffect(() => {
    onPlaybackFinishedRef.current = onPlaybackFinished;
  }, [onPlaybackFinished]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    if (!asset || !hostRef.current) {
      return;
    }

    const host = hostRef.current;
    host.innerHTML = "";

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

    try {
      const app = new Application<HTMLCanvasElement>({
        antialias: true,
        autoStart: false,
        autoDensity: true,
        backgroundAlpha: 0,
        sharedTicker: false,
        width: Math.max(host.clientWidth, 320),
        height: Math.max(host.clientHeight, 520),
        resolution: Math.min(window.devicePixelRatio || 1, 2),
      });

      const view = app.view as HTMLCanvasElement;
      view.style.width = "100%";
      view.style.height = "100%";
      view.style.display = "block";

      const root = new Container();
      const spine = createSpineInstance(asset.skeletonData, { autoUpdate: false });

      root.addChild(spine);
      app.stage.addChild(root);
      host.appendChild(view);

      appRef.current = app;
      spineRef.current = spine;
      currentTimeRef.current = 0;
      lastUiSyncRef.current = 0;
      lastFrameTimestampRef.current = null;
      finishedRef.current = false;

      const handleResize = () => {
        if (!hostRef.current || !appRef.current) {
          return;
        }

        appRef.current.renderer.resize(Math.max(hostRef.current.clientWidth, 320), Math.max(hostRef.current.clientHeight, 520));
        layoutPreview();
        appRef.current.renderer.render(appRef.current.stage);
      };

      resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(host);
      handleResize();

      const tick = (timestamp: number) => {
        try {
          if (disposed || !spineRef.current || !assetRef.current || !animationRef.current) {
            return;
          }

          const duration = getAnimationDuration(assetRef.current.animations, animationRef.current);
          const previousTimestamp = lastFrameTimestampRef.current ?? timestamp;
          const deltaSeconds = Math.min(0.1, Math.max(0, (timestamp - previousTimestamp) / 1000));
          let nextTime = currentTimeRef.current;

          lastFrameTimestampRef.current = timestamp;

          if (playingRef.current) {
            const scaledDelta = deltaSeconds * speedRef.current;

            if (duration > 0 && !loopingRef.current) {
              const remaining = Math.max(0, duration - nextTime);
              const appliedDelta = Math.min(scaledDelta, remaining);

              if (appliedDelta > 0) {
                advanceSpineAnimation(spineRef.current, appliedDelta);
              }

              nextTime += appliedDelta;
            } else {
              if (scaledDelta > 0) {
                advanceSpineAnimation(spineRef.current, scaledDelta);
              }

              nextTime += scaledDelta;

              if (duration > 0 && loopingRef.current) {
                nextTime %= duration;
              }
            }
          }

          currentTimeRef.current = nextTime;
          app.renderer.render(app.stage);

          if (duration > 0 && !loopingRef.current && playingRef.current && nextTime >= duration && !finishedRef.current) {
            finishedRef.current = true;
            playingRef.current = false;
            lastUiSyncRef.current = duration;
            onTimeChangeRef.current(duration);
            onPlaybackFinishedRef.current();
          }

          if (
            !playingRef.current ||
            Math.abs(nextTime - lastUiSyncRef.current) >= UI_SYNC_INTERVAL / 1000 ||
            nextTime === 0
          ) {
            lastUiSyncRef.current = nextTime;
            onTimeChangeRef.current(nextTime);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Не удалось показать превью Spine.";
          onErrorRef.current(message);
        }

        animationFrameRef.current = window.requestAnimationFrame(tick);
      };

      animationFrameRef.current = window.requestAnimationFrame(tick);

      return () => {
        disposed = true;
        resizeObserver?.disconnect();
        if (animationFrameRef.current !== null) {
          window.cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
        root.destroy({ children: true });
        app.destroy(true, { children: true });
        if (appRef.current === app) {
          appRef.current = null;
        }
        if (spineRef.current === spine) {
          spineRef.current = null;
        }
        host.innerHTML = "";
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось создать окно превью.";
      onErrorRef.current(message);
      return undefined;
    }
  }, [asset, layoutPreview]);

  useEffect(() => {
    if (!asset || !spineRef.current || !animationName) {
      return;
    }

    try {
      layoutBoundsRef.current = measureBoundsForAnimation(asset, animationName);
      startSpineAnimation(spineRef.current, animationName, isLooping);
      currentTimeRef.current = 0;
      lastUiSyncRef.current = 0;
      lastFrameTimestampRef.current = null;
      finishedRef.current = false;
      onTimeChangeRef.current(0);
      layoutPreview();
      appRef.current?.renderer.render(appRef.current.stage);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось переключить анимацию.";
      onErrorRef.current(message);
    }
  }, [animationName, asset, isLooping, layoutPreview, restartToken]);

  return <div ref={hostRef} className="h-full min-h-[520px] w-full" />;
}

type ErrorBoundaryState = {
  errorMessage: string;
};

class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    errorMessage: "",
  };

  static getDerivedStateFromError(error: Error) {
    return {
      errorMessage: error.message || "Произошла ошибка в интерфейсе.",
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Spine viewer crashed", error, info);
  }

  render() {
    if (this.state.errorMessage) {
      return (
        <div className="min-h-screen bg-slate-950 px-4 py-10 text-white">
          <div className="mx-auto max-w-3xl border border-rose-400/30 bg-rose-400/10 p-6">
            <h1 className="text-2xl font-semibold">Приложение столкнулось с ошибкой</h1>
            <p className="mt-3 text-sm leading-6 text-slate-200">Ниже показан текст ошибки. Его можно прислать мне, и я продолжу точечную правку.</p>
            <div className="mt-4 border border-white/10 bg-black/30 p-4 text-sm text-rose-100">{this.state.errorMessage}</div>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 border border-white/20 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10"
            >
              Перезагрузить страницу
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function SpineStudioApp() {
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [asset, setAsset] = useState<LoadedSpineAsset | null>(null);
  const [selectedAnimation, setSelectedAnimation] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(true);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [restartToken, setRestartToken] = useState(0);
  const [exportFps, setExportFps] = useState(30);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [dragActive, setDragActive] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const assetRef = useRef<LoadedSpineAsset | null>(null);

  const animationDuration = useMemo(() => {
    if (!asset || !selectedAnimation) {
      return 0;
    }

    return getAnimationDuration(asset.animations, selectedAnimation);
  }, [asset, selectedAnimation]);

  useEffect(() => {
    assetRef.current = asset;
  }, [asset]);

  useEffect(() => {
    return () => {
      assetRef.current?.cleanup();
    };
  }, []);

  useEffect(() => {
    const preventWindowDrop = (event: DragEvent) => {
      event.preventDefault();
    };

    window.addEventListener("dragover", preventWindowDrop);
    window.addEventListener("drop", preventWindowDrop);

    return () => {
      window.removeEventListener("dragover", preventWindowDrop);
      window.removeEventListener("drop", preventWindowDrop);
    };
  }, []);

  const disposeLoadedAsset = useCallback(() => {
    assetRef.current?.cleanup();
    assetRef.current = null;
  }, []);

  const clearLoadedState = useCallback(
    (nextLoadState: LoadState) => {
      disposeLoadedAsset();
      setAsset(null);
      setSelectedAnimation("");
      setCurrentTime(0);
      setWarnings([]);
      setPreviewError("");
      setIsPlaying(false);
      setIsLooping(true);
      setPlaybackSpeed(1);
      setPreviewZoom(1);
      setLoadState(nextLoadState);
      setIsExporting(false);
      setExportProgress(0);
    },
    [disposeLoadedAsset]
  );

  const clearSession = useCallback(() => {
    setErrorMessage("");
    clearLoadedState("idle");

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [clearLoadedState]);

  const handleFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);

      if (!files.length) {
        return;
      }

      setErrorMessage("");
      clearLoadedState("loading");

      try {
        const analysis = await analyzeSpineFiles(files);
        const loadedAsset = await loadSpineAsset(analysis);

        if (!loadedAsset.animations.length) {
          loadedAsset.cleanup();
          throw new Error("В этом файле не найдено ни одной анимации.");
        }

        assetRef.current = loadedAsset;
        setAsset(loadedAsset);
        setSelectedAnimation(loadedAsset.animations[0].name);
        setCurrentTime(0);
        setIsPlaying(true);
        setIsLooping(true);
        setPlaybackSpeed(1);
        setPreviewZoom(1);
        setRestartToken((value) => value + 1);
        setWarnings(loadedAsset.warnings);
        setLoadState("ready");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Не удалось открыть Spine-экспорт.";
        setErrorMessage(message);
        setLoadState("error");
      }
    },
    [clearLoadedState]
  );

  const triggerFileDialog = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handlePreviewError = useCallback((message: string) => {
    setPreviewError(message);
    setLoadState("error");
  }, []);

  const handlePreviewFinished = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const handlePlay = useCallback(() => {
    if (!asset || !selectedAnimation) {
      return;
    }

    if (!isLooping && animationDuration > 0 && currentTime >= animationDuration) {
      setRestartToken((value) => value + 1);
      setCurrentTime(0);
    }

    setIsPlaying(true);
  }, [animationDuration, asset, currentTime, isLooping, selectedAnimation]);

  const handleStop = useCallback(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setRestartToken((value) => value + 1);
  }, []);

  const onExportFrames = useCallback(async () => {
    if (!asset || !selectedAnimation || isExporting) {
      return;
    }

    const fps = clampFps(exportFps);
    const times = buildFrameTimes(animationDuration, fps);
    const exportSpine = createSpineInstance(asset.skeletonData);
    const exportRoot = new Container();
    exportRoot.addChild(exportSpine);

    let exportApp: Application<HTMLCanvasElement> | null = null;
    let renderTexture: RenderTexture | null = null;

    setIsPlaying(false);
    setIsExporting(true);
    setExportProgress(0);
    setErrorMessage("");

    try {
      const bounds = measureAnimationBounds(exportSpine, selectedAnimation, times);
      const width = Math.ceil(bounds.width + EXPORT_PADDING * 2);
      const height = Math.ceil(bounds.height + EXPORT_PADDING * 2);
      const zip = new JSZip();
      const exportName = sanitizeFilename(selectedAnimation);

      exportApp = new Application<HTMLCanvasElement>({
        antialias: true,
        autoDensity: true,
        backgroundAlpha: 0,
        width,
        height,
        preserveDrawingBuffer: true,
        resolution: 1,
      });

      renderTexture = RenderTexture.create({ width, height, resolution: 1 });
      exportSpine.position.set(-bounds.x + EXPORT_PADDING, -bounds.y + EXPORT_PADDING);

      for (let index = 0; index < times.length; index += 1) {
        setSpineAnimationTime(exportSpine, selectedAnimation, times[index], false);
        exportApp.renderer.render(exportRoot, { renderTexture, clear: true });

        const canvas = exportApp.renderer.extract.canvas(renderTexture);
        const blob = await canvasToBlob(canvas as HTMLCanvasElement);
        const frameNumber = String(index + 1).padStart(4, "0");

        zip.file(`${exportName}_${frameNumber}.png`, blob);
        setExportProgress((index + 1) / times.length);
      }

      const archive = await zip.generateAsync({ type: "blob" });
      downloadBlob(archive, `${exportName}_${fps}fps_png_sequence.zip`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось экспортировать PNG sequence.";
      setErrorMessage(message);
    } finally {
      renderTexture?.destroy(true);
      exportRoot.destroy({ children: true });
      exportApp?.destroy(true, { children: true });
      setIsExporting(false);
      setExportProgress(0);
    }
  }, [animationDuration, asset, exportFps, isExporting, selectedAnimation]);

  const progressPercent = Math.round(exportProgress * 100);

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto max-w-[1600px] px-4 py-4 sm:px-6 sm:py-6">
        <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <aside className="border border-white/10 bg-slate-900">
            <div className="border-b border-white/10 px-5 py-4">
              <p className="text-xs uppercase tracking-[0.28em] text-cyan-200">Local Spine Viewer</p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight">Spine Player + PNG Export</h1>
              <p className="mt-2 text-sm leading-6 text-slate-400">Слева вся работа с файлами и анимацией. Справа только большое окно превью.</p>
            </div>

            <div className="space-y-0">
              <section className="border-b border-white/10 px-5 py-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-medium text-white">Загрузка файлов</h2>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={triggerFileDialog}
                      className="border border-cyan-300/40 px-3 py-2 text-sm text-cyan-100 transition hover:bg-cyan-300/10"
                    >
                      Выбрать
                    </button>
                    <button
                      type="button"
                      onClick={clearSession}
                      className="border border-white/15 px-3 py-2 text-sm text-slate-200 transition hover:bg-white/10"
                    >
                      Очистить
                    </button>
                  </div>
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".atlas,.txt,.json,.png,.webp"
                  className="hidden"
                  onChange={(event) => {
                    if (event.target.files) {
                      void handleFiles(event.target.files);
                    }
                    event.target.value = "";
                  }}
                />

                <button
                  type="button"
                  onClick={triggerFileDialog}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragActive(true);
                  }}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragActive(false);
                    void handleFiles(event.dataTransfer.files);
                  }}
                  className={`mt-4 block w-full border border-dashed px-4 py-6 text-left transition ${
                    dragActive ? "border-cyan-300 bg-cyan-300/10" : "border-white/15 bg-slate-950 hover:border-white/30"
                  }`}
                >
                  <p className="text-sm font-medium text-white">Загрузите atlas, json и текстуры</p>
                  <p className="mt-2 text-sm leading-6 text-slate-400">Подходят файлы: .atlas или .txt, .json, .png, .webp.</p>
                </button>
              </section>

              <section className="border-b border-white/10 px-5 py-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-medium text-white">Краткая инфо</h2>
                  <span className="text-xs uppercase tracking-[0.22em] text-slate-500">{loadState}</span>
                </div>

                {asset ? (
                  <div className="mt-4 space-y-2 text-sm text-slate-300">
                    <p>
                      Runtime: <span className="text-white">{formatRuntimeLabel(asset.runtimeKey)}</span>
                    </p>
                    <p>
                      Версия JSON: <span className="text-white">{asset.detectedVersion}</span>
                    </p>
                    <p>
                      Анимаций: <span className="text-white">{asset.animations.length}</span>
                    </p>
                    <p>
                      Текстур: <span className="text-white">{asset.imageFiles.length}</span>
                    </p>
                  </div>
                ) : (
                  <p className="mt-4 text-sm leading-6 text-slate-400">После загрузки здесь появится короткая информация о файлах и версии Spine.</p>
                )}

                {warnings.length > 0 && (
                  <div className="mt-4 border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">
                    {warnings.map((warning) => (
                      <p key={warning}>{warning}</p>
                    ))}
                  </div>
                )}

                {errorMessage && (
                  <div className="mt-4 border border-rose-400/30 bg-rose-400/10 p-3 text-sm text-rose-100">{errorMessage}</div>
                )}

                {previewError && (
                  <div className="mt-4 border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">Ошибка превью: {previewError}</div>
                )}
              </section>

              <section className="border-b border-white/10 px-5 py-4">
                <h2 className="text-sm font-medium text-white">Воспроизведение и масштаб</h2>

                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    disabled={!asset || !selectedAnimation || isExporting}
                    onClick={handlePlay}
                    className="border border-white/15 bg-white px-4 py-2 text-sm font-medium text-slate-950 disabled:cursor-not-allowed disabled:bg-white/20 disabled:text-slate-500"
                  >
                    Play
                  </button>
                  <button
                    type="button"
                    disabled={!asset || !selectedAnimation || isExporting}
                    onClick={handleStop}
                    className="border border-white/15 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Stop
                  </button>
                </div>

                <label className="mt-4 flex items-center gap-3 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={isLooping}
                    disabled={!asset || isExporting}
                    onChange={(event) => {
                      setIsLooping(event.target.checked);
                      setRestartToken((value) => value + 1);
                      setCurrentTime(0);
                    }}
                    className="h-4 w-4 rounded border-white/20 bg-transparent"
                  />
                  Loop
                </label>

                <div className="mt-4 space-y-2">
                  <div className="flex items-center justify-between text-sm text-slate-300">
                    <span>Скорость</span>
                    <span className="text-white">{formatSpeedLabel(playbackSpeed)}</span>
                  </div>
                  <input
                    type="range"
                    min={0.1}
                    max={3}
                    step={0.05}
                    value={playbackSpeed}
                    disabled={!asset || isExporting}
                    onChange={(event) => setPlaybackSpeed(clampSpeed(Number(event.target.value)))}
                    className="w-full accent-cyan-300"
                  />
                </div>

                <div className="mt-4 space-y-2">
                  <div className="flex items-center justify-between text-sm text-slate-300">
                    <span>Масштаб в превью</span>
                    <span className="text-white">{formatZoomLabel(previewZoom)}</span>
                  </div>
                  <input
                    type="range"
                    min={0.2}
                    max={3}
                    step={0.05}
                    value={previewZoom}
                    disabled={!asset || isExporting}
                    onChange={(event) => setPreviewZoom(clampZoom(Number(event.target.value)))}
                    className="w-full accent-cyan-300"
                  />
                </div>

                <div className="mt-4 text-sm text-slate-300">
                  <p>
                    Время: <span className="text-white">{formatDuration(currentTime)}</span> / <span className="text-white">{formatDuration(animationDuration)}</span>
                  </p>
                </div>
              </section>

              <section className="border-b border-white/10 px-5 py-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-medium text-white">Список анимаций</h2>
                  <span className="text-xs text-slate-500">{asset?.animations.length ?? 0}</span>
                </div>

                <div className="mt-4 max-h-[320px] overflow-auto border border-white/10 bg-slate-950">
                  {asset?.animations.map((animation) => (
                    <button
                      key={animation.name}
                      type="button"
                      onClick={() => {
                        setSelectedAnimation(animation.name);
                        setCurrentTime(0);
                        setIsPlaying(true);
                        setRestartToken((value) => value + 1);
                      }}
                      className={`flex w-full items-center justify-between border-b border-white/10 px-3 py-2 text-left text-sm transition last:border-b-0 ${
                        selectedAnimation === animation.name ? "bg-cyan-300/10 text-white" : "text-slate-300 hover:bg-white/5"
                      }`}
                    >
                      <span className="truncate pr-4">{animation.name}</span>
                      <span className="text-xs text-slate-500">{formatDuration(animation.duration)}</span>
                    </button>
                  ))}

                  {!asset && <p className="px-3 py-3 text-sm leading-6 text-slate-400">Сначала загрузите файлы.</p>}
                </div>
              </section>

              <section className="px-5 py-4">
                <h2 className="text-sm font-medium text-white">Экспорт PNG</h2>

                <label className="mt-4 block text-sm text-slate-300">
                  <span>FPS</span>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={exportFps}
                    disabled={!asset || isExporting}
                    onChange={(event) => setExportFps(clampFps(Number(event.target.value)))}
                    className="mt-2 w-full border border-white/10 bg-slate-950 px-3 py-2 text-white outline-none focus:border-cyan-300/50"
                  />
                </label>

                <button
                  type="button"
                  disabled={!asset || !selectedAnimation || isExporting}
                  onClick={() => void onExportFrames()}
                  className="mt-4 w-full border border-cyan-300/30 bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:bg-cyan-300/30 disabled:text-slate-600"
                >
                  {isExporting ? `Экспорт ${progressPercent}%` : "Экспортировать PNG sequence"}
                </button>

                <div className="mt-3 h-2 bg-white/10">
                  <div className="h-2 bg-cyan-300 transition-[width] duration-200" style={{ width: `${progressPercent}%` }} />
                </div>

                <p className="mt-3 text-sm leading-6 text-slate-400">На выходе будет ZIP-архив с отдельными PNG-кадрами и прозрачным фоном.</p>
              </section>
            </div>
          </aside>

          <main className="border border-white/10 bg-slate-900">
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Превью</p>
                <p className="mt-1 text-sm text-slate-300">
                  {selectedAnimation ? `${selectedAnimation} · ${formatDuration(animationDuration)}` : "Пока ничего не загружено"}
                </p>
              </div>
              <div className="text-right text-xs text-slate-500">
                <p>Фон прозрачный</p>
                <p className="mt-1">Масштаб: {formatZoomLabel(previewZoom)}</p>
              </div>
            </div>

            <div className="h-[70vh] min-h-[520px] bg-[linear-gradient(45deg,rgba(255,255,255,0.04)_25%,transparent_25%,transparent_75%,rgba(255,255,255,0.04)_75%,rgba(255,255,255,0.04)),linear-gradient(45deg,rgba(255,255,255,0.04)_25%,transparent_25%,transparent_75%,rgba(255,255,255,0.04)_75%,rgba(255,255,255,0.04))] bg-[length:32px_32px] bg-[position:0_0,16px_16px] lg:h-[calc(100vh-3rem)] lg:min-h-[760px]">
              {asset ? (
                <SpinePreview
                  asset={asset}
                  animationName={selectedAnimation}
                  isLooping={isLooping}
                  isPlaying={isPlaying && !isExporting}
                  playbackSpeed={playbackSpeed}
                  zoom={previewZoom}
                  restartToken={restartToken}
                  onTimeChange={setCurrentTime}
                  onPlaybackFinished={handlePreviewFinished}
                  onError={handlePreviewError}
                />
              ) : (
                <div className="flex h-full items-center justify-center px-6 text-center text-sm leading-6 text-slate-400">
                  Загрузите ваши Spine-файлы слева. После этого здесь появится большая область предпросмотра.
                </div>
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

export function App() {
  return (
    <AppErrorBoundary>
      <SpineStudioApp />
    </AppErrorBoundary>
  );
}