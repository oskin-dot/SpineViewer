import { BaseTexture } from "pixi.js";
import { Spine, TextureAtlas } from "pixi-spine";
import * as spine37 from "@pixi-spine/runtime-3.7";
import * as spine38 from "@pixi-spine/runtime-3.8";
import * as spine40 from "@pixi-spine/runtime-4.0";
import * as spine41 from "@pixi-spine/runtime-4.1";

export type SpineRuntimeKey = "3.7" | "3.8" | "4.0" | "4.1";

export interface SpineAnimationSummary {
  name: string;
  duration: number;
}

export interface SpineBundleAnalysis {
  atlasFile: File;
  atlasText: string;
  jsonFile: File;
  jsonData: Record<string, unknown>;
  imageFiles: File[];
  imagePageNames: string[];
  detectedVersion: string;
  runtimeKey: SpineRuntimeKey;
  warnings: string[];
}

export interface LoadedSpineAsset extends SpineBundleAnalysis {
  atlas: TextureAtlas;
  skeletonData: any;
  animations: SpineAnimationSummary[];
  cleanup: () => void;
}

interface TextureAtlasResources {
  atlas: TextureAtlas;
  cleanup: () => void;
}

type RuntimeModule = {
  AtlasAttachmentLoader: new (atlas: TextureAtlas) => any;
  SkeletonJson: new (attachmentLoader: any) => {
    readSkeletonData: (json: Record<string, unknown>) => any;
    scale: number;
  };
};

const RUNTIME_BY_KEY: Record<SpineRuntimeKey, RuntimeModule> = {
  "3.7": spine37,
  "3.8": spine38,
  "4.0": spine40,
  "4.1": spine41,
};

const IMAGE_EXTENSION_RE = /\.(png|webp)$/i;
const JSON_EXTENSION_RE = /\.json$/i;
const ATLAS_EXTENSION_RE = /\.(atlas|txt)$/i;

function normalizeName(value: string) {
  return value.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? value.toLowerCase();
}

function stripExtension(value: string) {
  return value.replace(/\.[^.]+$/, "");
}

function resolveRuntimeKey(version: string) {
  const warnings: string[] = [];
  const shortVersion = version.trim().slice(0, 3);
  const numericVersion = Number.parseFloat(shortVersion || "0");

  if (shortVersion === "3.7") {
    return { runtimeKey: "3.7" as const, warnings };
  }

  if (shortVersion === "3.8") {
    return { runtimeKey: "3.8" as const, warnings };
  }

  if (shortVersion === "4.0") {
    return { runtimeKey: "4.0" as const, warnings };
  }

  if (shortVersion === "4.1") {
    return { runtimeKey: "4.1" as const, warnings };
  }

  if (numericVersion > 4.1 && numericVersion < 5) {
    warnings.push(
      `Обнаружена версия Spine ${version}. Для нее включен экспериментальный fallback на runtime 4.1.`
    );

    return { runtimeKey: "4.1" as const, warnings };
  }

  if (numericVersion > 0 && numericVersion < 3.7) {
    warnings.push(
      `Обнаружена версия Spine ${version}. Для нее включен legacy fallback на runtime 3.7.`
    );

    return { runtimeKey: "3.7" as const, warnings };
  }

  throw new Error(
    `Не удалось подобрать runtime для Spine ${version || "unknown"}. Поддерживаются 3.7, 3.8, 4.0 и 4.1, для части новых версий включен fallback.`
  );
}

export function formatRuntimeLabel(runtimeKey: SpineRuntimeKey) {
  return `spine-ts ${runtimeKey}`;
}

export function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0.00s";
  }

  return `${seconds.toFixed(2)}s`;
}

export async function analyzeSpineFiles(files: File[]) {
  const atlasCandidates = files.filter((file) => ATLAS_EXTENSION_RE.test(file.name));
  const jsonCandidates = files.filter((file) => JSON_EXTENSION_RE.test(file.name));
  const imageFiles = files.filter((file) => IMAGE_EXTENSION_RE.test(file.name));

  if (!atlasCandidates.length) {
    throw new Error("Не найден atlas-файл. Загрузите .atlas или .txt.");
  }

  if (!jsonCandidates.length) {
    throw new Error("Не найден skeleton json. Загрузите .json файл из Spine экспорта.");
  }

  if (!imageFiles.length) {
    throw new Error("Не найдены текстуры. Загрузите .png или .webp страницы атласа.");
  }

  const atlasFile = atlasCandidates[0];
  const jsonFile = jsonCandidates[0];
  const atlasText = await atlasFile.text();
  const rawJson = await jsonFile.text();

  let jsonData: Record<string, unknown>;

  try {
    jsonData = JSON.parse(rawJson) as Record<string, unknown>;
  } catch {
    throw new Error(`Файл ${jsonFile.name} не является корректным JSON.`);
  }

  const skeletonMeta = jsonData.skeleton as { spine?: string; version?: string } | undefined;
  const detectedVersion = skeletonMeta?.spine || skeletonMeta?.version || "unknown";
  const imagePageNames = parseAtlasPageNames(atlasText);
  const { runtimeKey, warnings } = resolveRuntimeKey(detectedVersion);

  return {
    atlasFile,
    atlasText,
    jsonFile,
    jsonData,
    imageFiles,
    imagePageNames,
    detectedVersion,
    runtimeKey,
    warnings,
  } satisfies SpineBundleAnalysis;
}

export async function loadSpineAsset(analysis: SpineBundleAnalysis) {
  const atlasResources = await createTextureAtlas(analysis.atlasText, analysis.imageFiles);
  const { atlas } = atlasResources;
  const runtime = RUNTIME_BY_KEY[analysis.runtimeKey];
  const attachmentLoader = new runtime.AtlasAttachmentLoader(atlas);
  const parser = new runtime.SkeletonJson(attachmentLoader);
  let skeletonData: any;

  try {
    skeletonData = parser.readSkeletonData(analysis.jsonData);
  } catch (error) {
    atlas.dispose();
    atlasResources.cleanup();
    const message = error instanceof Error ? error.message : "Не удалось прочитать skeleton json.";
    throw new Error(`Ошибка чтения Spine json: ${message}`);
  }

  if (analysis.runtimeKey === "4.1" && !String(skeletonData.version || "").startsWith("4.1")) {
    skeletonData.version = `4.1-fallback-from-${analysis.detectedVersion}`;
  }

  if (analysis.runtimeKey === "3.7" && !String(skeletonData.version || "").startsWith("3.7")) {
    skeletonData.version = `3.7-fallback-from-${analysis.detectedVersion}`;
  }

  const animations = Array.isArray(skeletonData.animations)
    ? skeletonData.animations.map((animation: { name: string; duration: number }) => ({
        name: animation.name,
        duration: animation.duration,
      }))
    : [];

  return {
    ...analysis,
    atlas,
    skeletonData,
    animations,
    cleanup: () => {
      atlas.dispose();
      atlasResources.cleanup();
    },
  } satisfies LoadedSpineAsset;
}

export function createSpineInstance(
  skeletonData: any,
  options: {
    autoUpdate?: boolean;
  } = {}
) {
  const spine = new Spine(skeletonData);
  spine.autoUpdate = options.autoUpdate ?? false;
  if (spine.state?.data) {
    spine.state.data.defaultMix = 0;
  }
  spine.state.clearTracks();
  spine.skeleton.setToSetupPose();
  spine.update(0);

  return spine;
}

export function parseAtlasPageNames(atlasText: string) {
  const lines = atlasText.split(/\r\n|\r|\n/);
  const pages: string[] = [];
  let waitingForPage = true;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      waitingForPage = true;
      continue;
    }

    if (waitingForPage && !trimmed.includes(":")) {
      pages.push(trimmed);
      waitingForPage = false;
    }
  }

  return pages;
}

export function getAnimationDuration(animations: SpineAnimationSummary[], animationName: string) {
  return animations.find((animation) => animation.name === animationName)?.duration ?? 0;
}

export function startSpineAnimation(spine: Spine, animationName: string, loop: boolean) {
  spine.state.clearTracks();
  spine.skeleton.setToSetupPose();
  const entry = spine.state.setAnimation(0, animationName, loop) as any;
  if (entry && typeof entry.mixDuration === "number") {
    entry.mixDuration = 0;
  }
  spine.update(0);
}

export function advanceSpineAnimation(spine: Spine, deltaSeconds: number) {
  spine.update(Math.max(0, deltaSeconds));
}

export function setSpineAnimationTime(spine: Spine, animationName: string, timeInSeconds: number, loop: boolean) {
  const safeTime = Math.max(0, timeInSeconds);
  const animation = spine.spineData?.findAnimation?.(animationName) ?? null;
  const duration = Number(animation?.duration ?? 0);
  const normalizedTime = !Number.isFinite(duration) || duration <= 0
    ? safeTime
    : loop
      ? ((safeTime % duration) + duration) % duration
      : Math.min(safeTime, duration);

  startSpineAnimation(spine, animationName, loop);

  if (normalizedTime > 0) {
    spine.update(normalizedTime);
  }
}

export function seekAnimationFrame(spine: Spine, animationName: string, timeInSeconds: number, loop: boolean) {
  setSpineAnimationTime(spine, animationName, timeInSeconds, loop);
}

async function createTextureAtlas(atlasText: string, imageFiles: File[]) {
  const objectUrls = new Map<string, string>();
  const baseTexturePromises = new Map<string, Promise<BaseTexture>>();
  const baseTextures = new Map<string, BaseTexture>();
  let firstError: Error | null = null;

  const resolveImageFile = (atlasPath: string) => {
    const atlasName = normalizeName(atlasPath);
    const atlasNameWithoutExt = stripExtension(atlasName);

    const exactMatch = imageFiles.find((file) => normalizeName(file.name) === atlasName);

    if (exactMatch) {
      return exactMatch;
    }

    const basenameMatch = imageFiles.find((file) => stripExtension(normalizeName(file.name)) === atlasNameWithoutExt);

    if (basenameMatch) {
      return basenameMatch;
    }

    if (imageFiles.length === 1) {
      return imageFiles[0];
    }

    return null;
  };

  const cleanupObjectUrls = () => {
    for (const url of objectUrls.values()) {
      URL.revokeObjectURL(url);
    }
  };

  const cleanupBaseTextures = () => {
    for (const texture of baseTextures.values()) {
      texture.destroy();
    }
  };

  const atlas = await new Promise<TextureAtlas>((resolve, reject) => {
    new TextureAtlas(
      atlasText,
      (path, callback) => {
        const imageFile = resolveImageFile(path);

        if (!imageFile) {
          firstError = new Error(`Не удалось найти текстуру для atlas page ${path}.`);
          callback(null as never);
          return;
        }

        const cacheKey = imageFile.name;

        if (!objectUrls.has(cacheKey)) {
          objectUrls.set(cacheKey, URL.createObjectURL(imageFile));
        }

        if (!baseTexturePromises.has(cacheKey)) {
          const url = objectUrls.get(cacheKey)!;

          baseTexturePromises.set(
            cacheKey,
            new Promise<BaseTexture>((resolveTexture, rejectTexture) => {
              const baseTexture = BaseTexture.from(url);
              baseTextures.set(cacheKey, baseTexture);

              if (baseTexture.valid) {
                resolveTexture(baseTexture);
                return;
              }

              baseTexture.once("loaded", () => resolveTexture(baseTexture));
              baseTexture.once("error", () => rejectTexture(new Error(`Не удалось загрузить ${imageFile.name}.`)));
            })
          );
        }

        void baseTexturePromises
          .get(cacheKey)!
          .then((baseTexture) => callback(baseTexture))
          .catch((error: Error) => {
            firstError = error;
            callback(null as never);
          });
      },
      (loadedAtlas) => {
        if (!loadedAtlas) {
          reject(firstError ?? new Error("Не удалось собрать atlas из загруженных файлов."));
          return;
        }

        resolve(loadedAtlas);
      }
    );
  });

  return {
    atlas,
    cleanup: () => {
      cleanupBaseTextures();
      cleanupObjectUrls();
    },
  } satisfies TextureAtlasResources;
}