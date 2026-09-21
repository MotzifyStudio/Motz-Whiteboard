import {
  AlignCenter,
  Archive,
  ArrowDownUp,
  BadgeInfo,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  CircleDot,
  Clipboard,
  Clock3,
  Folder,
  FolderOpen,
  FolderPlus,
  Film,
  FileUp,
  HardDrive,
  Images,
  Link2,
  LibraryBig,
  Maximize2,
  MessageSquareText,
  Minus,
  MousePointer2,
  PanelRight,
  Pencil,
  PictureInPicture2,
  Pin,
  PinOff,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
  Sparkles,
  Square,
  Star,
  Tag,
  Tags,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import pauseIconSvg from "../暂停.svg?raw";
import playIconSvg from "../播放.svg?raw";

const initialAssets = [];

const initialFolders = [];

const initialBoards = [];

const boardTones = ["blue", "violet", "green", "amber"];

const initialBoardItems = {};
const defaultLibraryId = "library-default";
const initialLibraries = [{ id: defaultLibraryId, name: "默认库", root: "", importMode: "copy" }];
const storedStateWriteDelay = 320;
const boardHistoryLimit = 80;
const initialAssetRenderLimit = 64;
const assetRenderBatchSize = 48;
const pendingColorAnalysisAssetIds = new Set();
const deferredMediaCallbacks = new WeakMap();
let deferredMediaObserver = null;
const boardMediaVisibilityCallbacks = new WeakMap();
const boardMediaPreviewCache = new Map();
const boardMediaPreviewSubscribers = new Map();
const pendingBoardMediaPreviews = new Map();
let boardMediaVisibilityObserver = null;
let boardMediaPreviewTimer = 0;
let boardMediaPreviewRequestActive = false;
let installedNoteFontOptionsCache = null;
let installedNoteFontOptionsRequest = null;

const collections = [
  { id: "all", label: "全部素材", icon: LibraryBig },
  { id: "images", label: "图片", icon: Images },
  { id: "videos", label: "视频", icon: Film },
  { id: "unsorted", label: "未分类", icon: Archive },
  { id: "untagged", label: "未标签", icon: Tag },
  { id: "board-assets", label: "白板素材", icon: Clipboard },
  { id: "sent", label: "已上白板", icon: Send },
  { id: "recent", label: "最近收集", icon: Clock3 },
  { id: "trash", label: "垃圾桶", icon: Trash2 },
];

const colorFilters = [
  { id: "red", label: "红", color: "#d95c62" },
  { id: "orange", label: "橙", color: "#d99046" },
  { id: "yellow", label: "黄", color: "#d6bc48" },
  { id: "green", label: "绿", color: "#65a873" },
  { id: "cyan", label: "青", color: "#54aeb4" },
  { id: "blue", label: "蓝", color: "#5d8fe8" },
  { id: "purple", label: "紫", color: "#9a7be6" },
  { id: "pink", label: "粉", color: "#d579a5" },
  { id: "black", label: "黑", color: "#232626" },
  { id: "white", label: "白", color: "#dfe4e1" },
  { id: "gray", label: "灰", color: "#828986" },
];

function classNames(...items) {
  return items.filter(Boolean).join(" ");
}

function bringBoardItemToFront(items, itemId) {
  const itemIndex = items.findIndex((item) => item.id === itemId);
  if (itemIndex < 0 || itemIndex === items.length - 1) return items;
  const nextItems = items.slice();
  const [frontItem] = nextItems.splice(itemIndex, 1);
  nextItems.push(frontItem);
  return nextItems;
}

function readParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function readStoredValue(key, initialValue) {
  try {
    const stored = window.localStorage.getItem(key);
    if (stored) return JSON.parse(stored);
  } catch {
    // Keep the app usable if localStorage is blocked or contains malformed data.
  }
  return typeof initialValue === "function" ? initialValue() : initialValue;
}

function useStoredState(key, initialValue) {
  const initialValueRef = useRef(initialValue);
  const [state, setState] = useState(() => ({ key, value: readStoredValue(key, initialValue) }));
  const value = state.key === key ? state.value : readStoredValue(key, initialValue);

  useEffect(() => {
    if (state.key !== key) setState({ key, value: readStoredValue(key, initialValueRef.current) });
  }, [key, state.key]);

  useEffect(() => {
    const writeValue = () => {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // Local storage can be unavailable in restricted shells. The app still works in-memory.
      }
    };

    let idleHandle = 0;
    const timeout = window.setTimeout(() => {
      if (typeof window.requestIdleCallback === "function") {
        idleHandle = window.requestIdleCallback(writeValue, { timeout: 720 });
      } else {
        writeValue();
      }
    }, storedStateWriteDelay);
    const cancelScheduledWrite = () => {
      window.clearTimeout(timeout);
      if (idleHandle && typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idleHandle);
    };
    const flushBeforeUnload = () => {
      cancelScheduledWrite();
      writeValue();
    };

    window.addEventListener("beforeunload", flushBeforeUnload);
    return () => {
      cancelScheduledWrite();
      window.removeEventListener("beforeunload", flushBeforeUnload);
    };
  }, [key, value]);

  useEffect(() => {
    const syncFromStorage = (event) => {
      if (event.key !== key || !event.newValue) return;
      try {
        const nextValue = JSON.parse(event.newValue);
        setState((current) => {
          if (current.key === key && JSON.stringify(current.value) === event.newValue) return current;
          return { key, value: nextValue };
        });
      } catch {
        // Ignore malformed external updates.
      }
    };

    window.addEventListener("storage", syncFromStorage);
    return () => window.removeEventListener("storage", syncFromStorage);
  }, [key]);

  const setStoredValue = useCallback((updater) => {
    setState((current) => {
      const baseValue = current.key === key ? current.value : readStoredValue(key, initialValueRef.current);
      const nextValue = typeof updater === "function" ? updater(baseValue) : updater;
      if (current.key === key && Object.is(nextValue, baseValue)) return current;
      return {
        key,
        value: nextValue,
      };
    });
  }, [key]);

  return [value, setStoredValue];
}

function cloneBoardHistoryItems(items) {
  const source = Array.isArray(items) ? items : [];
  if (typeof structuredClone === "function") return structuredClone(source);
  return JSON.parse(JSON.stringify(source));
}

function boardHistoryItemsMatch(left, right) {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function useBoardHistory(boardItems, setBoardItems, scopeKey) {
  const boardItemsRef = useRef(boardItems);
  const pastByBoardRef = useRef(new Map());
  const futureByBoardRef = useRef(new Map());

  useEffect(() => {
    boardItemsRef.current = boardItems;
  }, [boardItems]);

  useEffect(() => {
    pastByBoardRef.current.clear();
    futureByBoardRef.current.clear();
  }, [scopeKey]);

  const checkpointBoardItems = useCallback((boardId) => {
    if (!boardId) return;
    const snapshot = cloneBoardHistoryItems(boardItemsRef.current?.[boardId]);
    const past = pastByBoardRef.current.get(boardId) ?? [];
    if (!boardHistoryItemsMatch(past[past.length - 1], snapshot)) {
      past.push(snapshot);
      if (past.length > boardHistoryLimit) past.splice(0, past.length - boardHistoryLimit);
      pastByBoardRef.current.set(boardId, past);
    }
    futureByBoardRef.current.delete(boardId);
  }, []);

  const restoreBoardItems = useCallback(
    (boardId, direction) => {
      if (!boardId) return false;
      const sourceMap = direction === "undo" ? pastByBoardRef.current : futureByBoardRef.current;
      const targetMap = direction === "undo" ? futureByBoardRef.current : pastByBoardRef.current;
      const source = sourceMap.get(boardId) ?? [];
      const currentItems = cloneBoardHistoryItems(boardItemsRef.current?.[boardId]);
      let restoredItems = null;

      while (source.length > 0 && !restoredItems) {
        const candidate = source.pop();
        if (!boardHistoryItemsMatch(candidate, currentItems)) restoredItems = candidate;
      }
      sourceMap.set(boardId, source);
      if (!restoredItems) return false;

      const target = targetMap.get(boardId) ?? [];
      target.push(currentItems);
      if (target.length > boardHistoryLimit) target.splice(0, target.length - boardHistoryLimit);
      targetMap.set(boardId, target);

      setBoardItems((current) => {
        const next = { ...current, [boardId]: cloneBoardHistoryItems(restoredItems) };
        boardItemsRef.current = next;
        return next;
      });
      return true;
    },
    [setBoardItems],
  );

  const undoBoardItems = useCallback((boardId) => restoreBoardItems(boardId, "undo"), [restoreBoardItems]);
  const redoBoardItems = useCallback((boardId) => restoreBoardItems(boardId, "redo"), [restoreBoardItems]);

  return { checkpointBoardItems, undoBoardItems, redoBoardItems };
}

function uniqueTags(assets) {
  return Array.from(new Set(assets.flatMap((asset) => asset.tags))).slice(0, 18);
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
}

function rgbToHsl(r, g, b) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  let hue = 0;
  let saturation = 0;
  const lightness = (max + min) / 2;

  if (max !== min) {
    const delta = max - min;
    saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0);
    if (max === green) hue = (blue - red) / delta + 2;
    if (max === blue) hue = (red - green) / delta + 4;
    hue *= 60;
  }

  return { hue, saturation, lightness };
}

function colorGroupFromRgb(r, g, b) {
  const { hue, saturation, lightness } = rgbToHsl(r, g, b);
  if (lightness < 0.11 || (lightness < 0.2 && saturation < 0.35)) return "black";
  if (lightness > 0.9 && saturation < 0.22) return "white";
  if (saturation < 0.14) return "gray";
  if (hue < 14 || hue >= 345) return "red";
  if (hue < 42) return "orange";
  if (hue < 72) return "yellow";
  if (hue < 160) return "green";
  if (hue < 200) return "cyan";
  if (hue < 255) return "blue";
  if (hue < 292) return "purple";
  if (hue < 345) return "pink";
  return "gray";
}

function colorFilterById(id) {
  return colorFilters.find((filter) => filter.id === id);
}

function isNeutralColorGroup(group) {
  return group === "black" || group === "white" || group === "gray";
}

function colorGroupsForAsset(asset) {
  if (Array.isArray(asset?.colorGroups) && asset.colorGroups.length > 0) return asset.colorGroups;
  if (Array.isArray(asset?.colorPalette) && asset.colorPalette.length > 0) return asset.colorPalette.map((entry) => entry.group).filter(Boolean);
  return asset?.colorGroup ? [asset.colorGroup] : [];
}

function assetMatchesColorFilter(asset, filterId) {
  if (filterId === "all") return true;
  return colorGroupsForAsset(asset).includes(filterId);
}

function colorPaletteForAsset(asset) {
  if (Array.isArray(asset?.colorPalette) && asset.colorPalette.length > 0) return asset.colorPalette;
  if (!asset?.colorGroup || !asset?.dominantColor) return [];
  return [{ group: asset.colorGroup, color: asset.dominantColor, ratio: 1 }];
}

function analyzeImageColor(imageElement) {
  if (!imageElement?.naturalWidth || !imageElement?.naturalHeight) return null;
  try {
    const canvas = document.createElement("canvas");
    const maxSize = 72;
    const imageScale = Math.min(maxSize / imageElement.naturalWidth, maxSize / imageElement.naturalHeight, 1);
    canvas.width = Math.max(1, Math.round(imageElement.naturalWidth * imageScale));
    canvas.height = Math.max(1, Math.round(imageElement.naturalHeight * imageScale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(imageElement, 0, 0, canvas.width, canvas.height);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const statsByGroup = new Map();
    let totalWeight = 0;

    for (let index = 0; index < data.length; index += 4) {
      const alpha = data[index + 3];
      if (alpha < 180) continue;
      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];
      const group = colorGroupFromRgb(red, green, blue);
      const { saturation, lightness } = rgbToHsl(red, green, blue);
      const weight = (isNeutralColorGroup(group) ? 0.72 : 1 + saturation * 0.9) * (0.86 + Math.abs(lightness - 0.5) * 0.18);
      const stat = statsByGroup.get(group) ?? { red: 0, green: 0, blue: 0, weight: 0, count: 0 };
      stat.red += red * weight;
      stat.green += green * weight;
      stat.blue += blue * weight;
      stat.weight += weight;
      stat.count += 1;
      totalWeight += weight;
      statsByGroup.set(group, stat);
    }

    if (totalWeight <= 0) return null;
    const palette = Array.from(statsByGroup.entries())
      .map(([group, stat]) => ({
        group,
        label: colorFilterById(group)?.label || group,
        color: rgbToHex(Math.round(stat.red / stat.weight), Math.round(stat.green / stat.weight), Math.round(stat.blue / stat.weight)),
        ratio: Number((stat.weight / totalWeight).toFixed(3)),
        score: (stat.weight / totalWeight) * (isNeutralColorGroup(group) ? 0.78 : 1.22),
      }))
      .sort((a, b) => b.ratio - a.ratio);

    const dominantEntry = [...palette].sort((a, b) => b.score - a.score)[0];
    if (!dominantEntry) return null;
    const colorGroups = palette
      .filter((entry, index) => entry.ratio >= (isNeutralColorGroup(entry.group) ? 0.14 : 0.065) || index === 0)
      .map((entry) => entry.group);

    return {
      colorGroup: dominantEntry.group,
      dominantColor: dominantEntry.color,
      colorGroups: Array.from(new Set(colorGroups)),
      colorPalette: palette.slice(0, 6).map(({ score, ...entry }) => entry),
    };
  } catch {
    return null;
  }
}

function sanitizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeFolderPath(value) {
  return String(value || "")
    .split("/")
    .flatMap((part) => String(part).split(" / "))
    .map((part) => sanitizeName(part))
    .filter(Boolean)
    .join(" / ");
}

function folderLeafName(folder) {
  const parts = normalizeFolderPath(folder).split(" / ").filter(Boolean);
  return parts.at(-1) ?? "";
}

function folderDepth(folder) {
  return Math.max(0, normalizeFolderPath(folder).split(" / ").filter(Boolean).length - 1);
}

function folderAncestors(folder) {
  const parts = normalizeFolderPath(folder).split(" / ").filter(Boolean);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join(" / "));
}

function childFolderPath(parentFolder, childName) {
  const parent = normalizeFolderPath(parentFolder);
  const child = sanitizeName(childName);
  return parent ? `${parent} / ${child}` : child;
}

function folderContainsAsset(folder, assetFolder) {
  const parent = normalizeFolderPath(folder);
  const child = normalizeFolderPath(assetFolder);
  return Boolean(parent && (child === parent || child.startsWith(`${parent} / `)));
}

function sortFoldersByHierarchy(folders) {
  return Array.from(new Set(folders.map(normalizeFolderPath).filter(Boolean))).sort((a, b) => {
    const left = a.split(" / ");
    const right = b.split(" / ");
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      if (left[index] === undefined) return -1;
      if (right[index] === undefined) return 1;
      const compare = left[index].localeCompare(right[index], "zh-Hans-CN");
      if (compare !== 0) return compare;
    }
    return 0;
  });
}

function isTextEditingTarget(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true']"));
}

const imageFileExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif", ".tif", ".tiff"];
const videoFileExtensions = [".mp4", ".mov", ".qt", ".m4v", ".webm", ".mkv", ".avi", ".wmv", ".flv", ".mpeg", ".mpg", ".3gp", ".3g2", ".ts", ".mts", ".ogv", ".ogm"];
const floatingRevealZoneHeight = 42;
const floatingHideZoneHeight = 86;
const minBoardZoom = 0.02;
const maxBoardZoom = 32;
const defaultBoardZoom = 0.86;
const noteColorOptions = [
  "#dfe7e3",
  "#f2d36b",
  "#78d5a9",
  "#7db7ff",
  "#d99bf0",
  "#ff9d8b",
];
const noteFontOptions = [
  { label: "默认", value: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif' },
  { label: "黑体", value: '"Microsoft YaHei", "SimHei", sans-serif' },
  { label: "宋体", value: '"Noto Serif CJK SC", "Source Han Serif SC", "SimSun", serif' },
  { label: "楷体", value: '"KaiTi", "STKaiti", serif' },
  { label: "等宽", value: '"Cascadia Mono", "Consolas", monospace' },
];
const defaultNoteFont = noteFontOptions[0].value;
const resizeHandleNames = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const textNodeLineHeight = 1.2;
const textNodeOuterInset = 6;
const boardClipboardMime = "application/x-motz-board-items";
const boardClipboardPrefix = "MOTZ_BOARD_ITEMS:";

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function normalizeDropUrl(value, baseUrl = "") {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return "";

  try {
    if (raw.startsWith("//")) return new URL(`https:${raw}`).toString();
    return new URL(raw, baseUrl || window.location.href).toString();
  } catch {
    return isHttpUrl(raw) ? raw : "";
  }
}

function looksLikeImageUrl(value) {
  try {
    const url = new URL(value);
    return imageFileExtensions.some((ext) => url.pathname.toLowerCase().endsWith(ext));
  } catch {
    return false;
  }
}

function looksLikeVideoUrl(value) {
  try {
    const url = new URL(value);
    return videoFileExtensions.some((ext) => url.pathname.toLowerCase().endsWith(ext));
  } catch {
    return false;
  }
}

function extensionFromName(value) {
  const clean = String(value || "").toLowerCase().split(/[?#]/)[0];
  const dotIndex = clean.lastIndexOf(".");
  return dotIndex >= 0 ? clean.slice(dotIndex) : "";
}

function isImageFileLike(file) {
  if (file?.type?.startsWith("image/")) return true;
  return imageFileExtensions.includes(extensionFromName(file?.name));
}

function isVideoFileLike(file) {
  if (file?.type?.startsWith("video/")) return true;
  return videoFileExtensions.includes(extensionFromName(file?.name));
}

function isMediaFileLike(file) {
  return isImageFileLike(file) || isVideoFileLike(file);
}

function localPathFromFile(file) {
  try {
    return window.referenceBoard?.getFilePath?.(file) || file?.path || "";
  } catch {
    return file?.path || "";
  }
}

function normalizePathKey(value) {
  let text = String(value || "").trim();
  if (!text || text.startsWith("blob:") || text.startsWith("data:") || isHttpUrl(text)) return "";
  if (/^file:\/\//i.test(text)) {
    try {
      text = decodeURIComponent(text.replace(/^file:\/\/\/?/i, ""));
      if (/^[a-zA-Z]\//.test(text)) text = `${text[0]}:${text.slice(1)}`;
    } catch {
      return "";
    }
  }
  return text.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

function assetPathKeys(asset) {
  return [asset?.source, asset?.mediaUrl, asset?.image, asset?.originalSource].map(normalizePathKey).filter(Boolean);
}

function assetIdsFromDroppedFiles(files, assets) {
  const droppedPaths = new Set(
    Array.from(files ?? [])
      .map(localPathFromFile)
      .map(normalizePathKey)
      .filter(Boolean),
  );
  if (droppedPaths.size === 0) return [];
  return assets
    .filter((asset) => assetPathKeys(asset).some((pathKey) => droppedPaths.has(pathKey)))
    .map((asset) => asset.id);
}

function basenameWithoutExtension(value) {
  let text = String(value || "").trim().split(/[?#]/)[0];
  if (/^file:\/\//i.test(text)) {
    try {
      text = decodeURIComponent(text.replace(/^file:\/\/\/?/i, ""));
    } catch {
      return "";
    }
  }
  const fileName = text.split(/[\\/]/).filter(Boolean).pop() || "";
  return fileName.replace(/\.[^.]+$/, "");
}

function formatFileSize(size) {
  const bytes = Number(size);
  if (!(bytes > 0)) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

function parseAssetBytes(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)$/i);
  if (!match) return 0;
  const units = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
  return Number(match[1]) * units[match[2].toUpperCase()];
}

function assetCreatedTimestamp(asset) {
  const value = String(asset?.created || "").trim();
  if (!value || value === "刚刚") return Number.MAX_SAFE_INTEGER;
  const normalized = value.replace(/年|月/g, "/").replace(/日/g, "").replace(/-/g, "/");
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortAssets(items, mode) {
  return items
    .map((asset, index) => ({ asset, index }))
    .sort((leftEntry, rightEntry) => {
      const left = leftEntry.asset;
      const right = rightEntry.asset;
      let result = 0;
      if (mode === "name") result = String(left.title || "").localeCompare(String(right.title || ""), "zh-Hans-CN", { numeric: true });
      if (mode === "oldest") result = assetCreatedTimestamp(left) - assetCreatedTimestamp(right);
      if (mode === "size") result = parseAssetBytes(right.size) - parseAssetBytes(left.size);
      if (mode === "resolution") {
        result = Number(right.pixelWidth || 0) * Number(right.pixelHeight || 0) - Number(left.pixelWidth || 0) * Number(left.pixelHeight || 0);
      }
      if (!mode || mode === "recent") result = assetCreatedTimestamp(right) - assetCreatedTimestamp(left);
      return result || leftEntry.index - rightEntry.index;
    })
    .map((entry) => entry.asset);
}

function hasExistingWorkspace() {
  try {
    return ["reference-board-libraries", "reference-board-assets", "reference-board-folders", "reference-board-boards", "reference-board-items"].some(
      (key) => window.localStorage.getItem(key),
    );
  } catch {
    return false;
  }
}

function createTransientVideoAsset(file, index = 0, folderName = "", metadata = {}, tags = []) {
  const title = (file?.name || `local-video-${Date.now()}-${index}`).replace(/\.[^.]+$/, "");
  const mediaUrl = URL.createObjectURL(file);

  return {
    id: `video-temp-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    size: formatFileSize(file?.size),
    type: metadata.typeLabel || "视频引用",
    image: mediaUrl,
    mediaUrl,
    mediaKind: "video",
    tags: Array.from(new Set(["视频", ...tags])),
    folder: folderName,
    source: file?.name || "local video",
    originalSource: metadata.originalSource || metadata.remoteSource || file?.name || "local video",
    remoteSource: metadata.remoteSource || "",
    note: "临时引用本地视频；桌面版拿到文件路径后会保存为稳定引用。",
    created: "刚刚",
    libraryCopy: false,
  };
}

function isAssetVideo(asset) {
  if (!asset) return false;
  if (asset.mediaKind === "video" || asset.kind === "video") return true;
  if (String(asset.type || "").includes("视频")) return true;
  const source = asset.source || asset.originalSource || asset.remoteSource || asset.image || "";
  return videoFileExtensions.includes(extensionFromName(source));
}

function isAssetTrashed(asset) {
  return Boolean(asset?.trashedAt);
}

function assetLibraryFilePath(asset) {
  const source = String(asset?.source || "").trim();
  return asset?.libraryCopy && source && !/^https?:\/\//i.test(source) ? source : "";
}

function localFilePathKey(filePath) {
  return String(filePath || "").trim().replace(/\//g, "\\").toLowerCase();
}

function isBoardFileAsset(asset) {
  return Boolean(
    asset?.boardFileAsset ||
      asset?.importedFromBoard ||
      asset?.folder === "白板素材" ||
      (Array.isArray(asset?.tags) && asset.tags.includes("白板文件")),
  );
}

function getAssetMediaUrl(asset) {
  return asset?.mediaUrl || asset?.video || asset?.image || "";
}

function observeDeferredMedia(element, onVisible) {
  if (!element || typeof onVisible !== "function" || typeof IntersectionObserver === "undefined") {
    onVisible?.();
    return () => {};
  }

  if (!deferredMediaObserver) {
    deferredMediaObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const callback = deferredMediaCallbacks.get(entry.target);
          deferredMediaCallbacks.delete(entry.target);
          deferredMediaObserver?.unobserve(entry.target);
          callback?.();
        });
      },
      { rootMargin: "520px 0px" },
    );
  }

  deferredMediaCallbacks.set(element, onVisible);
  deferredMediaObserver.observe(element);
  return () => {
    deferredMediaCallbacks.delete(element);
    deferredMediaObserver?.unobserve(element);
  };
}

function isCheckableLocalPath(value) {
  const text = String(value || "").trim();
  if (!text || text === "local import" || text.startsWith("blob:") || text.startsWith("data:")) return false;
  if (isHttpUrl(text)) return false;
  return /^file:\/\//i.test(text) || /^[a-zA-Z]:[\\/]/.test(text) || /^\\\\/.test(text) || /^\//.test(text);
}

function getAssetCheckPath(asset) {
  if (!asset) return "";
  return [asset.source, asset.mediaUrl, asset.image, asset.originalSource].find(isCheckableLocalPath) || "";
}

function observeBoardMediaVisibility(element, callback) {
  if (!element || typeof callback !== "function" || typeof IntersectionObserver === "undefined") {
    callback?.(true);
    return () => {};
  }

  if (!boardMediaVisibilityObserver) {
    boardMediaVisibilityObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => boardMediaVisibilityCallbacks.get(entry.target)?.(entry.isIntersecting));
      },
      { rootMargin: "640px" },
    );
  }

  boardMediaVisibilityCallbacks.set(element, callback);
  boardMediaVisibilityObserver.observe(element);
  return () => {
    boardMediaVisibilityCallbacks.delete(element);
    boardMediaVisibilityObserver?.unobserve(element);
  };
}

function boardMediaPreviewDimension(item, zoom) {
  const deviceScale = Math.min(2, Math.max(1, Number(window.devicePixelRatio) || 1));
  const requested = Math.max(Number(item?.width) || 1, Number(item?.height) || 1) * Math.max(0.01, zoom) * deviceScale * 1.12;
  return [640, 1280, 2048, 3072].find((dimension) => requested <= dimension) || 0;
}

function viewportTransform(offset, zoom) {
  const x = Number.isFinite(Number(offset?.x)) ? Number(offset.x) : 0;
  const y = Number.isFinite(Number(offset?.y)) ? Number(offset.y) : 0;
  const scale = Number.isFinite(Number(zoom)) ? Number(zoom) : 1;
  return `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
}

function startViewportComposite(host) {
  host?.classList.add("viewport-transforming");
}

function settleViewportComposite(host, surface, applyTransform) {
  window.requestAnimationFrame(() => {
    applyTransform?.();
    if (surface) {
      surface.classList.remove("viewport-paint-reset");
      // Reading layout between class changes gives Chromium a clean damage region
      // before the decoded LOD image is swapped into the transformed surface.
      void surface.offsetWidth;
      surface.classList.add("viewport-paint-reset");
    }
    window.requestAnimationFrame(() => {
      surface?.classList.remove("viewport-paint-reset");
      host?.classList.remove("viewport-transforming");
    });
  });
}

function notifyBoardMediaPreview(key, value) {
  const subscribers = boardMediaPreviewSubscribers.get(key);
  boardMediaPreviewSubscribers.delete(key);
  subscribers?.forEach((callback) => callback(value));
}

async function flushBoardMediaPreviewQueue() {
  if (boardMediaPreviewRequestActive || pendingBoardMediaPreviews.size === 0) return;
  const getMediaThumbnails = window.referenceBoard?.getMediaThumbnails;
  if (typeof getMediaThumbnails !== "function") {
    pendingBoardMediaPreviews.forEach((_entry, key) => {
      boardMediaPreviewCache.set(key, "");
      notifyBoardMediaPreview(key, "");
    });
    pendingBoardMediaPreviews.clear();
    return;
  }

  boardMediaPreviewRequestActive = true;
  const batch = Array.from(pendingBoardMediaPreviews.entries()).slice(0, 4);
  batch.forEach(([key]) => pendingBoardMediaPreviews.delete(key));
  try {
    const response = await getMediaThumbnails(
      batch.map(([key, entry]) => ({ id: key, source: entry.source, maxDimension: entry.maxDimension })),
    );
    const resultByKey = new Map((response?.items ?? []).map((entry) => [entry.id, entry.thumbnail || ""]));
    batch.forEach(([key]) => {
      const value = resultByKey.get(key) || "";
      boardMediaPreviewCache.set(key, value);
      notifyBoardMediaPreview(key, value);
    });
  } catch {
    batch.forEach(([key]) => {
      boardMediaPreviewCache.set(key, "");
      notifyBoardMediaPreview(key, "");
    });
  } finally {
    boardMediaPreviewRequestActive = false;
    if (pendingBoardMediaPreviews.size > 0) {
      window.clearTimeout(boardMediaPreviewTimer);
      boardMediaPreviewTimer = window.setTimeout(flushBoardMediaPreviewQueue, 18);
    }
  }
}

function requestBoardMediaPreview(source, maxDimension, callback) {
  const key = `${source}|${maxDimension}`;
  if (boardMediaPreviewCache.has(key)) {
    callback(boardMediaPreviewCache.get(key));
    return () => {};
  }

  const subscribers = boardMediaPreviewSubscribers.get(key) ?? new Set();
  subscribers.add(callback);
  boardMediaPreviewSubscribers.set(key, subscribers);
  pendingBoardMediaPreviews.set(key, { source, maxDimension });
  window.clearTimeout(boardMediaPreviewTimer);
  boardMediaPreviewTimer = window.setTimeout(flushBoardMediaPreviewQueue, 0);
  return () => {
    const current = boardMediaPreviewSubscribers.get(key);
    current?.delete(callback);
    if (current?.size === 0) boardMediaPreviewSubscribers.delete(key);
  };
}

function videoMimeTypeFromSource(value) {
  const extension = extensionFromName(value);
  const map = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".qt": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".wmv": "video/x-ms-wmv",
    ".ogv": "video/ogg",
    ".ogm": "video/ogg",
    ".mpeg": "video/mpeg",
    ".mpg": "video/mpeg",
    ".3gp": "video/3gpp",
    ".3g2": "video/3gpp2",
  };
  return map[extension] || undefined;
}

// 渲染进程在开发模式下跑在 http 源上、打包后跑在 file 源上，直接引用本地文件会被
// Chromium 的资源安全检查拦掉（Media load rejected by URL safety check），
// 因此统一经主进程的 motz-media 协议换成可用地址。
function useResolvedMediaUrl(requestedSrc) {
  const needsLocalMediaUrl = isCheckableLocalPath(requestedSrc) && typeof window.referenceBoard?.getMediaUrl === "function";
  const [resolvedLocalMediaUrl, setResolvedLocalMediaUrl] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (!needsLocalMediaUrl) {
      setResolvedLocalMediaUrl("");
      return undefined;
    }
    setResolvedLocalMediaUrl("");
    window.referenceBoard
      .getMediaUrl(requestedSrc)
      .then((url) => {
        if (!cancelled) setResolvedLocalMediaUrl(typeof url === "string" ? url : "");
      })
      .catch(() => {
        if (!cancelled) setResolvedLocalMediaUrl("");
      });
    return () => {
      cancelled = true;
    };
  }, [needsLocalMediaUrl, requestedSrc]);

  return needsLocalMediaUrl ? resolvedLocalMediaUrl : requestedSrc;
}

function MediaElement({
  asset,
  alt = "",
  className = "",
  controls = false,
  defer = false,
  mediaUrl = "",
  waitForMediaUrl = false,
  muted = true,
  loop = false,
  preload = "metadata",
  onImageLoad,
  onVideoMetadata,
  onMediaError,
}) {
  const requestedSrc = mediaUrl || getAssetMediaUrl(asset);
  const src = useResolvedMediaUrl(requestedSrc);
  const placeholderRef = useRef(null);
  const canLoad = (!waitForMediaUrl || Boolean(mediaUrl)) && Boolean(src);
  const [shouldLoad, setShouldLoad] = useState(!defer && canLoad);

  useEffect(() => {
    if (!canLoad) return undefined;
    if (!defer) {
      setShouldLoad(true);
      return undefined;
    }
    if (shouldLoad) return undefined;
    return observeDeferredMedia(placeholderRef.current, () => setShouldLoad(true));
  }, [canLoad, defer, shouldLoad, src]);

  if (!canLoad || !shouldLoad) {
    return <span ref={placeholderRef} className={classNames("deferred-media-placeholder", className)} aria-hidden="true" />;
  }

  if (isAssetVideo(asset)) {
    return (
      <video
        key={src}
        src={src}
        className={className || undefined}
        controls={controls}
        muted={muted}
        loop={loop}
        preload={preload}
        playsInline
        draggable="false"
        onLoadedMetadata={onVideoMetadata}
        onError={onMediaError}
      />
    );
  }

  return (
    <img
      key={src}
      className={className || undefined}
      src={src}
      alt={alt}
      draggable="false"
      decoding="async"
      loading={defer ? "lazy" : "eager"}
      fetchPriority={defer ? "low" : "auto"}
      onLoad={onImageLoad}
      onError={onMediaError}
    />
  );
}

function scrubVideoThumbnail(event) {
  const video = event.currentTarget.querySelector("video");
  if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const ratio = clampNumber((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  const nextTime = ratio * video.duration;
  if (Math.abs(video.currentTime - nextTime) > 0.04) {
    video.currentTime = nextTime;
  }
  video.pause?.();
  event.currentTarget.style.setProperty("--video-preview-progress", ratio.toFixed(3));
}

function resetVideoThumbnailScrub(event) {
  const video = event.currentTarget.querySelector("video");
  video?.pause?.();
  event.currentTarget.style.setProperty("--video-preview-progress", "0");
}

function revealVideoFirstFrame(video) {
  const duration = Number(video?.duration);
  if (!video || !(duration > 0) || video.currentTime > 0.02) return;
  window.requestAnimationFrame(() => {
    try {
      video.currentTime = Math.min(0.12, Math.max(0.03, duration / 120));
    } catch {
      // Some video containers do not allow seeking until more data is buffered.
    }
  });
}

function InlineVideoMedia({ asset, alt = "", mediaUrl = "", waitForMediaUrl = false, preload = "metadata", autoPlay = false, onImageLoad, onVideoMetadata, onMediaError }) {
  const videoRef = useRef(null);
  const hideTimerRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.85);
  const [progress, setProgress] = useState(0);
  const src = useResolvedMediaUrl(getAssetMediaUrl(asset));

  useEffect(() => {
    return () => window.clearTimeout(hideTimerRef.current);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = clampNumber(volume, 0, 1);
    video.muted = muted || volume <= 0;
  }, [muted, volume]);

  // 预览场景自动起播；被浏览器策略拦下时保留控制条，用户仍可手动播放。
  useEffect(() => {
    if (!autoPlay) return undefined;
    const video = videoRef.current;
    if (!video) return undefined;
    video.play?.()?.catch?.(() => setControlsVisible(true));
    return undefined;
  }, [autoPlay, src]);

  if (!isAssetVideo(asset)) {
    return (
      <MediaElement
        asset={asset}
        alt={alt}
        mediaUrl={mediaUrl}
        waitForMediaUrl={waitForMediaUrl}
        onImageLoad={onImageLoad}
        onMediaError={onMediaError}
      />
    );
  }

  function clearHideTimer() {
    window.clearTimeout(hideTimerRef.current);
  }

  function scheduleHideControls(delay = 1150, force = false) {
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => {
      if (force || !videoRef.current?.paused) setControlsVisible(false);
    }, delay);
  }

  function updateProgress(video = videoRef.current) {
    const duration = Number(video?.duration);
    const currentTime = Number(video?.currentTime);
    setProgress(duration > 0 && currentTime >= 0 ? clampNumber(currentTime / duration, 0, 1) : 0);
  }

  function seekFromClientX(clientX, trackElement) {
    const video = videoRef.current;
    const duration = Number(video?.duration);
    if (!video || !(duration > 0)) return;
    const rect = trackElement.getBoundingClientRect();
    const ratio = clampNumber((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    video.currentTime = ratio * duration;
    setProgress(ratio);
  }

  function startProgressSeek(event) {
    event.preventDefault();
    event.stopPropagation();
    const trackElement = event.currentTarget;
    setControlsVisible(true);
    clearHideTimer();
    seekFromClientX(event.clientX, trackElement);

    const move = (moveEvent) => {
      moveEvent.preventDefault();
      seekFromClientX(moveEvent.clientX, trackElement);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      if (!videoRef.current?.paused) scheduleHideControls(1250);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
  }

  function handlePlay() {
    setPlaying(true);
    setControlsVisible(true);
    scheduleHideControls(1150);
  }

  function handlePause() {
    setPlaying(false);
    setControlsVisible(true);
    clearHideTimer();
  }

  function toggleVideo(event) {
    event.preventDefault();
    event.stopPropagation();
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play?.().catch?.(() => setControlsVisible(true));
      return;
    }
    video.pause?.();
  }

  function toggleMuted(event) {
    event.preventDefault();
    event.stopPropagation();
    setControlsVisible(true);
    if (muted || volume <= 0) {
      if (volume <= 0) setVolume(0.72);
      setMuted(false);
    } else {
      setMuted(true);
    }
    if (playing) scheduleHideControls(1250);
  }

  function changeVolume(event) {
    event.stopPropagation();
    const nextVolume = clampNumber(Number(event.currentTarget.value), 0, 1);
    setVolume(nextVolume);
    setMuted(nextVolume <= 0);
    setControlsVisible(true);
    if (playing) scheduleHideControls(1250);
  }

  function handleControlHover() {
    setControlsVisible(true);
    if (playing) scheduleHideControls(1400);
  }

  function handleLeave() {
    scheduleHideControls(180, true);
  }

  const silent = muted || volume <= 0;

  return (
    <div
      className={classNames("inline-video-shell", playing && "playing", controlsVisible ? "controls-visible" : "controls-hidden")}
      onMouseEnter={handleControlHover}
      onMouseMove={handleControlHover}
      onMouseLeave={handleLeave}
    >
      {src ? (
        <video
          key={src}
          src={src}
          ref={videoRef}
          muted={silent}
          preload={preload}
          playsInline
          draggable="false"
          onLoadedMetadata={(event) => {
            updateProgress(event.currentTarget);
            revealVideoFirstFrame(event.currentTarget);
            onVideoMetadata?.(event);
          }}
          onLoadedData={(event) => {
            updateProgress(event.currentTarget);
            revealVideoFirstFrame(event.currentTarget);
          }}
          onCanPlay={(event) => updateProgress(event.currentTarget)}
          onTimeUpdate={(event) => updateProgress(event.currentTarget)}
          onPlay={handlePlay}
          onPause={handlePause}
          onEnded={handlePause}
          onError={onMediaError}
        />
      ) : null}
      <button
        type="button"
        className="inline-video-toggle"
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={toggleVideo}
        title="播放 / 暂停视频"
        aria-label="播放 / 暂停视频"
      >
        <span
          className="inline-video-toggle-icon"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: playing ? pauseIconSvg : playIconSvg }}
        />
      </button>
      <div
        className="inline-video-controlbar"
        onPointerEnter={() => {
          setControlsVisible(true);
          clearHideTimer();
        }}
        onPointerLeave={() => {
          if (playing) scheduleHideControls(520);
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="inline-video-volume-group">
          <button type="button" className="inline-video-volume" onClick={toggleMuted} title={silent ? "打开声音" : "静音"} aria-label={silent ? "打开声音" : "静音"}>
            {silent ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
          <input
            className="inline-video-volume-range"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={silent ? 0 : volume}
            onChange={changeVolume}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            aria-label="视频音量"
          />
        </div>
        <div
          className="inline-video-progress"
          role="slider"
          aria-label="视频进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          onPointerDown={startProgressSeek}
        >
          <span style={{ transform: `scaleX(${progress})` }} />
        </div>
      </div>
    </div>
  );
}

function BoardMedia({ asset, item, zoom, alt = "", onImageLoad, onVideoMetadata, onMediaError }) {
  const hostRef = useRef(null);
  const visibilityHideTimerRef = useRef(0);
  const source = getAssetCheckPath(asset);
  const previewDimension = boardMediaPreviewDimension(item, zoom);
  const [visible, setVisible] = useState(false);
  const [previewState, setPreviewState] = useState(() => ({ source: "", dimension: -1, url: "" }));

  useEffect(() => {
    const stopObserving = observeBoardMediaVisibility(hostRef.current, (nextVisible) => {
      window.clearTimeout(visibilityHideTimerRef.current);
      if (nextVisible) {
        setVisible(true);
        return;
      }

      // Keep decoded media mounted briefly while zooming so the compositor does not
      // repeatedly destroy and recreate image layers at the viewport boundary.
      visibilityHideTimerRef.current = window.setTimeout(() => setVisible(false), 720);
    });

    return () => {
      window.clearTimeout(visibilityHideTimerRef.current);
      stopObserving();
    };
  }, []);

  useEffect(() => {
    if (!visible || isAssetVideo(asset) || !source) return undefined;

    const currentQuality = previewState.dimension === 0 ? Number.POSITIVE_INFINITY : previewState.dimension;
    const requestedQuality = previewDimension === 0 ? Number.POSITIVE_INFINITY : previewDimension;
    if (previewState.source === source && previewState.url && currentQuality >= requestedQuality) return undefined;

    let canceled = false;
    let unsubscribe = () => {};
    const installDecodedPreview = async (url, dimension) => {
      const nextUrl = url || getAssetMediaUrl(asset);
      if (!nextUrl) return;
      const image = new window.Image();
      image.src = nextUrl;
      try {
        await image.decode?.();
      } catch {
        // The media element still gets a chance to load formats that do not support decode().
      }
      if (!canceled) setPreviewState({ source, dimension, url: nextUrl });
    };

    if (previewDimension === 0) {
      void installDecodedPreview(getAssetMediaUrl(asset), 0);
    } else {
      unsubscribe = requestBoardMediaPreview(source, previewDimension, (url) => {
        void installDecodedPreview(url, previewDimension);
      });
    }

    return () => {
      canceled = true;
      unsubscribe();
    };
  }, [asset, previewDimension, previewState.dimension, previewState.source, previewState.url, source, visible]);

  const resolvedPreviewUrl = previewState.source === source ? previewState.url : "";
  const waitsForPreview = Boolean(visible && !isAssetVideo(asset) && source && !resolvedPreviewUrl);

  return (
    <span ref={hostRef} className="board-media-host">
      {visible ? (
        <InlineVideoMedia
          asset={asset}
          alt={alt}
          mediaUrl={resolvedPreviewUrl}
          waitForMediaUrl={waitsForPreview}
          onImageLoad={onImageLoad}
          onVideoMetadata={onVideoMetadata}
          onMediaError={onMediaError}
        />
      ) : null}
    </span>
  );
}

function resizeHandleFromTarget(target) {
  const classList = target?.classList;
  if (!classList) return "";
  return resizeHandleNames.find((handle) => classList.contains(handle)) || "";
}

function getClipboardMediaInput(clipboardData) {
  const files = [];
  const seen = new Set();

  const acceptFile = (file) => {
    if (!file || (!isImageFileLike(file) && !isVideoFileLike(file))) return;
    const key = `${file.name}-${file.size}-${file.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push(file);
  };

  Array.from(clipboardData?.files ?? []).forEach(acceptFile);

  Array.from(clipboardData?.items ?? []).forEach((item) => {
    if (item.kind !== "file" || !/^(image|video)\//.test(item.type || "")) return;
    acceptFile(item.getAsFile?.());
  });

  const metadata = {
    ...getDropImportMetadata(clipboardData),
    clipboard: true,
    typeLabel: "剪贴板",
    tags: ["剪贴板"],
    note: "从剪贴板粘贴并复制到软件素材库。",
  };

  return {
    files,
    metadata,
    hasContent: files.length > 0 || metadata.imageUrls.length > 0,
  };
}

function pushUniqueUrl(urls, value, baseUrl = "") {
  const url = normalizeDropUrl(value, baseUrl);
  if (url && isHttpUrl(url) && !urls.includes(url)) urls.push(url);
}

function pushUniqueUrlList(urls, values, baseUrl = "") {
  values.forEach((value) => pushUniqueUrl(urls, value, baseUrl));
}

function extractUrlsFromText(text, urls) {
  const matches = String(text || "").match(/https?:\/\/[^\s"'<>]+/gi) || [];
  matches.forEach((url) => pushUniqueUrl(urls, url));
}

function extractUrlsFromSrcSet(value) {
  return String(value || "")
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function getDropImportMetadata(dataTransfer) {
  const urls = [];
  const imageCandidates = [];
  const videoCandidates = [];
  let htmlPageUrl = "";
  const uriList = dataTransfer?.getData?.("text/uri-list") || "";
  const plainText = (dataTransfer?.getData?.("text/plain") || "").trim();
  const mozUrl = dataTransfer?.getData?.("text/x-moz-url") || "";
  const html = dataTransfer?.getData?.("text/html") || "";

  uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .forEach((line) => pushUniqueUrl(urls, line));
  extractUrlsFromText(plainText, urls);
  extractUrlsFromText(mozUrl, urls);

  if (html) {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const anchor = doc.querySelector("a[href]");
      const href = anchor?.getAttribute("href") || "";
      const pageUrl = normalizeDropUrl(href);

      if (pageUrl) {
        htmlPageUrl = pageUrl;
        pushUniqueUrl(urls, pageUrl);
      }

      doc.querySelectorAll("img, source, picture source").forEach((element) => {
        pushUniqueUrlList(
          imageCandidates,
          [
            element.getAttribute("currentSrc"),
            element.getAttribute("src"),
            element.getAttribute("data-src"),
            element.getAttribute("data-original"),
            element.getAttribute("data-lazy-src"),
            element.getAttribute("data-actualsrc"),
            element.getAttribute("data-image"),
            element.getAttribute("poster"),
            ...extractUrlsFromSrcSet(element.getAttribute("srcset")),
            ...extractUrlsFromSrcSet(element.getAttribute("data-srcset")),
          ],
          pageUrl,
        );
      });

      doc.querySelectorAll("video, source").forEach((element) => {
        pushUniqueUrlList(videoCandidates, [element.getAttribute("src"), element.getAttribute("data-src"), element.getAttribute("poster")], pageUrl);
      });

      doc.querySelectorAll("meta[property='og:image'], meta[name='twitter:image'], meta[property='og:video']").forEach((element) => {
        const content = element.getAttribute("content");
        if (element.getAttribute("property") === "og:video") {
          pushUniqueUrl(videoCandidates, content, pageUrl);
        } else {
          pushUniqueUrl(imageCandidates, content, pageUrl);
        }
      });
    } catch {
      // Some apps provide partial HTML fragments. Raw URL extraction below still catches common cases.
    }
    extractUrlsFromText(html, urls);
  }

  const imageUrls = Array.from(new Set([...imageCandidates, ...urls.filter(looksLikeImageUrl)]));
  const videoUrls = Array.from(new Set([...videoCandidates.filter(looksLikeVideoUrl), ...urls.filter(looksLikeVideoUrl)]));
  const remoteSource = imageUrls[0] || videoUrls[0] || urls[0] || "";
  const originalSource = htmlPageUrl || urls.find((url) => url !== remoteSource && !looksLikeImageUrl(url) && !looksLikeVideoUrl(url)) || remoteSource || "";

  return {
    originalSource,
    remoteSource,
    imageUrls: imageUrls.length > 0 ? imageUrls : remoteSource ? [remoteSource] : [],
    videoUrls,
  };
}

function isExternalMediaDrag(event) {
  const types = Array.from(event.dataTransfer?.types ?? []).map((type) => String(type).toLowerCase());
  return types.includes("files") || types.includes("text/uri-list") || types.includes("text/html") || types.includes("text/plain");
}

function createResizeSnapshot(items) {
  if (items.length === 0) return null;
  const origins = Object.fromEntries(
    items.map((item) => [
      item.id,
      {
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        fontSize: Number(item.fontSize) || 16,
        text: item.text || "",
        fontFamily: item.fontFamily || defaultNoteFont,
        minWidth: 4,
        minHeight: 4,
      },
    ]),
  );
  const left = Math.min(...items.map((item) => item.x));
  const top = Math.min(...items.map((item) => item.y));
  const right = Math.max(...items.map((item) => item.x + item.width));
  const bottom = Math.max(...items.map((item) => item.y + item.height));

  return {
    ids: items.map((item) => item.id),
    origins,
    box: {
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    },
  };
}

function resizeScaleFromSnapshot(snapshot, dx, dy, handle = "se") {
  const touchesWest = handle.includes("w");
  const touchesEast = handle.includes("e");
  const touchesNorth = handle.includes("n");
  const touchesSouth = handle.includes("s");
  const scaleX = touchesWest ? (snapshot.box.width - dx) / snapshot.box.width : touchesEast ? (snapshot.box.width + dx) / snapshot.box.width : 1;
  const scaleY = touchesNorth ? (snapshot.box.height - dy) / snapshot.box.height : touchesSouth ? (snapshot.box.height + dy) / snapshot.box.height : 1;
  const primaryScale = touchesWest || touchesEast ? scaleX : scaleY;
  const isCorner = (touchesWest || touchesEast) && (touchesNorth || touchesSouth);
  const candidateScale = isCorner && Math.abs(scaleY - 1) > Math.abs(scaleX - 1) ? scaleY : primaryScale;
  const minScale = Object.values(snapshot.origins).reduce((minimum, origin) => {
    return Math.max(minimum, origin.minWidth / origin.width, origin.minHeight / origin.height);
  }, 0.002);

  return Math.max(minScale, candidateScale);
}

function resizeAnchorFromHandle(box, handle = "se") {
  return {
    x: handle.includes("w") ? box.x + box.width : handle.includes("e") ? box.x : box.x + box.width / 2,
    y: handle.includes("n") ? box.y + box.height : handle.includes("s") ? box.y : box.y + box.height / 2,
  };
}

function applyResizeSnapshot(item, snapshot, scale, handle = "se") {
  const origin = snapshot.origins[item.id];
  if (!origin) return item;
  const anchor = resizeAnchorFromHandle(snapshot.box, handle);

  const resizedItem = {
    ...item,
    x: anchor.x + (origin.x - anchor.x) * scale,
    y: anchor.y + (origin.y - anchor.y) * scale,
    width: Math.max(origin.minWidth, origin.width * scale),
    height: Math.max(origin.minHeight, origin.height * scale),
  };

  if (item.type === "note") {
    resizedItem.fontSize = clampNumber(origin.fontSize * scale, 2, 1024);
    const fitted = fitTextNodeSize(origin.text, resizedItem.fontSize, origin.fontFamily);
    resizedItem.width = fitted.width;
    resizedItem.height = fitted.height;

    if (snapshot.ids.length === 1) {
      resizedItem.x = handle.includes("w")
        ? anchor.x - fitted.width
        : handle.includes("e")
          ? anchor.x
          : anchor.x - fitted.width / 2;
      resizedItem.y = handle.includes("n")
        ? anchor.y - fitted.height
        : handle.includes("s")
          ? anchor.y
          : anchor.y - fitted.height / 2;
    }
  }

  return resizedItem;
}

function getStoredImageDimensions(asset) {
  const width = Number(asset?.pixelWidth || asset?.naturalWidth || asset?.imageWidth);
  const height = Number(asset?.pixelHeight || asset?.naturalHeight || asset?.imageHeight);
  return width > 0 && height > 0 ? { width, height } : null;
}

function getAssetAspectRatio(asset) {
  const dimensions = getStoredImageDimensions(asset);
  if (dimensions) return `${dimensions.width} / ${dimensions.height}`;
  const parsed = String(asset?.dimensions || asset?.size || "").match(/(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)/);
  if (!parsed) return "16 / 9";
  const width = Number(parsed[1]);
  const height = Number(parsed[2]);
  return width > 0 && height > 0 ? `${width} / ${height}` : "16 / 9";
}

function readImageDimensions(src) {
  if (!src) return Promise.resolve(null);

  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

function readVideoDimensions(src) {
  if (!src) return Promise.resolve(null);

  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => resolve({ width: video.videoWidth, height: video.videoHeight });
    video.onerror = () => resolve(null);
    video.src = src;
  });
}

function readAssetDimensions(asset) {
  const mediaUrl = getAssetMediaUrl(asset);
  return isAssetVideo(asset) ? readVideoDimensions(mediaUrl) : readImageDimensions(mediaUrl);
}

function fitImageNodeSize(dimensions, options = {}) {
  const maxWidth = options.maxWidth ?? 340;
  const maxHeight = options.maxHeight ?? 340;
  const minWidth = options.minWidth ?? 96;
  const minHeight = options.minHeight ?? 72;
  const fallback = { width: 268, height: 156 };
  const naturalWidth = Number(dimensions?.width);
  const naturalHeight = Number(dimensions?.height);

  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return fallback;

  const scale = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight, 1);
  let width = naturalWidth * scale;
  let height = naturalHeight * scale;

  if (width < minWidth) {
    const grow = minWidth / width;
    width *= grow;
    height *= grow;
  }
  if (height < minHeight) {
    const grow = minHeight / height;
    width *= grow;
    height *= grow;
  }

  return {
    width: Math.round(width),
    height: Math.round(height),
  };
}

function fitExistingItemSize(item, options = {}) {
  return fitImageNodeSize({ width: item.width, height: item.height }, options);
}

function fitImageNodeSizeToExistingFrame(dimensions, item) {
  const naturalWidth = Number(dimensions?.width);
  const naturalHeight = Number(dimensions?.height);
  const currentWidth = Number(item?.width);
  const currentHeight = Number(item?.height);
  if (!(naturalWidth > 0) || !(naturalHeight > 0) || !(currentWidth > 0) || !(currentHeight > 0)) return null;

  const aspect = naturalWidth / naturalHeight;
  const naturalLongSide = Math.max(naturalWidth, naturalHeight);
  const maxLongSide = Math.max(720, Math.min(1600, naturalLongSide));
  const longSide = Math.min(maxLongSide, Math.max(120, Math.max(currentWidth, currentHeight)));
  const width = aspect >= 1 ? longSide : longSide * aspect;
  const height = aspect >= 1 ? longSide / aspect : longSide;

  return {
    width: Math.max(80, Math.round(width)),
    height: Math.max(64, Math.round(height)),
  };
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Shift 加选、Ctrl/Cmd 减选，无修饰键时替换整个选区。
function selectionModifierFromEvent(event) {
  if (!event) return "replace";
  if (event.shiftKey) return "add";
  if (event.ctrlKey || event.metaKey) return "remove";
  return "replace";
}

function combineSelection(baseIds, hitIds, mode) {
  if (mode === "add") return new Set([...baseIds, ...hitIds]);
  if (mode === "remove") {
    const next = new Set(baseIds);
    hitIds.forEach((id) => next.delete(id));
    return next;
  }
  return new Set(hitIds);
}

function createPointerMoveScheduler(callback) {
  let frame = 0;
  let latestPoint = null;

  const flush = () => {
    frame = 0;
    const point = latestPoint;
    latestPoint = null;
    if (point) callback(point.clientX, point.clientY);
  };

  return {
    move(event) {
      latestPoint = { clientX: event.clientX, clientY: event.clientY };
      if (!frame) frame = window.requestAnimationFrame(flush);
    },
    flush() {
      if (frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      const point = latestPoint;
      latestPoint = null;
      if (point) callback(point.clientX, point.clientY);
    },
    cancel() {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      latestPoint = null;
    },
  };
}

let textMeasureContext = null;

function estimatedTextLineWidth(line, fontSize, fontFamily = defaultNoteFont) {
  if (typeof document !== "undefined") {
    textMeasureContext ||= document.createElement("canvas").getContext("2d");
    if (textMeasureContext) {
      textMeasureContext.font = `${fontSize}px ${fontFamily || defaultNoteFont}`;
      return textMeasureContext.measureText(String(line || " ")).width;
    }
  }

  return Array.from(String(line || "")).reduce((width, character) => {
    if (character === "\t") return width + fontSize * 2;
    if (/\s/.test(character)) return width + fontSize * 0.36;
    if (/[\u2e80-\u9fff\uac00-\ud7af\uff01-\uff60]/u.test(character)) return width + fontSize;
    return width + fontSize * 0.62;
  }, 0);
}

function fitTextNodeSize(text = "", fontSize = 16, fontFamily = defaultNoteFont) {
  const size = Number(fontSize) || 16;
  const lines = String(text || "").split(/\r?\n/);
  const lineWidths = lines.map((line) => estimatedTextLineWidth(line, size, fontFamily));
  const idealWidth = Math.max(size * 1.25, ...lineWidths) + textNodeOuterInset;
  const width = clampNumber(Math.ceil(idealWidth), 18, 6400);
  const height = clampNumber(
    Math.ceil(Math.max(1, lines.length) * size * textNodeLineHeight + textNodeOuterInset),
    12,
    6400,
  );
  return { width, height };
}

function growTextNodeSize(item, text, fontSize = item?.fontSize) {
  return fitTextNodeSize(text, fontSize, item?.fontFamily || defaultNoteFont);
}

function normalizeTextNodeBounds(item, fontFamily = item?.fontFamily || defaultNoteFont) {
  if (item?.type !== "note") return item;
  const fitted = fitTextNodeSize(item.text, item.fontSize, fontFamily);
  if (Math.abs(Number(item.width) - fitted.width) < 0.5 && Math.abs(Number(item.height) - fitted.height) < 0.5) {
    return item;
  }
  return { ...item, ...fitted };
}

function normalizeBoardTextNodes(items, fontOptions = noteFontOptions) {
  let changed = false;
  const nextItems = items.map((item) => {
    if (item.type !== "note") return item;
    const normalized = normalizeTextNodeBounds(item, noteFontValue(item, fontOptions));
    if (normalized !== item) changed = true;
    return normalized;
  });
  return changed ? nextItems : items;
}

// 多选复制到系统剪贴板时，选区会合成为一张拼图：位置、留白与画布一致，
// 视频只画封面帧（与画布中显示的首帧相同），文本节点直接绘制文字。
const boardClipboardImagePadding = 8;
const boardClipboardImageMaxDimension = 4096;
const boardClipboardVideoFrameTime = 0.03;
const boardClipboardVideoBackground = "#090b0a";
const boardClipboardFallbackBackground = "#111312";
let boardClipboardCompositeToken = 0;

function boardClipboardSurfaceBackground(surface) {
  if (!surface || typeof window.getComputedStyle !== "function") return boardClipboardFallbackBackground;
  const color = window.getComputedStyle(surface).backgroundColor;
  return !color || color === "transparent" || color === "rgba(0, 0, 0, 0)" ? boardClipboardFallbackBackground : color;
}

// 单选一张本地图片时直接复用原文件，保留源图的格式和分辨率。
function boardClipboardImagePath(items, assetById) {
  if (items.length !== 1) return "";
  const asset = items[0]?.assetId ? assetById?.get(items[0].assetId) : null;
  if (!asset || isAssetVideo(asset)) return "";
  const path = getAssetCheckPath(asset);
  return isCheckableLocalPath(path) ? path : "";
}

// 单选一段本地视频时复制出去的就是视频本身，而不是封面图。
function boardClipboardVideoPath(items, assetById) {
  if (items.length !== 1) return "";
  const asset = items[0]?.assetId ? assetById?.get(items[0].assetId) : null;
  if (!asset || !isAssetVideo(asset)) return "";
  const path = getAssetCheckPath(asset);
  return isCheckableLocalPath(path) ? path : "";
}

// 单选文本节点时复制出去的就是纯文本，白板负载仍放进自定义格式留给内部粘贴。
function writeBoardPlainTextClipboard(event, serialized, text) {
  if (!event?.clipboardData) return false;
  try {
    event.clipboardData.setData(boardClipboardMime, serialized);
  } catch {
    // 部分剪贴板后端只保留文本格式。
  }
  event.clipboardData.setData("text/plain", text);
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function noteFontFamilyValue(value) {
  const text = String(value || "").trim() || defaultNoteFont;
  return /(^|,)\s*(sans-serif|serif|monospace|cursive|fantasy|system-ui)\s*$/i.test(text) ? text : `${text}, sans-serif`;
}

// 与 textarea 的 white-space: pre-wrap + overflow-wrap: anywhere 对齐。
function wrapNoteTextLines(text, fontSize, fontFamily, maxWidth) {
  const lines = [];
  String(text ?? "").split(/\r?\n/).forEach((paragraph) => {
    let line = "";
    (paragraph.match(/\s+|\S+/g) ?? []).forEach((token) => {
      if (estimatedTextLineWidth(line + token, fontSize, fontFamily) <= maxWidth) {
        line += token;
        return;
      }
      if (line) {
        lines.push(line);
        line = "";
      }
      let rest = token;
      while (rest.length > 1 && estimatedTextLineWidth(rest, fontSize, fontFamily) > maxWidth) {
        let index = 1;
        while (index < rest.length && estimatedTextLineWidth(rest.slice(0, index + 1), fontSize, fontFamily) <= maxWidth) index += 1;
        lines.push(rest.slice(0, index));
        rest = rest.slice(index);
      }
      line = rest;
    });
    lines.push(line);
  });
  return lines;
}

function drawBoardNote(ctx, item, rect, fontOptions) {
  const fontSize = Number(item.fontSize) || 16;
  const fontFamily = noteFontFamilyValue(noteFontValue(item, fontOptions));
  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.textBaseline = "top";
  ctx.fillStyle = noteColorValue(item);
  const inset = 2;
  wrapNoteTextLines(item.text, fontSize, fontFamily, Math.max(1, rect.width - inset * 2)).forEach((line, index) => {
    if (line) ctx.fillText(line, rect.x + inset, rect.y + inset + index * fontSize * textNodeLineHeight);
  });
}

function drawContainedMedia(ctx, source, naturalWidth, naturalHeight, rect) {
  if (!(naturalWidth > 0) || !(naturalHeight > 0) || !(rect.width > 0) || !(rect.height > 0)) return;
  const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  ctx.drawImage(source, rect.x + (rect.width - width) / 2, rect.y + (rect.height - height) / 2, width, height);
}

function waitForMediaEvent(target, eventNames, timeout) {
  return new Promise((resolve) => {
    const finish = (eventName) => {
      window.clearTimeout(timer);
      eventNames.forEach((name) => target.removeEventListener(name, onEvent));
      resolve(eventName);
    };
    const onEvent = (event) => finish(event.type);
    const timer = window.setTimeout(() => finish(""), timeout);
    eventNames.forEach((name) => target.addEventListener(name, onEvent));
  });
}

async function resolveBoardItemMediaUrl(asset) {
  const requested = getAssetMediaUrl(asset);
  if (!isCheckableLocalPath(requested) || typeof window.referenceBoard?.getMediaUrl !== "function") return requested;
  try {
    const url = await window.referenceBoard.getMediaUrl(requested);
    return typeof url === "string" && url ? url : requested;
  } catch {
    return requested;
  }
}

async function loadBoardItemImage(url) {
  const image = new window.Image();
  image.src = url;
  try {
    await image.decode();
  } catch {
    return null;
  }
  return image.naturalWidth > 0 && image.naturalHeight > 0 ? image : null;
}

async function loadBoardItemVideoCover(url) {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  let timer = 0;
  const loaded = new Promise((resolve) => {
    const finish = (ok) => {
      window.clearTimeout(timer);
      video.removeEventListener("loadeddata", onLoaded);
      video.removeEventListener("error", onError);
      resolve(ok);
    };
    const onLoaded = () => finish(true);
    const onError = () => finish(false);
    video.addEventListener("loadeddata", onLoaded);
    video.addEventListener("error", onError);
    timer = window.setTimeout(() => finish(false), 8000);
  });
  video.src = url;
  if (!(await loaded) || video.readyState < 2) return null;
  // 画布里的封面是首帧（revealVideoFirstFrame 会切到 0.03s），拼图保持一致。
  if (Number(video.duration) > boardClipboardVideoFrameTime + 0.05) {
    const seeked = waitForMediaEvent(video, ["seeked", "error"], 4000);
    try {
      video.currentTime = boardClipboardVideoFrameTime;
    } catch {
      // 不可跳转时直接用当前解码帧。
    }
    await seeked;
  }
  return video;
}

// 远程素材直接绘制会污染画布（toBlob 会抛 SecurityError），先取回 blob 再绘制。
async function loadBoardItemDrawable(asset) {
  const url = await resolveBoardItemMediaUrl(asset);
  if (!url) return null;
  const load = () => (isAssetVideo(asset) ? loadBoardItemVideoCover(url) : loadBoardItemImage(url));
  if (!isHttpUrl(url)) {
    const source = await load();
    return source ? { source } : null;
  }

  try {
    const response = await fetch(url);
    const objectUrl = URL.createObjectURL(await response.blob());
    const source = isAssetVideo(asset) ? await loadBoardItemVideoCover(objectUrl) : await loadBoardItemImage(objectUrl);
    if (source) return { source, release: () => URL.revokeObjectURL(objectUrl) };
    URL.revokeObjectURL(objectUrl);
  } catch {
    // 跨域取不回时跳过该素材，其余内容仍然成图。
  }
  return null;
}

function releaseBoardItemDrawable(drawable) {
  drawable.release?.();
  const source = drawable.source;
  if (source instanceof HTMLVideoElement) {
    source.pause?.();
    source.removeAttribute("src");
    source.load?.();
  }
}

async function composeBoardSelectionImage(items, assetById, options) {
  const minX = Math.min(...items.map((item) => Number(item.x) || 0));
  const minY = Math.min(...items.map((item) => Number(item.y) || 0));
  const maxX = Math.max(...items.map((item) => (Number(item.x) || 0) + (Number(item.width) || 0)));
  const maxY = Math.max(...items.map((item) => (Number(item.y) || 0) + (Number(item.height) || 0)));
  const width = maxX - minX + boardClipboardImagePadding * 2;
  const height = maxY - minY + boardClipboardImagePadding * 2;
  if (!(width > 0) || !(height > 0)) return null;

  const deviceScale = clampNumber(Number(window.devicePixelRatio) || 1, 1, 2);
  const scale = Math.min(deviceScale, boardClipboardImageMaxDimension / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = options.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const originX = minX - boardClipboardImagePadding;
  const originY = minY - boardClipboardImagePadding;

  for (const item of items) {
    const rect = {
      x: ((Number(item.x) || 0) - originX) * scale,
      y: ((Number(item.y) || 0) - originY) * scale,
      width: Math.max(0, (Number(item.width) || 0) * scale),
      height: Math.max(0, (Number(item.height) || 0) * scale),
    };
    if (item.type === "note") {
      drawBoardNote(ctx, item, rect, options.noteFonts);
      continue;
    }

    const asset = item.assetId ? assetById?.get(item.assetId) : null;
    if (!asset) continue;
    if (isAssetVideo(asset)) {
      ctx.fillStyle = boardClipboardVideoBackground;
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    }

    const drawable = await loadBoardItemDrawable(asset);
    if (!drawable) continue;
    const source = drawable.source;
    drawContainedMedia(ctx, source, source.videoWidth ?? source.naturalWidth, source.videoHeight ?? source.naturalHeight, rect);
    releaseBoardItemDrawable(drawable);
  }

  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

async function writeBoardFileClipboard({ filePath, serialized, token }) {
  if (typeof window.referenceBoard?.writeBoardClipboardFile !== "function") return;
  if (token !== boardClipboardCompositeToken) return;
  try {
    await window.referenceBoard.writeBoardClipboardFile({ filePath, serialized });
  } catch {
    // 文件写不进剪贴板时保留已写入的文本负载。
  }
}

async function writeBoardSelectionImage({ items, assetById, options, serialized, token }) {
  if (typeof window.referenceBoard?.writeBoardClipboardImage !== "function") return;
  let blob = null;
  try {
    blob = await composeBoardSelectionImage(items, assetById, options);
  } catch {
    blob = null;
  }
  if (!blob?.size || token !== boardClipboardCompositeToken) return;

  try {
    await window.referenceBoard.writeBoardClipboardImage({ serialized, imageBytes: new Uint8Array(await blob.arrayBuffer()) });
  } catch {
    // 拼图写入失败时保留已有的文本负载，白板内部粘贴仍然可用。
  }
}

function writeBoardClipboard(event, items, assetById, options = {}) {
  if (!event || items.length === 0) return false;
  const serialized = JSON.stringify({ version: 1, items });
  // 单选文本：复制出去的是纯文本；单选图片/视频：出去的就是原图/原视频；多选：合成拼图。
  if (items.length === 1 && items[0]?.type === "note" && writeBoardPlainTextClipboard(event, serialized, String(items[0].text ?? ""))) {
    return true;
  }
  const imagePath = boardClipboardImagePath(items, assetById);
  const filePath = imagePath ? "" : boardClipboardVideoPath(items, assetById);
  const token = (boardClipboardCompositeToken += 1);

  if (window.referenceBoard?.writeBoardClipboard) {
    const written = window.referenceBoard.writeBoardClipboard({ serialized, imagePath });
    if (written) {
      event.preventDefault();
      event.stopPropagation();
      if (filePath) {
        void writeBoardFileClipboard({ filePath, serialized, token });
      } else if (!imagePath) {
        void writeBoardSelectionImage({
          items,
          assetById,
          serialized,
          token,
          options: {
            background: boardClipboardSurfaceBackground(options.surface),
            noteFonts: options.noteFonts?.length ? options.noteFonts : noteFontOptions,
          },
        });
      }
      return true;
    }
  }

  if (!event.clipboardData) return false;
  try {
    event.clipboardData.setData(boardClipboardMime, serialized);
  } catch {
    // Some clipboard backends only retain text formats.
  }
  event.clipboardData.setData("text/plain", `${boardClipboardPrefix}${serialized}`);
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function readBoardClipboard(clipboardData) {
  const customValue = clipboardData?.getData?.(boardClipboardMime) || "";
  const plainValue = clipboardData?.getData?.("text/plain") || "";
  const serialized = customValue || (plainValue.startsWith(boardClipboardPrefix) ? plainValue.slice(boardClipboardPrefix.length) : "");
  if (!serialized) return [];

  try {
    const parsed = JSON.parse(serialized);
    return Array.isArray(parsed?.items)
      ? parsed.items.filter((item) => item && Number.isFinite(Number(item.x)) && Number.isFinite(Number(item.y)))
      : [];
  } catch {
    return [];
  }
}

function readExternalClipboardText(clipboardData) {
  const value = clipboardData?.getData?.("text/plain") || "";
  if (!value || value.startsWith(boardClipboardPrefix)) return "";
  return value.replace(/\r\n/g, "\n").trim().slice(0, 20000);
}

function noteColorValue(item) {
  const color = String(item?.color || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : noteColorOptions[0];
}

function cssFontFamilyValue(family) {
  return `"${String(family || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function installedFontOptions(families) {
  const seen = new Set(noteFontOptions.map((option) => option.label.toLocaleLowerCase()));
  const detected = (Array.isArray(families) ? families : [])
    .map((family) => String(family || "").trim())
    .filter((family) => {
      const key = family.toLocaleLowerCase();
      if (!family || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((family) => ({ label: family, value: cssFontFamilyValue(family) }));
  return [...noteFontOptions, ...detected];
}

function useNoteFontOptions() {
  const [options, setOptions] = useState(() => installedNoteFontOptionsCache ?? noteFontOptions);

  useEffect(() => {
    let mounted = true;
    if (!installedNoteFontOptionsRequest) {
      installedNoteFontOptionsRequest = Promise.resolve(window.referenceBoard?.listSystemFonts?.())
        .then((families) => installedFontOptions(families))
        .catch(() => noteFontOptions)
        .then((nextOptions) => {
          installedNoteFontOptionsCache = nextOptions;
          return nextOptions;
        });
    }
    installedNoteFontOptionsRequest.then((nextOptions) => {
      if (mounted) setOptions(nextOptions);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return options;
}

function noteFontValue(item, fontOptions = noteFontOptions) {
  return fontOptions.some((option) => option.value === item?.fontFamily) ? item.fontFamily : defaultNoteFont;
}

function cloneBoardClipboardItems(items, generation = 1, anchor = null) {
  const normalizedGeneration = Math.max(1, generation);
  const hasAnchor = Number.isFinite(Number(anchor?.x)) && Number.isFinite(Number(anchor?.y));
  let offsetX = 24 * normalizedGeneration;
  let offsetY = 24 * normalizedGeneration;

  if (hasAnchor) {
    const left = Math.min(...items.map((item) => Number(item.x)));
    const top = Math.min(...items.map((item) => Number(item.y)));
    const right = Math.max(...items.map((item) => Number(item.x) + Math.max(1, Number(item.width) || 1)));
    const bottom = Math.max(...items.map((item) => Number(item.y) + Math.max(1, Number(item.height) || 1)));
    const repeatedPasteNudge = 12 * (normalizedGeneration - 1);
    offsetX = Number(anchor.x) - (left + right) / 2 + repeatedPasteNudge;
    offsetY = Number(anchor.y) - (top + bottom) / 2 + repeatedPasteNudge;
  }

  const timestamp = Date.now();
  return items.map((item, index) => ({
    ...item,
    id: `board-copy-${timestamp}-${index}-${Math.random().toString(36).slice(2, 7)}`,
    x: Number(item.x) + offsetX,
    y: Number(item.y) + offsetY,
  }));
}

function TextNodeToolbar({ item, onChange, placeBelow = false }) {
  const fontOptions = useNoteFontOptions();

  function stopToolbarEvent(event) {
    event.stopPropagation();
  }

  return (
    <div
      className={classNames("text-node-toolbar", placeBelow && "below")}
      onPointerDown={stopToolbarEvent}
      onMouseDown={stopToolbarEvent}
      onDoubleClick={stopToolbarEvent}
      onContextMenu={stopToolbarEvent}
    >
      <select
        className="text-font-select"
        value={noteFontValue(item, fontOptions)}
        onChange={(event) => onChange({ fontFamily: event.target.value })}
        title="字体"
        aria-label="字体"
      >
        {fontOptions.map((option) => (
          <option key={option.label} value={option.value} style={{ fontFamily: option.value }}>
            {option.label}
          </option>
        ))}
      </select>
      {noteColorOptions.map((color) => (
        <button
          key={color}
          type="button"
          className={classNames(noteColorValue(item) === color && "active")}
          style={{ "--note-color": color }}
          onClick={() => onChange({ color })}
          title="文字颜色"
          aria-label={`文字颜色 ${color}`}
        />
      ))}
      <input
        className="text-custom-color"
        type="color"
        value={noteColorValue(item)}
        onChange={(event) => onChange({ color: event.target.value })}
        title="自定义颜色"
        aria-label="自定义文字颜色"
      />
    </div>
  );
}

function getPreviewFitSize(asset, stageSize) {
  const dimensions = getStoredImageDimensions(asset) ?? { width: 1600, height: 900 };
  const stageWidth = Number(stageSize?.width) || 1;
  const stageHeight = Number(stageSize?.height) || 1;
  const availableWidth = Math.max(140, stageWidth - 48);
  const availableHeight = Math.max(110, stageHeight - 36);
  const fitScale = Math.min(availableWidth / dimensions.width, availableHeight / dimensions.height, 1);

  return {
    width: Math.max(1, Math.round(dimensions.width * fitScale)),
    height: Math.max(1, Math.round(dimensions.height * fitScale)),
  };
}

function clampPreviewOffset(offset, zoom, stageSize, fitSize) {
  if (!(zoom > 1) || !stageSize || !fitSize) return { x: 0, y: 0 };
  const overflowX = Math.max(0, fitSize.width * zoom - stageSize.width);
  const overflowY = Math.max(0, fitSize.height * zoom - stageSize.height);
  const maxX = overflowX / 2 + 36;
  const maxY = overflowY / 2 + 36;

  return {
    x: clampNumber(offset.x, -maxX, maxX),
    y: clampNumber(offset.y, -maxY, maxY),
  };
}

function boundsFromItems(items) {
  if (items.length === 0) return null;
  const left = Math.min(...items.map((item) => item.x));
  const top = Math.min(...items.map((item) => item.y));
  const right = Math.max(...items.map((item) => item.x + item.width));
  const bottom = Math.max(...items.map((item) => item.y + item.height));
  return { left, top, right, bottom };
}

const keyboardNudgeStep = 5;

// W/A/S/D 与方向键：W 上对齐、A 左对齐、S 下对齐、D 右对齐。
const keyboardArrangementKeys = {
  w: "top",
  arrowup: "top",
  a: "left",
  arrowleft: "left",
  s: "bottom",
  arrowdown: "bottom",
  d: "right",
  arrowright: "right",
};

// 画布与浮窗画布共用：选中多个素材时把同类边对齐到选区外框，只选中一个时按 5px 步进移动。
function keyboardArrangementPositions(items, selectedIds, anchor) {
  const targets = items.filter((item) => selectedIds.has(item.id));
  if (targets.length === 0) return null;

  if (targets.length === 1) {
    const item = targets[0];
    const x = item.x + (anchor === "left" ? -keyboardNudgeStep : anchor === "right" ? keyboardNudgeStep : 0);
    const y = item.y + (anchor === "top" ? -keyboardNudgeStep : anchor === "bottom" ? keyboardNudgeStep : 0);
    return { [item.id]: { x, y } };
  }

  const bounds = boundsFromItems(targets);
  const right = anchor === "right";
  const bottom = anchor === "bottom";
  const horizontal = anchor === "left" || right;
  // 锚点取画布位置上最靠对齐边的素材（右对齐即最右侧），其余素材按到该边的距离依次向内侧让位，与选中先后无关。
  const edgeKey = (item) => (right ? -(item.x + item.width) : anchor === "left" ? item.x : bottom ? -(item.y + item.height) : item.y);
  const crossKey = (item) => (horizontal ? item.y : item.x);
  const ordered = [...targets].sort((a, b) => edgeKey(a) - edgeKey(b) || crossKey(a) - crossKey(b) || String(a.id).localeCompare(String(b.id)));
  const placed = [];
  const positions = {};
  let moved = false;

  ordered.forEach((item) => {
    let x = anchor === "left" ? bounds.left : right ? bounds.right - item.width : item.x;
    let y = anchor === "top" ? bounds.top : bottom ? bounds.bottom - item.height : item.y;

    for (let guard = 0; guard <= placed.length; guard += 1) {
      const conflicts = placed.filter((rect) => x < rect.right && x + item.width > rect.left && y < rect.bottom && y + item.height > rect.top);
      if (conflicts.length === 0) break;
      if (right) x = Math.min(...conflicts.map((rect) => rect.left)) - item.width - keyboardNudgeStep;
      else if (anchor === "left") x = Math.max(...conflicts.map((rect) => rect.right)) + keyboardNudgeStep;
      else if (bottom) y = Math.min(...conflicts.map((rect) => rect.top)) - item.height - keyboardNudgeStep;
      else y = Math.max(...conflicts.map((rect) => rect.bottom)) + keyboardNudgeStep;
    }

    if (x !== item.x || y !== item.y) moved = true;
    positions[item.id] = { x, y };
    placed.push({ left: x, right: x + item.width, top: y, bottom: y + item.height });
  });

  return moved ? positions : null;
}

function nearestSnapDelta(movingEdges, targetEdges, threshold) {
  return movingEdges.reduce(
    (best, edge) => {
      for (const target of targetEdges) {
        const delta = target - edge;
        const distance = Math.abs(delta);
        if (distance <= threshold && distance < best.distance) {
          best = { distance, delta };
        }
      }
      return best;
    },
    { distance: Infinity, delta: 0 },
  ).delta;
}

function snapDraggedItems(items, movingIds, movedById, threshold = 10, cachedStationaryEdges = null) {
  const movingIdSet = new Set(movingIds);
  const movingItems = Array.from(movingIdSet).map((itemId) => movedById[itemId]).filter(Boolean);
  if (movingItems.length === 0 || movingItems.every((item) => !item.assetId)) return movedById;

  const movingBounds = boundsFromItems(movingItems);
  const stationaryItems = cachedStationaryEdges ? null : items.filter((item) => item.assetId && !movingIdSet.has(item.id));
  const stationaryXEdges = cachedStationaryEdges?.x ?? stationaryItems.flatMap((item) => [item.x, item.x + item.width]);
  const stationaryYEdges = cachedStationaryEdges?.y ?? stationaryItems.flatMap((item) => [item.y, item.y + item.height]);
  if (stationaryXEdges.length === 0 || stationaryYEdges.length === 0) return movedById;
  const snapX = nearestSnapDelta([movingBounds.left, movingBounds.right], stationaryXEdges, threshold);
  const snapY = nearestSnapDelta([movingBounds.top, movingBounds.bottom], stationaryYEdges, threshold);

  if (!snapX && !snapY) return movedById;

  return Object.fromEntries(
    Object.entries(movedById).map(([itemId, item]) => [
      itemId,
      {
        ...item,
        x: item.x + snapX,
        y: item.y + snapY,
      },
    ]),
  );
}

function writeAssetDragData(dataTransfer, assetIds) {
  const ids = Array.from(new Set(Array.from(assetIds ?? []).filter(Boolean)));
  if (ids.length === 0) return;
  dataTransfer.effectAllowed = "copyMove";
  dataTransfer.setData("application/x-motz-asset-id", ids[0]);
  dataTransfer.setData("application/x-motz-asset-ids", JSON.stringify(ids));
  dataTransfer.setData("text/x-motz-asset-id", ids[0]);
  dataTransfer.setData("text/plain", `motz-asset:${ids.join(",")}`);
}

function hasAssetDragData(dataTransfer) {
  const types = Array.from(dataTransfer?.types ?? []).map((type) => String(type).toLowerCase());
  return types.includes("application/x-motz-asset-id") || types.includes("application/x-motz-asset-ids") || types.includes("text/x-motz-asset-id") || types.includes("text/plain");
}

function readAssetDragIds(dataTransfer) {
  const jsonIds = dataTransfer?.getData("application/x-motz-asset-ids");
  if (jsonIds) {
    try {
      const parsed = JSON.parse(jsonIds);
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch {
      return [];
    }
  }

  const customId = dataTransfer?.getData("application/x-motz-asset-id") || dataTransfer?.getData("text/x-motz-asset-id");
  if (customId) return [customId];

  const plainText = dataTransfer?.getData("text/plain") || "";
  const match = plainText.match(/^motz-asset:(.+)$/);
  return match ? match[1].split(",").map((id) => id.trim()).filter(Boolean) : [];
}

function normalizeLibraries(libraries) {
  const source = Array.isArray(libraries) && libraries.length > 0 ? libraries : initialLibraries;
  const seen = new Set();
  const normalized = source
    .map((library, index) => {
      const rawId = String(library?.id || "").trim();
      const id = rawId || (index === 0 ? defaultLibraryId : `library-${Date.now()}-${index}`);
      if (seen.has(id)) return null;
      seen.add(id);
      return {
        id,
        name: sanitizeName(library?.name) || (id === defaultLibraryId ? "默认库" : `素材库 ${index + 1}`),
        root: typeof library?.root === "string" ? library.root : "",
        importMode: library?.importMode === "reference" ? "reference" : "copy",
      };
    })
    .filter(Boolean);

  return normalized.length > 0 ? normalized : initialLibraries;
}

function libraryStorageKey(libraryId, area) {
  if (!libraryId || libraryId === defaultLibraryId) return `reference-board-${area}`;
  return `reference-board-library-${libraryId}-${area}`;
}

export function App() {
  const [libraries, setLibraries] = useStoredState("reference-board-libraries", initialLibraries);
  const normalizedLibraries = useMemo(() => normalizeLibraries(libraries), [libraries]);
  const [activeLibraryId, setActiveLibraryId] = useStoredState("reference-board-active-library-id", defaultLibraryId);
  const activeLibrary = normalizedLibraries.find((library) => library.id === activeLibraryId) ?? normalizedLibraries[0];
  const effectiveLibraryId = activeLibrary?.id ?? defaultLibraryId;
  const [assets, setAssets] = useStoredState(libraryStorageKey(effectiveLibraryId, "assets"), initialAssets);
  const [boards, setBoards] = useStoredState(libraryStorageKey(effectiveLibraryId, "boards"), initialBoards);
  const [folders, setFolders] = useStoredState(libraryStorageKey(effectiveLibraryId, "folders"), initialFolders);
  const [boardItems, setBoardItems] = useStoredState(libraryStorageKey(effectiveLibraryId, "items"), initialBoardItems);
  const { checkpointBoardItems, undoBoardItems, redoBoardItems } = useBoardHistory(boardItems, setBoardItems, effectiveLibraryId);

  useEffect(() => {
    if (JSON.stringify(normalizedLibraries) === JSON.stringify(libraries)) return;
    setLibraries(normalizedLibraries);
  }, [libraries, normalizedLibraries, setLibraries]);

  useEffect(() => {
    if (activeLibrary && activeLibrary.id === activeLibraryId) return;
    setActiveLibraryId(normalizedLibraries[0]?.id ?? defaultLibraryId);
  }, [activeLibrary, activeLibraryId, normalizedLibraries, setActiveLibraryId]);

  const floatingBoardId = readParam("board");
  if (readParam("floating") === "1") {
    return (
      <FloatingBoard
        assets={assets}
        boards={boards}
        boardId={floatingBoardId || ""}
        boardItems={boardItems}
        checkpointBoardItems={checkpointBoardItems}
        undoBoardItems={undoBoardItems}
        redoBoardItems={redoBoardItems}
        setAssets={setAssets}
        setBoardItems={setBoardItems}
        activeLibrary={activeLibrary}
      />
    );
  }

  return (
    <Workspace
      assets={assets}
      boards={boards}
      boardItems={boardItems}
      checkpointBoardItems={checkpointBoardItems}
      folders={folders}
      libraries={normalizedLibraries}
      activeLibrary={activeLibrary}
      activeLibraryId={effectiveLibraryId}
      storagePrefix={effectiveLibraryId}
      setAssets={setAssets}
      setBoards={setBoards}
      setBoardItems={setBoardItems}
      setFolders={setFolders}
      setLibraries={setLibraries}
      setActiveLibraryId={setActiveLibraryId}
      undoBoardItems={undoBoardItems}
      redoBoardItems={redoBoardItems}
    />
  );
}

function Workspace({
  assets,
  boards,
  boardItems,
  checkpointBoardItems,
  folders,
  libraries,
  activeLibrary,
  activeLibraryId,
  storagePrefix,
  setAssets,
  setBoards,
  setBoardItems,
  setFolders,
  setLibraries,
  setActiveLibraryId,
  undoBoardItems,
  redoBoardItems,
}) {
  const [activeBoardId, setActiveBoardId] = useState("");
  const [floatingTargetId, setFloatingTargetId] = useState("");
  const [activeCollection, setActiveCollection] = useState("all");
  const [activeFolder, setActiveFolder] = useState("");
  const [colorFilter, setColorFilter] = useState("all");
  const [selectedTagFilters, setSelectedTagFilters] = useStoredState(libraryStorageKey(storagePrefix, "selected-tag-filters"), []);
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [selectedBoardItemId, setSelectedBoardItemId] = useState("");
  const [query, setQuery] = useState("");
  const [assetSortMode, setAssetSortMode] = useStoredState(libraryStorageKey(storagePrefix, "asset-sort-mode"), "recent");
  const [assetSortMenuOpen, setAssetSortMenuOpen] = useState(false);
  const [onboardingComplete, setOnboardingComplete] = useStoredState("reference-board-onboarding-complete", hasExistingWorkspace);
  const [zoom, setZoom] = useState(defaultBoardZoom);
  const [boardViewStates, setBoardViewStates] = useStoredState(libraryStorageKey(storagePrefix, "board-view-states"), {});
  const [viewMode, setViewMode] = useStoredState("reference-board-view-mode", "library");
  const [dragState, setDragState] = useState(null);
  const [nameDialog, setNameDialog] = useState(null);
  const [nameInput, setNameInput] = useState("");
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [boardMenu, setBoardMenu] = useState(null);
  const [assetMenu, setAssetMenu] = useState(null);
  const [libraryMenu, setLibraryMenu] = useState(null);
  const [librarySwitcherMenu, setLibrarySwitcherMenu] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingName, setOnboardingName] = useState("我的素材库");
  const [onboardingImportMode, setOnboardingImportMode] = useState("copy");
  const [renamingAssetId, setRenamingAssetId] = useState("");
  const [renameAssetInput, setRenameAssetInput] = useState("");
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedAssetIds, setSelectedAssetIds] = useState(() => new Set());
  const [assetRangeAnchorId, setAssetRangeAnchorId] = useState("");
  const [assetSelectionBox, setAssetSelectionBox] = useState(null);
  const [folderDropTarget, setFolderDropTarget] = useState("");
  const [assetDragActive, setAssetDragActive] = useState(false);
  const [assetGridScale, setAssetGridScale] = useState(1);
  const [assetRenderLimit, setAssetRenderLimit] = useState(initialAssetRenderLimit);
  const [assetThumbnailUrls, setAssetThumbnailUrls] = useState({});
  const [assetPanelWidth, setAssetPanelWidth] = useStoredState("reference-board-asset-panel-width", 520);
  const [collapsedFolders, setCollapsedFolders] = useStoredState(libraryStorageKey(storagePrefix, "collapsed-folders"), []);
  const [sourceDetailsOpen, setSourceDetailsOpen] = useStoredState("reference-board-source-details-open", false);
  const [inspectorCollapsed, setInspectorCollapsed] = useStoredState("reference-board-inspector-collapsed", false);
  const [libraryRoot, setLibraryRoot] = useState("");
  const [toast, setToast] = useState("");
  const [previewAssetId, setPreviewAssetId] = useState("");
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewOffset, setPreviewOffset] = useState({ x: 0, y: 0 });
  const [previewPanState, setPreviewPanState] = useState(null);
  const [previewStageSize, setPreviewStageSize] = useState({ width: 0, height: 0 });
  const [boardManagerOpen, setBoardManagerOpen] = useState(false);
  const [floatingLaunchActive, setFloatingLaunchActive] = useState(false);
  const [boardSelectionRequest, setBoardSelectionRequest] = useState(null);
  const fileInputRef = useRef(null);
  const assetGridRef = useRef(null);
  const previewStageRef = useRef(null);
  const floatingLaunchTimerRef = useRef(null);
  const draggingAssetIdsRef = useRef([]);
  const nativeDragStartedRef = useRef(false);
  const cancelAssetRenameRef = useRef(false);
  const boardsRef = useRef(boards);
  const thumbnailRequestSourcesRef = useRef(new Set());
  const thumbnailLibraryRef = useRef(storagePrefix);

  useEffect(() => window.referenceBoard?.onNativeFileDragEnd?.(() => {
    draggingAssetIdsRef.current = [];
    nativeDragStartedRef.current = false;
    setAssetDragActive(false);
    setFolderDropTarget("");
  }), []);

  const activeBoard = boards.find((board) => board.id === activeBoardId);
  const activeImportMode = activeLibrary?.importMode === "reference" ? "reference" : "copy";
  const activeItems = activeBoard ? (boardItems[activeBoardId] ?? []) : [];
  const liveAssets = useMemo(() => assets.filter((asset) => !isAssetTrashed(asset)), [assets]);
  const libraryAssets = useMemo(() => liveAssets.filter((asset) => !isBoardFileAsset(asset)), [liveAssets]);
  const trashedAssets = useMemo(() => assets.filter(isAssetTrashed), [assets]);
  const boardFileAssets = useMemo(() => liveAssets.filter(isBoardFileAsset), [liveAssets]);
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const activeItemAssetIds = useMemo(() => new Set(activeItems.map((item) => item.assetId).filter(Boolean)), [activeItems]);
  const selectedAsset = assetById.get(selectedAssetId) ?? liveAssets[0] ?? trashedAssets[0];
  const selectedBoardItem = activeItems.find((item) => item.id === selectedBoardItemId);
  const selectedBoardAsset = selectedBoardItem?.assetId
    ? assetById.get(selectedBoardItem.assetId)
    : null;
  const inspectorAsset = selectedBoardAsset ?? selectedAsset;
  const previewAsset = assetById.get(previewAssetId);
  const setBoardZoomAroundViewportCenterRef = useRef(null);
  const selectedAssets = useMemo(
    () => Array.from(selectedAssetIds).map((assetId) => assetById.get(assetId)).filter(Boolean),
    [assetById, selectedAssetIds],
  );
  const isBulkAssetEditing = !selectedBoardAsset && selectedAssets.length > 1;

  const sentAssetMembershipKey = Object.values(boardItems)
    .flatMap((items) => items.map((item) => `${item.id}:${item.assetId || ""}`))
    .join("|");
  const sentAssetIds = useMemo(() => {
    return new Set(Object.values(boardItems).flat().map((item) => item.assetId).filter(Boolean));
  }, [sentAssetMembershipKey]);

  const tags = useMemo(() => uniqueTags(libraryAssets), [libraryAssets]);
  const selectedTagFilterList = useMemo(
    () => (Array.isArray(selectedTagFilters) ? selectedTagFilters.filter((tag) => tags.includes(tag)) : []),
    [selectedTagFilters, tags],
  );
  const selectedTagFilterSet = useMemo(() => new Set(selectedTagFilterList), [selectedTagFilterList]);
  const previewFitSize = useMemo(() => getPreviewFitSize(previewAsset, previewStageSize), [previewAsset, previewStageSize]);
  const inspectorColorPalette = useMemo(() => colorPaletteForAsset(inspectorAsset), [inspectorAsset]);
  const bulkFolderValue = useMemo(() => {
    if (!isBulkAssetEditing) return "";
    const uniqueFolders = Array.from(new Set(selectedAssets.map((asset) => asset.folder || "")));
    return uniqueFolders.length === 1 ? uniqueFolders[0] : "__mixed__";
  }, [isBulkAssetEditing, selectedAssets]);
  const bulkNoteState = useMemo(() => {
    if (!isBulkAssetEditing) return { value: "", mixed: false };
    const uniqueNotes = Array.from(new Set(selectedAssets.map((asset) => asset.note || "")));
    return {
      value: uniqueNotes.length === 1 ? uniqueNotes[0] : "",
      mixed: uniqueNotes.length > 1,
    };
  }, [isBulkAssetEditing, selectedAssets]);
  const bulkTags = useMemo(() => uniqueTags(selectedAssets), [selectedAssets]);
  const tagsAvailableForBulk = useMemo(
    () => tags.filter((tag) => selectedAssets.some((asset) => !asset.tags.includes(tag))),
    [selectedAssets, tags],
  );
  const sortedFolders = useMemo(() => sortFoldersByHierarchy(folders), [folders]);
  const collectionCounts = useMemo(() => {
    const counts = { all: libraryAssets.length, images: 0, videos: 0, untagged: 0, unsorted: 0 };
    libraryAssets.forEach((asset) => {
      if (isAssetVideo(asset)) counts.videos += 1;
      else counts.images += 1;
      if (asset.tags.length === 0) counts.untagged += 1;
      if (!asset.folder) counts.unsorted += 1;
    });
    return counts;
  }, [libraryAssets]);
  const folderAssetCounts = useMemo(
    () => new Map(sortedFolders.map((folder) => [folder, liveAssets.filter((asset) => folderContainsAsset(folder, asset.folder)).length])),
    [liveAssets, sortedFolders],
  );
  const collapsedFolderList = useMemo(() => (Array.isArray(collapsedFolders) ? collapsedFolders : []), [collapsedFolders]);
  const collapsedFolderSet = useMemo(() => new Set(collapsedFolderList), [collapsedFolderList]);
  const foldersWithChildren = useMemo(() => {
    return new Set(sortedFolders.filter((folder) => sortedFolders.some((candidate) => candidate !== folder && folderContainsAsset(folder, candidate))));
  }, [sortedFolders]);
  const visibleFolders = useMemo(() => {
    return sortedFolders.filter((folder) => !folderAncestors(folder).some((ancestor) => collapsedFolderSet.has(ancestor)));
  }, [collapsedFolderSet, sortedFolders]);

  const baseFilteredAssets = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return assets
      .filter((asset) => {
        const isTrashed = isAssetTrashed(asset);
        if (activeCollection === "trash" ? !isTrashed : isTrashed) return false;
        const isImportedBoardAsset = isBoardFileAsset(asset);
        const isStandardLibraryCollection = ["all", "images", "videos", "unsorted", "untagged", "recent"].includes(activeCollection);
        if (isImportedBoardAsset && isStandardLibraryCollection) return false;

        const matchesQuery =
          !normalizedQuery ||
          [asset.title, asset.folder, asset.type, asset.source, asset.originalSource, asset.remoteSource, ...asset.tags]
            .join(" ")
            .toLowerCase()
            .includes(normalizedQuery);

        const matchesCollection =
          activeCollection === "all" ||
          (activeCollection === "images" && !isAssetVideo(asset)) ||
          (activeCollection === "videos" && isAssetVideo(asset)) ||
          (activeCollection === "folder" && folderContainsAsset(activeFolder, asset.folder)) ||
          (activeCollection === "unsorted" && !asset.folder) ||
          (activeCollection === "untagged" && asset.tags.length === 0) ||
          (activeCollection === "board-assets" && isBoardFileAsset(asset)) ||
          (activeCollection === "sent" && sentAssetIds.has(asset.id)) ||
          activeCollection === "trash" ||
          activeCollection === "recent";

        const matchesTags = selectedTagFilterList.length === 0 || selectedTagFilterList.every((tag) => asset.tags.includes(tag));

        return matchesQuery && matchesCollection && matchesTags;
      })
      .sort((a, b) => (activeCollection === "recent" ? String(b.created).localeCompare(String(a.created)) : 0));
  }, [activeCollection, activeFolder, assets, query, selectedTagFilterList, sentAssetIds]);

  const colorFilterCounts = useMemo(() => {
    return baseFilteredAssets.reduce((counts, asset) => {
      colorGroupsForAsset(asset).forEach((group) => {
        counts.set(group, (counts.get(group) ?? 0) + 1);
      });
      return counts;
    }, new Map());
  }, [baseFilteredAssets]);

  const availableColorFilters = useMemo(() => {
    return colorFilters.filter((item) => colorFilterCounts.has(item.id));
  }, [colorFilterCounts]);

  const filteredAssets = useMemo(() => {
    const colorMatched = colorFilter === "all" ? baseFilteredAssets : baseFilteredAssets.filter((asset) => assetMatchesColorFilter(asset, colorFilter));
    return sortAssets(colorMatched, activeCollection === "recent" ? "recent" : assetSortMode);
  }, [activeCollection, assetSortMode, baseFilteredAssets, colorFilter]);
  const renderedAssets = useMemo(() => filteredAssets.slice(0, assetRenderLimit), [assetRenderLimit, filteredAssets]);
  const previewAssets = filteredAssets.length > 0 ? filteredAssets : assets;
  const previewAssetIndex = previewAsset ? Math.max(0, previewAssets.findIndex((asset) => asset.id === previewAsset.id)) : -1;

  useEffect(() => {
    thumbnailLibraryRef.current = storagePrefix;
    thumbnailRequestSourcesRef.current.clear();
    setAssetThumbnailUrls({});
  }, [storagePrefix]);

  useEffect(() => {
    const getMediaThumbnails = window.referenceBoard?.getMediaThumbnails;
    if (typeof getMediaThumbnails !== "function") return;
    const requestLibrary = storagePrefix;
    const entries = renderedAssets
      .filter((asset) => !isAssetVideo(asset))
      .map((asset) => ({ id: asset.id, source: getAssetCheckPath(asset) }))
      .filter((entry) => entry.source && !thumbnailRequestSourcesRef.current.has(entry.source));
    if (entries.length === 0) return;

    entries.forEach((entry) => thumbnailRequestSourcesRef.current.add(entry.source));
    const sourceById = new Map(entries.map((entry) => [entry.id, entry.source]));
    getMediaThumbnails(entries)
      .then((result) => {
        if (thumbnailLibraryRef.current !== requestLibrary) return;
        const items = Array.isArray(result?.items) ? result.items : [];
        const itemById = new Map(items.map((item) => [item.id, item]));
        entries.forEach((entry) => {
          if (!itemById.has(entry.id)) thumbnailRequestSourcesRef.current.delete(entry.source);
        });
        setAssetThumbnailUrls((current) => {
          const next = { ...current };
          entries.forEach((entry) => {
            const item = itemById.get(entry.id);
            next[entry.id] = item?.thumbnail
              ? { url: item.thumbnail, source: sourceById.get(entry.id) || "" }
              : { url: "", source: entry.source, failed: true };
          });
          return next;
        });
      })
      .catch(() => {
        entries.forEach((entry) => thumbnailRequestSourcesRef.current.delete(entry.source));
        if (thumbnailLibraryRef.current !== requestLibrary) return;
        setAssetThumbnailUrls((current) => {
          const next = { ...current };
          entries.forEach((entry) => {
            next[entry.id] = { url: "", source: entry.source, failed: true };
          });
          return next;
        });
      });
  }, [renderedAssets, storagePrefix]);

  useEffect(() => {
    if (colorFilter === "all" || colorFilterCounts.has(colorFilter)) return;
    setColorFilter("all");
  }, [colorFilter, colorFilterCounts]);

  useEffect(() => {
    setAssetRenderLimit(initialAssetRenderLimit);
  }, [activeCollection, activeFolder, colorFilter, query, selectedTagFilterList]);

  useEffect(() => {
    boardsRef.current = boards;
  }, [boards]);

  useEffect(() => {
    const hasLegacyBoardFolder = assets.some(
      (asset) => asset.folder === "白板素材" && Array.isArray(asset.tags) && asset.tags.includes("白板文件"),
    );
    if (!hasLegacyBoardFolder) return;

    setAssets((current) =>
      current.map((asset) =>
        asset.folder === "白板素材" && Array.isArray(asset.tags) && asset.tags.includes("白板文件")
          ? { ...asset, folder: "", boardFileAsset: true }
          : asset,
      ),
    );
    setFolders((current) => current.filter((folder) => folder !== "白板素材"));
  }, [assets, setAssets, setFolders]);

  useEffect(() => {
    setSelectedTagFilters((current) => {
      const currentList = Array.isArray(current) ? current : [];
      const next = currentList.filter((tag) => tags.includes(tag));
      return next.length === currentList.length ? currentList : next;
    });
  }, [setSelectedTagFilters, tags]);

  useEffect(() => {
    const existingFolders = new Set(folders);
    setCollapsedFolders((current) => {
      const currentList = Array.isArray(current) ? current : [];
      const next = currentList.filter((folder) => existingFolders.has(folder));
      return next.length === currentList.length ? currentList : next;
    });
  }, [folders, setCollapsedFolders]);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const unsubscribe = window.referenceBoard?.onBoardFileOpen?.((result) => applyOpenedBoardResult(result));
    window.referenceBoard?.signalRendererReady?.();
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!previewAssetId) return undefined;

    const handleKeyDown = (event) => {
      if (event.code === "Space" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPreviewAssetId("");
        return;
      }
      if (event.key === "Escape") setPreviewAssetId("");
      if (event.key === "ArrowLeft") movePreviewAsset(-1);
      if (event.key === "ArrowRight") movePreviewAsset(1);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [previewAssetId, previewAssets]);

  useEffect(() => {
    setPreviewZoom(1);
    setPreviewOffset({ x: 0, y: 0 });
    setPreviewPanState(null);
  }, [previewAssetId]);

  useEffect(() => {
    if (!previewPanState) return undefined;

    const move = (event) => {
      const rect = previewStageRef.current?.getBoundingClientRect();
      const nextOffset = {
        x: previewPanState.originX + event.clientX - previewPanState.startX,
        y: previewPanState.originY + event.clientY - previewPanState.startY,
      };
      const stageSize = previewStageSize.width > 0 && previewStageSize.height > 0 ? previewStageSize : rect;
      setPreviewOffset(clampPreviewOffset(nextOffset, previewZoom, stageSize, previewFitSize));
    };
    const stop = () => setPreviewPanState(null);

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
    };
  }, [previewFitSize, previewPanState, previewStageSize, previewZoom]);

  useEffect(() => {
    if (!previewAssetId) return undefined;
    const stage = previewStageRef.current;
    if (!stage) return undefined;

    const updateStageSize = () => {
      const rect = stage.getBoundingClientRect();
      setPreviewStageSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
    };

    updateStageSize();
    const observer = new ResizeObserver(updateStageSize);
    observer.observe(stage);
    window.addEventListener("resize", updateStageSize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateStageSize);
    };
  }, [previewAssetId]);

  useEffect(() => {
    return () => window.clearTimeout(floatingLaunchTimerRef.current);
  }, []);

  useEffect(() => {
    const handleGlobalPaste = (event) => {
      if (isTextEditingTarget(event.target) || event.target?.closest?.(".canvas-frame")) return;
      const input = getClipboardMediaInput(event.clipboardData);
      if (!input.hasContent) return;
      event.preventDefault();
      importImagesToLibrary(input.files, input.metadata, { messagePrefix: "已粘贴到素材库" });
    };

    window.addEventListener("paste", handleGlobalPaste);
    return () => window.removeEventListener("paste", handleGlobalPaste);
  }, [activeCollection, activeFolder, activeLibraryId]);

  useEffect(() => {
    const existingAssetIds = new Set(assets.map((asset) => asset.id));
    setSelectedAssetIds((current) => {
      const next = new Set(Array.from(current).filter((assetId) => existingAssetIds.has(assetId)));
      return next.size === current.size ? current : next;
    });
    setAssetRangeAnchorId((current) => (current && existingAssetIds.has(current) ? current : ""));
  }, [assets]);

  useEffect(() => {
    if (activeBoard) return;
    const fallbackBoardId = boards[0]?.id ?? "";
    setActiveBoardId(fallbackBoardId);
    setFloatingTargetId(fallbackBoardId);
  }, [activeBoard, boards]);

  useEffect(() => {
    let mounted = true;
    const activatePromise = window.referenceBoard?.activateLibrary
      ? window.referenceBoard.activateLibrary(activeLibrary)
      : window.referenceBoard?.getLibraryRoot?.(activeLibrary?.id);
    activatePromise?.then((rootPath) => {
      if (!mounted || typeof rootPath !== "string") return;
      setLibraryRoot(rootPath);
      if (activeLibrary && activeLibrary.root !== rootPath) {
        setLibraries((current) =>
          normalizeLibraries(current).map((library) => (library.id === activeLibrary.id ? { ...library, root: rootPath } : library)),
        );
      }
    });
    return () => {
      mounted = false;
    };
  }, [activeLibrary, setLibraries]);

  useEffect(() => {
    const handleWheel = (event) => {
      if (!event.ctrlKey || !event.target.closest?.(".asset-panel")) return;
      event.preventDefault();
      changeAssetGridScale(event.deltaY > 0 ? -0.08 : 0.08);
    };

    window.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    return () => window.removeEventListener("wheel", handleWheel, { capture: true });
  }, []);

  useEffect(() => {
    const handleAssetPanelKeyDown = (event) => {
      if (nameDialog || confirmDialog || previewAssetId || isTextEditingTarget(event.target)) return;
      const targetInAssetPanel = Boolean(event.target?.closest?.(".asset-panel"));
      const focusInAssetPanel = Boolean(document.activeElement?.closest?.(".asset-panel"));
      if (!targetInAssetPanel && !focusInAssetPanel) return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        event.stopImmediatePropagation();
        selectAllFilteredAssets();
        return;
      }

      if ((event.key === "Delete" || event.key === "Backspace") && selectedAssetIds.size > 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        confirmDeleteSelectedAssets();
        return;
      }

      if (event.code === "Space" && !event.ctrlKey && !event.metaKey && !event.altKey && selectedAsset) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPreviewAssetId(selectedAsset.id);
        setSelectedAssetId(selectedAsset.id);
        setSelectedBoardItemId("");
      }
    };

    window.addEventListener("keydown", handleAssetPanelKeyDown);
    return () => window.removeEventListener("keydown", handleAssetPanelKeyDown);
  }, [confirmDialog, filteredAssets, multiSelectMode, nameDialog, previewAssetId, selectedAsset, selectedAssetIds, viewMode]);

  useEffect(() => {
    if (!dragState) return undefined;

    const scheduledMove = createPointerMoveScheduler(moveDraggedItem);
    const move = (event) => scheduledMove.move(event);
    const stop = () => {
      scheduledMove.flush();
      setDragState(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("mouseup", stop);

    return () => {
      scheduledMove.cancel();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("mouseup", stop);
    };
  }, [activeBoardId, dragState, zoom]);

  function showToast(message) {
    setToast(message);
  }

  function movePreviewAsset(direction) {
    if (!previewAsset || previewAssets.length === 0) return;
    const currentIndex = previewAssets.findIndex((asset) => asset.id === previewAsset.id);
    const normalizedIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (normalizedIndex + direction + previewAssets.length) % previewAssets.length;
    const nextAsset = previewAssets[nextIndex];
    if (nextAsset) {
      setPreviewAssetId(nextAsset.id);
      setSelectedAssetId(nextAsset.id);
      setSelectedBoardItemId("");
    }
  }

  function handlePreviewWheel(event) {
    if (!previewAsset || isAssetVideo(previewAsset)) return;
    event.preventDefault();
    event.stopPropagation();

    const rect = previewStageRef.current?.getBoundingClientRect();
    if (!rect) return;

    const currentZoom = previewZoom;
    const zoomFactor = event.deltaY > 0 ? 0.86 : 1.16;
    const nextZoom = clampNumber(Number((currentZoom * zoomFactor).toFixed(3)), 1, 16);

    if (nextZoom === currentZoom) return;
    if (nextZoom <= 1) {
      setPreviewZoom(1);
      setPreviewOffset({ x: 0, y: 0 });
      return;
    }

    const stageSize = previewStageSize.width > 0 && previewStageSize.height > 0 ? previewStageSize : rect;
    const stageCenterX = rect.left + rect.width / 2;
    const stageCenterY = rect.top + rect.height / 2;
    const baseX = (event.clientX - stageCenterX - previewOffset.x) / currentZoom;
    const baseY = (event.clientY - stageCenterY - previewOffset.y) / currentZoom;
    const nextOffset = {
      x: event.clientX - stageCenterX - baseX * nextZoom,
      y: event.clientY - stageCenterY - baseY * nextZoom,
    };

    setPreviewZoom(nextZoom);
    setPreviewOffset(clampPreviewOffset(nextOffset, nextZoom, stageSize, previewFitSize));
  }

  function startPreviewPan(event) {
    if (!previewAsset || isAssetVideo(previewAsset) || previewZoom <= 1 || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setPreviewPanState({
      startX: event.clientX,
      startY: event.clientY,
      originX: previewOffset.x,
      originY: previewOffset.y,
    });
  }

  function togglePreviewZoom(event) {
    if (!previewAsset || isAssetVideo(previewAsset)) return;
    event.preventDefault();
    event.stopPropagation();

    if (previewZoom !== 1) {
      setPreviewZoom(1);
      setPreviewOffset({ x: 0, y: 0 });
      return;
    }

    const rect = previewStageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const stageSize = previewStageSize.width > 0 && previewStageSize.height > 0 ? previewStageSize : rect;
    const nextZoom = 2.4;
    const stageCenterX = rect.left + rect.width / 2;
    const stageCenterY = rect.top + rect.height / 2;
    const baseX = (event.clientX - stageCenterX - previewOffset.x) / previewZoom;
    const baseY = (event.clientY - stageCenterY - previewOffset.y) / previewZoom;
    const nextOffset = {
      x: event.clientX - stageCenterX - baseX * nextZoom,
      y: event.clientY - stageCenterY - baseY * nextZoom,
    };
    setPreviewZoom(nextZoom);
    setPreviewOffset(clampPreviewOffset(nextOffset, nextZoom, stageSize, previewFitSize));
  }

  async function chooseLibraryRoot() {
    setLibrarySwitcherMenu(null);
    if (!window.referenceBoard?.chooseLibraryRoot) {
      showToast("素材库路径设置需要在桌面版里使用");
      return null;
    }

    const result = await window.referenceBoard.chooseLibraryRoot(activeLibraryId);
    if (!result || result.canceled) return result;
    setLibraryRoot(result.libraryRoot || "");
    setLibraries((current) =>
      normalizeLibraries(current).map((library) => (library.id === activeLibraryId ? { ...library, root: result.libraryRoot || "" } : library)),
    );
    showToast(`已更新“${activeLibrary?.name || "当前库"}”的保存位置`);
    return result;
  }

  function updateActiveLibraryImportMode(importMode) {
    const normalizedMode = importMode === "reference" ? "reference" : "copy";
    setLibraries((current) =>
      normalizeLibraries(current).map((library) => (library.id === activeLibraryId ? { ...library, importMode: normalizedMode } : library)),
    );
    showToast(normalizedMode === "reference" ? "本机文件将使用引用方式导入" : "本机文件将复制副本到素材库");
  }

  async function chooseOnboardingLibraryRoot() {
    const result = await chooseLibraryRoot();
    if (result?.libraryRoot) setLibraryRoot(result.libraryRoot);
  }

  function finishOnboarding(event) {
    event.preventDefault();
    const name = sanitizeName(onboardingName) || "我的素材库";
    setLibraries((current) =>
      normalizeLibraries(current).map((library, index) =>
        index === 0 ? { ...library, name, importMode: onboardingImportMode === "reference" ? "reference" : "copy", root: libraryRoot || library.root } : library,
      ),
    );
    setOnboardingComplete(true);
    showToast(`已创建素材库“${name}”`);
  }

  function updateAsset(assetId, patch) {
    setAssets((current) => current.map((asset) => (asset.id === assetId ? { ...asset, ...patch } : asset)));
  }

  function updateAssetsByIds(assetIds, patchOrUpdater) {
    const idSet = new Set(Array.from(assetIds ?? []).filter(Boolean));
    if (idSet.size === 0) return;
    setAssets((current) =>
      current.map((asset) => {
        if (!idSet.has(asset.id)) return asset;
        const patch = typeof patchOrUpdater === "function" ? patchOrUpdater(asset) : patchOrUpdater;
        return { ...asset, ...patch };
      }),
    );
  }

  function moveAssetsToFolder(assetIds, folder) {
    const targetFolder = normalizeFolderPath(folder);
    const ids = Array.from(new Set(Array.from(assetIds ?? []).filter(Boolean)));
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    setAssets((current) => current.map((asset) => (idSet.has(asset.id) ? { ...asset, folder: targetFolder } : asset)));
    setSelectedAssetId(ids[0]);
    showToast(ids.length > 1 ? `已移动 ${ids.length} 个素材到「${targetFolder}」` : `已移动到「${targetFolder}」`);
  }

  function scheduleAssetColorAnalysis(asset, imageElement) {
    const hasColorInfo =
      asset.dominantColor &&
      Array.isArray(asset.colorGroups) &&
      asset.colorGroups.length > 0 &&
      Array.isArray(asset.colorPalette) &&
      asset.colorPalette.length > 0;
    if (hasColorInfo || pendingColorAnalysisAssetIds.has(asset.id)) return;

    pendingColorAnalysisAssetIds.add(asset.id);
    const analyze = () => {
      const colorInfo = analyzeImageColor(imageElement);
      pendingColorAnalysisAssetIds.delete(asset.id);
      if (colorInfo) updateAsset(asset.id, colorInfo);
    };
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(analyze, { timeout: 1400 });
    } else {
      window.setTimeout(analyze, 120);
    }
  }

  function syncAssetDimensions(asset, imageElement) {
    const naturalWidth = imageElement?.naturalWidth;
    const naturalHeight = imageElement?.naturalHeight;
    if (!(naturalWidth > 0) || !(naturalHeight > 0)) return;
    const patch = {};

    if (asset.pixelWidth !== naturalWidth || asset.pixelHeight !== naturalHeight) {
      patch.pixelWidth = naturalWidth;
      patch.pixelHeight = naturalHeight;
      patch.dimensions = `${naturalWidth} x ${naturalHeight}`;
    }

    if (Object.keys(patch).length > 0) updateAsset(asset.id, patch);
    scheduleAssetColorAnalysis(asset, imageElement);
  }

  function syncAssetVideoDimensions(asset, videoElement) {
    const naturalWidth = videoElement?.videoWidth;
    const naturalHeight = videoElement?.videoHeight;
    if (!(naturalWidth > 0) || !(naturalHeight > 0)) return;
    if (asset.pixelWidth === naturalWidth && asset.pixelHeight === naturalHeight) return;
    updateAsset(asset.id, {
      pixelWidth: naturalWidth,
      pixelHeight: naturalHeight,
      dimensions: `${naturalWidth} x ${naturalHeight}`,
    });
  }

  function updateBoardItem(itemId, patch) {
    setBoardItems((current) => ({
      ...current,
      [activeBoardId]: (current[activeBoardId] ?? []).map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
    }));
  }

  function requestConfirm({ title, message, confirmLabel = "确认", onConfirm }) {
    setConfirmDialog({ title, message, confirmLabel, onConfirm });
  }

  function closeConfirmDialog() {
    setConfirmDialog(null);
  }

  function submitConfirmDialog() {
    if (!confirmDialog) return;
    confirmDialog.onConfirm?.();
    closeConfirmDialog();
  }

  function switchLibrary(libraryId) {
    if (!libraryId || libraryId === activeLibraryId) return;
    setLibrarySwitcherMenu(null);
    setActiveLibraryId(libraryId);
    setActiveCollection("all");
    setActiveFolder("");
    setColorFilter("all");
    setSelectedAssetId("");
    setSelectedBoardItemId("");
    setSelectedAssetIds(new Set());
    setAssetRangeAnchorId("");
    setPreviewAssetId("");
    setBoardManagerOpen(false);
  }

  function createLibrary() {
    setLibrarySwitcherMenu(null);
    setNameInput("");
    setNameDialog({
      type: "library",
      title: "新建素材库",
      label: "素材库名称",
      placeholder: "例如：角色项目、场景参考、商业项目",
    });
  }

  function renameActiveLibrary() {
    if (!activeLibrary) return;
    setLibrarySwitcherMenu(null);
    setNameInput(activeLibrary.name);
    setNameDialog({
      type: "library-rename",
      libraryId: activeLibrary.id,
      title: "重命名素材库",
      label: "素材库名称",
      placeholder: "例如：角色项目、场景参考、商业项目",
    });
  }

  function deleteLibrary(libraryId) {
    setLibrarySwitcherMenu(null);
    const target = libraries.find((library) => library.id === libraryId);
    if (!target || libraries.length <= 1) {
      showToast("至少保留一个素材库");
      return;
    }
    requestConfirm({
      title: "删除素材库",
      message: `删除“${target.name}”只会从软件列表移除这个库，不会删除磁盘上的图片文件。`,
      confirmLabel: "删除库",
      onConfirm: () => {
        const nextLibraries = libraries.filter((library) => library.id !== libraryId);
        setLibraries(nextLibraries);
        if (activeLibraryId === libraryId) setActiveLibraryId(nextLibraries[0]?.id ?? defaultLibraryId);
        showToast(`已删除素材库“${target.name}”`);
      },
    });
  }

  function showLibrarySwitcherMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    setBoardMenu(null);
    setAssetMenu(null);
    setLibraryMenu(null);
    setLibrarySwitcherMenu({ x: event.clientX, y: event.clientY });
  }

  function createFolder(parentFolder = "") {
    const normalizedParent = normalizeFolderPath(typeof parentFolder === "string" ? parentFolder : "");
    setNameInput("");
    setNameDialog({
      type: "folder",
      parentFolder: normalizedParent,
      title: normalizedParent ? `新建子分类：${folderLeafName(normalizedParent)}` : "新建分类",
      label: normalizedParent ? "子分类名称" : "分类名称",
      placeholder: normalizedParent ? "例如：森林、道具、灯光" : "例如：角色、场景、材质",
    });
  }

  function toggleFolderCollapsed(folder, event) {
    event?.preventDefault();
    event?.stopPropagation();
    const normalizedFolder = normalizeFolderPath(folder);
    if (!normalizedFolder || !foldersWithChildren.has(normalizedFolder)) return;
    setCollapsedFolders((current) => {
      const currentList = Array.isArray(current) ? current : [];
      if (currentList.includes(normalizedFolder)) return currentList.filter((item) => item !== normalizedFolder);
      return [...currentList, normalizedFolder];
    });
  }

  function createBoard() {
    setNameInput("");
    setNameDialog({ type: "board", title: "新建白板", label: "白板名称", placeholder: "例如：角色参考、场景推敲" });
  }

  async function saveActiveBoardFile() {
    if (!activeBoard) {
      showToast("当前没有可保存的白板");
      return;
    }
    if (!window.referenceBoard?.saveBoardFile) {
      showToast("另存白板文件需要在桌面版里使用");
      return;
    }

    const referencedAssetIds = new Set(activeItems.map((item) => item.assetId).filter(Boolean));
    const referencedAssets = assets.filter((asset) => referencedAssetIds.has(asset.id));
    const result = await window.referenceBoard.saveBoardFile({
      board: activeBoard,
      items: activeItems,
      assets: referencedAssets,
    });
    if (!result || result.canceled) return;
    if (!result.ok) {
      showToast(result.reason || "保存白板文件失败");
      return;
    }

    const warnings = [];
    if (result.missingVideoCount > 0) warnings.push(`${result.missingVideoCount} 个视频未能打包`);
    if (result.missingImageCount > 0) warnings.push(`${result.missingImageCount} 张图片未能打包`);
    showToast(warnings.length > 0 ? `白板已保存；${warnings.join("，")}` : "白板文件已保存");
  }

  function applyOpenedBoardResult(result) {
    if (!result || result.canceled) return;
    if (!result.ok || !result.board) {
      showToast(result.reason || "打开白板文件失败");
      return;
    }

    const baseName = String(result.board.name || "导入白板").trim() || "导入白板";
    const existingNames = new Set(boardsRef.current.map((board) => board.name));
    let importedName = baseName;
    let suffix = 2;
    while (existingNames.has(importedName)) {
      importedName = `${baseName} (${suffix})`;
      suffix += 1;
    }

    const importedBoard = {
      ...result.board,
      name: importedName,
      tone: result.board.tone || boardTones[boardsRef.current.length % boardTones.length],
    };
    const importedItems = Array.isArray(result.items) ? result.items : [];
    const importedAssets = Array.isArray(result.assets) ? result.assets : [];

    setAssets((current) => [...importedAssets, ...current]);
    setBoards((current) => {
      const next = [...current, importedBoard];
      boardsRef.current = next;
      return next;
    });
    setBoardItems((current) => ({ ...current, [importedBoard.id]: importedItems }));
    setActiveBoardId(importedBoard.id);
    setFloatingTargetId(importedBoard.id);
    setActiveCollection("board-assets");
    setActiveFolder("");
    setSelectedBoardItemId(importedItems[0]?.id || "");
    setSelectedAssetId(importedAssets[0]?.id || "");
    setBoardSelectionRequest(
      importedItems.length > 0
        ? {
            boardId: importedBoard.id,
            itemIds: importedItems.map((item) => item.id),
            fitItems: true,
            token: Date.now(),
          }
        : null,
    );
    setViewMode("split");

    const warnings = [];
    if (result.missingVideoCount > 0) warnings.push(`${result.missingVideoCount} 个视频需重新定位`);
    if (result.missingImageCount > 0) warnings.push(`${result.missingImageCount} 张图片缺失`);
    showToast(warnings.length > 0 ? `已打开「${importedName}」；${warnings.join("，")}` : `已打开白板「${importedName}」`);
  }

  async function openBoardFile() {
    if (!window.referenceBoard?.openBoardFile) {
      showToast("打开白板文件需要在桌面版里使用");
      return;
    }

    const result = await window.referenceBoard.openBoardFile();
    applyOpenedBoardResult(result);
  }

  function addTagToSelectedAsset() {
    if (isBulkAssetEditing) {
      setNameInput("");
      setNameDialog({
        type: "bulk-tag",
        assetIds: Array.from(selectedAssetIds),
        title: "批量新建标签",
        label: "标签名称",
        placeholder: "例如：侧光、剪影、蓝色",
      });
      return;
    }
    if (!inspectorAsset) {
      showToast("先选择一个素材，再添加标签");
      return;
    }
    setNameInput("");
    setNameDialog({
      type: "tag",
      assetId: inspectorAsset.id,
      title: "新建标签",
      label: "标签名称",
      placeholder: "例如：侧光、剪影、蓝色",
    });
  }

  function closeNameDialog() {
    setNameDialog(null);
    setNameInput("");
  }

  function updateSelectedAssetsFolder(folder) {
    if (!isBulkAssetEditing) return;
    const ids = Array.from(selectedAssetIds);
    const targetFolder = normalizeFolderPath(folder);
    updateAssetsByIds(ids, { folder: targetFolder });
    if (targetFolder) setFolders((current) => sortFoldersByHierarchy([...current, targetFolder]));
    showToast(`已更新 ${ids.length} 个素材的分类`);
  }

  function updateSelectedAssetsNote(note) {
    if (!isBulkAssetEditing) return;
    updateAssetsByIds(selectedAssetIds, { note });
  }

  function addExistingTagToSelectedAssets(tag) {
    if (!isBulkAssetEditing || !tag) return;
    const ids = Array.from(selectedAssetIds);
    updateAssetsByIds(ids, (asset) => ({
      tags: asset.tags.includes(tag) ? asset.tags : [...asset.tags, tag],
    }));
    setSelectedTagFilters((current) => (Array.isArray(current) && current.includes(tag) ? current : [...(Array.isArray(current) ? current : []), tag]));
    showToast(`已给 ${ids.length} 个素材添加标签「${tag}」`);
  }

  function removeTagFromSelectedAssets(tag) {
    if (!isBulkAssetEditing || !tag) return;
    const ids = Array.from(selectedAssetIds);
    updateAssetsByIds(ids, (asset) => ({ tags: asset.tags.filter((item) => item !== tag) }));
    showToast(`已从 ${ids.length} 个素材移除标签「${tag}」`);
  }

  async function submitNameDialog(event) {
    event.preventDefault();
    if (!nameDialog) return;

    const name = sanitizeName(nameInput);
    if (!name) return;

    if (nameDialog.type === "library") {
      if (libraries.some((library) => library.name === name)) {
        showToast("这个素材库已经存在");
        return;
      }

      const libraryId = `library-${Date.now()}`;
      const nextLibrary = { id: libraryId, name, root: "", importMode: "copy" };
      setLibraries((current) => [...normalizeLibraries(current), nextLibrary]);
      setActiveLibraryId(libraryId);
      setActiveCollection("all");
      setActiveFolder("");
      setSelectedAssetId("");
      setSelectedBoardItemId("");
      setSelectedAssetIds(new Set());
      showToast(`已新建素材库“${name}”`);
      closeNameDialog();
      return;
    }

    if (nameDialog.type === "library-rename") {
      if (libraries.some((library) => library.id !== nameDialog.libraryId && library.name === name)) {
        showToast("这个素材库已经存在");
        return;
      }

      setLibraries((current) => normalizeLibraries(current).map((library) => (library.id === nameDialog.libraryId ? { ...library, name } : library)));
      showToast(`已重命名素材库“${name}”`);
      closeNameDialog();
      return;
    }

    if (nameDialog.type === "folder") {
      const folderName = normalizeFolderPath(childFolderPath(nameDialog.parentFolder, name));
      if (folders.includes(folderName)) {
        showToast("这个分类已经存在");
        return;
      }

      setFolders((current) => sortFoldersByHierarchy([...current, folderName]));
      if (nameDialog.parentFolder) {
        setCollapsedFolders((current) => (Array.isArray(current) ? current : []).filter((folder) => folder !== nameDialog.parentFolder));
      }
      setActiveCollection("folder");
      setActiveFolder(folderName);
      showToast(`已新建分类「${folderName}」`);
      closeNameDialog();
      return;
    }

    if (nameDialog.type === "board") {
      if (boards.some((board) => board.name === name)) {
        showToast("这个白板已经存在");
        return;
      }

      const boardId = `b-${Date.now()}`;
      const nextBoard = {
        id: boardId,
        name,
        tone: boardTones[boards.length % boardTones.length],
      };

      setBoards((current) => [...current, nextBoard]);
      setBoardItems((current) => ({ ...current, [boardId]: [] }));
      setActiveBoardId(boardId);
      setFloatingTargetId(boardId);
      setSelectedBoardItemId("");
      showToast(`已新建白板「${name}」`);
      closeNameDialog();
      return;
    }

    if (nameDialog.type === "board-rename") {
      if (boards.some((board) => board.id !== nameDialog.boardId && board.name === name)) {
        showToast("这个白板已经存在");
        return;
      }

      setBoards((current) => current.map((board) => (board.id === nameDialog.boardId ? { ...board, name } : board)));
      showToast(`已重命名白板「${name}」`);
      closeNameDialog();
      return;
    }

    if (nameDialog.type === "bulk-tag") {
      const ids = Array.from(new Set(nameDialog.assetIds ?? Array.from(selectedAssetIds))).filter((assetId) => assetById.has(assetId));
      if (ids.length === 0) {
        closeNameDialog();
        return;
      }
      updateAssetsByIds(ids, (asset) => ({
        tags: asset.tags.includes(name) ? asset.tags : [...asset.tags, name],
      }));
      setSelectedTagFilters((current) => (Array.isArray(current) && current.includes(name) ? current : [...(Array.isArray(current) ? current : []), name]));
      showToast(`已给 ${ids.length} 个素材添加标签「${name}」`);
      closeNameDialog();
      return;
    }

    if (nameDialog.type === "asset-rename") {
      const targetAsset = assetById.get(nameDialog.assetId);
      if (!targetAsset) return;

      if (!targetAsset.source || !window.referenceBoard?.renameLibraryAsset) {
        showToast("只有已复制到软件素材库的资产可以重命名文件");
        closeNameDialog();
        return;
      }

      const result = await window.referenceBoard.renameLibraryAsset(targetAsset.source, name);
      if (!result?.ok || !result.asset) {
        showToast("这个素材没有可重命名的库内副本");
        closeNameDialog();
        return;
      }

      updateAsset(targetAsset.id, result.asset);
      setSelectedAssetId(targetAsset.id);
      showToast(`已重命名为「${result.asset.title}」`);
      closeNameDialog();
      return;
    }

    const targetAsset = assetById.get(nameDialog.assetId) ?? inspectorAsset;
    if (!targetAsset) return;
    const nextTags = targetAsset.tags.includes(name) ? targetAsset.tags : [...targetAsset.tags, name];
    updateAsset(targetAsset.id, { tags: nextTags });
    setSelectedAssetId(targetAsset.id);
    setSelectedTagFilters((current) => (Array.isArray(current) && current.includes(name) ? current : [...(Array.isArray(current) ? current : []), name]));
    showToast(`已给「${targetAsset.title}」添加标签「${name}」`);
    closeNameDialog();
  }

  function addExistingTagToSelectedAsset(tag) {
    if (!inspectorAsset || !tag || inspectorAsset.tags.includes(tag)) return;
    updateAsset(inspectorAsset.id, { tags: [...inspectorAsset.tags, tag] });
    setSelectedAssetId(inspectorAsset.id);
    showToast(`已添加标签「${tag}」`);
  }

  function removeTagFromSelectedAsset(tag) {
    if (!inspectorAsset) return;
    updateAsset(inspectorAsset.id, { tags: inspectorAsset.tags.filter((item) => item !== tag) });
    showToast(`已移除标签「${tag}」`);
  }

  function deleteTag(tag) {
    setAssets((current) =>
      current.map((asset) => (asset.tags.includes(tag) ? { ...asset, tags: asset.tags.filter((item) => item !== tag) } : asset)),
    );
    if (query === tag) setQuery("");
    setSelectedTagFilters((current) => (Array.isArray(current) ? current.filter((item) => item !== tag) : []));
    showToast(`已删除标签「${tag}」`);
  }

  function toggleTagFilter(tag) {
    setSelectedTagFilters((current) => {
      const currentList = Array.isArray(current) ? current : [];
      return currentList.includes(tag) ? currentList.filter((item) => item !== tag) : [...currentList, tag];
    });
  }

  function clearTagFilters() {
    setSelectedTagFilters([]);
  }

  function confirmDeleteTag(tag) {
    const taggedCount = assets.filter((asset) => asset.tags.includes(tag)).length;
    requestConfirm({
      title: "删除标签",
      message: `确定删除「${tag}」标签吗？它会从 ${taggedCount} 个素材上移除，素材本身不会删除。`,
      confirmLabel: "删除标签",
      onConfirm: () => deleteTag(tag),
    });
  }

  function deleteFolder(folder) {
    const nextFolders = folders.filter((item) => !folderContainsAsset(folder, item));
    setFolders(nextFolders);
    setCollapsedFolders((current) => (Array.isArray(current) ? current : []).filter((item) => !folderContainsAsset(folder, item)));
    setAssets((current) => current.map((asset) => (folderContainsAsset(folder, asset.folder) ? { ...asset, folder: "" } : asset)));
    if (folderContainsAsset(folder, activeFolder)) {
      setActiveCollection("unsorted");
      setActiveFolder(nextFolders[0] ?? "");
    }
    showToast(`已删除分类「${folder}」，其中素材已转为未分类`);
  }

  function confirmDeleteFolder(folder) {
    const childCount = folders.filter((item) => item !== folder && folderContainsAsset(folder, item)).length;
    const assetCount = assets.filter((asset) => folderContainsAsset(folder, asset.folder)).length;
    requestConfirm({
      title: "删除分类",
      message: `确定删除「${folder}」分类吗？${childCount > 0 ? `它下面的 ${childCount} 个子分类也会删除，` : ""}其中 ${assetCount} 个素材会转到「未分类」，素材本身不会删除。`,
      confirmLabel: "删除分类",
      onConfirm: () => deleteFolder(folder),
    });
  }

  function deleteBoard(boardId) {
    const nextBoards = boards.filter((board) => board.id !== boardId);
    setBoards(nextBoards);
    setBoardItems((current) => {
      const nextItems = { ...current };
      delete nextItems[boardId];
      return nextItems;
    });

    if (activeBoardId === boardId) {
      const fallbackBoardId = nextBoards[0]?.id ?? "";
      setActiveBoardId(fallbackBoardId);
      setFloatingTargetId(fallbackBoardId);
      setSelectedBoardItemId("");
    }
    showToast("已删除白板");
  }

  function showBoardMenu(event, board) {
    event.preventDefault();
    setAssetMenu(null);
    setLibraryMenu(null);
    setLibrarySwitcherMenu(null);
    setBoardMenu({ x: event.clientX, y: event.clientY, boardId: board.id });
  }

  function startRenameBoard(board) {
    setNameInput(board.name);
    setNameDialog({
      type: "board-rename",
      boardId: board.id,
      title: "重命名白板",
      label: "白板名称",
      placeholder: "例如：角色参考、场景推敲",
    });
    setBoardMenu(null);
    setBoardManagerOpen(false);
  }

  function confirmDeleteBoard(board) {
    setBoardMenu(null);
    setBoardManagerOpen(false);
    requestConfirm({
      title: "删除白板",
      message: `确定删除「${board.name}」白板吗？白板上的布局会移除，素材库图片不会删除。`,
      confirmLabel: "删除白板",
      onConfirm: () => deleteBoard(board.id),
    });
  }

  function selectBoardFromManager(boardId) {
    setActiveBoardId(boardId);
    setFloatingTargetId(boardId);
    setSelectedBoardItemId("");
    setBoardManagerOpen(false);
  }

  function getBoardPreviewAssets(boardId) {
    return (boardItems[boardId] ?? [])
      .filter((item) => item.assetId)
      .slice(0, 4)
      .map((item) => assetById.get(item.assetId))
      .filter(Boolean);
  }

  async function deleteAssetsByIds(assetIds) {
    const requestedIds = new Set(Array.from(assetIds ?? []).filter(Boolean));
    if (requestedIds.size === 0) return;
    const targetAssets = assets.filter((asset) => requestedIds.has(asset.id));
    if (targetAssets.length === 0) return;

    const retainedFileKeys = new Set(
      assets
        .filter((asset) => !requestedIds.has(asset.id))
        .map(assetLibraryFilePath)
        .filter(Boolean)
        .map(localFilePathKey),
    );
    const libraryFilePaths = Array.from(
      new Map(
        targetAssets
          .map(assetLibraryFilePath)
          .filter((filePath) => filePath && !retainedFileKeys.has(localFilePathKey(filePath)))
          .map((filePath) => [localFilePathKey(filePath), filePath]),
      ).values(),
    );

    let fileResult = null;
    if (libraryFilePaths.length > 0 && window.referenceBoard?.deleteLibraryFiles) {
      try {
        fileResult = await window.referenceBoard.deleteLibraryFiles(libraryFilePaths, activeLibraryId);
      } catch {
        fileResult = {
          deleted: [],
          missing: [],
          failed: libraryFilePaths.map((filePath) => ({ filePath, reason: "delete-failed" })),
        };
      }
    }

    const completedFileKeys = new Set(
      [...(fileResult?.deleted ?? []), ...(fileResult?.missing ?? [])].map(localFilePathKey),
    );
    const deletingIds = new Set(
      targetAssets
        .filter((asset) => {
          const filePath = assetLibraryFilePath(asset);
          if (!filePath || retainedFileKeys.has(localFilePathKey(filePath)) || !window.referenceBoard?.deleteLibraryFiles) return true;
          return completedFileKeys.has(localFilePathKey(filePath));
        })
        .map((asset) => asset.id),
    );
    if (deletingIds.size === 0) {
      showToast("本地库文件删除失败，素材已保留在垃圾桶");
      return;
    }

    const nextAssets = assets.filter((asset) => !deletingIds.has(asset.id));
    setAssets(nextAssets);
    setBoardItems((current) =>
      Object.fromEntries(
        Object.entries(current).map(([boardId, items]) => [boardId, items.filter((item) => !deletingIds.has(item.assetId))]),
      ),
    );
    setSelectedAssetId((current) => (deletingIds.has(current) ? (nextAssets[0]?.id ?? "") : current));
    setSelectedAssetIds((current) => new Set(Array.from(current).filter((assetId) => !deletingIds.has(assetId))));
    if (selectedBoardAsset && deletingIds.has(selectedBoardAsset.id)) setSelectedBoardItemId("");
    setAssetMenu(null);

    const failedCount = targetAssets.length - deletingIds.size;
    const deletedFileCount = fileResult?.deleted?.length ?? 0;
    showToast(
      failedCount > 0
        ? `已彻底删除 ${deletingIds.size} 个素材和 ${deletedFileCount} 个库文件；${failedCount} 个文件删除失败`
        : `已彻底删除 ${deletingIds.size} 个素材${deletedFileCount > 0 ? `，并删除 ${deletedFileCount} 个库文件` : ""}`,
    );
  }

  function moveAssetsToTrash(assetIds) {
    const deletingIds = new Set(Array.from(assetIds ?? []).filter(Boolean));
    if (deletingIds.size === 0) return;
    const trashedAt = new Date().toISOString();
    const nextVisibleAssets = assets.filter((asset) => !deletingIds.has(asset.id) && !isAssetTrashed(asset));

    setAssets((current) =>
      current.map((asset) => (deletingIds.has(asset.id) ? { ...asset, trashedAt } : asset)),
    );
    setBoardItems((current) =>
      Object.fromEntries(
        Object.entries(current).map(([boardId, items]) => [boardId, items.filter((item) => !deletingIds.has(item.assetId))]),
      ),
    );
    setSelectedAssetId((current) => (deletingIds.has(current) ? (nextVisibleAssets[0]?.id ?? "") : current));
    setSelectedAssetIds(new Set());
    setMultiSelectMode(false);
    if (selectedBoardAsset && deletingIds.has(selectedBoardAsset.id)) setSelectedBoardItemId("");
    showToast(`已将 ${deletingIds.size} 个素材移到垃圾桶`);
  }

  function restoreAssetsByIds(assetIds) {
    const restoringIds = new Set(Array.from(assetIds ?? []).filter(Boolean));
    if (restoringIds.size === 0) return;
    setAssets((current) =>
      current.map((asset) => {
        if (!restoringIds.has(asset.id)) return asset;
        const { trashedAt: _trashedAt, ...restoredAsset } = asset;
        return restoredAsset;
      }),
    );
    setSelectedAssetIds(new Set());
    setMultiSelectMode(false);
    setAssetMenu(null);
    showToast(`已恢复 ${restoringIds.size} 个素材`);
  }

  function deleteAssetById(assetId) {
    deleteAssetsByIds([assetId]);
  }

  function confirmDeleteAssets(assetIds) {
    const targetIds = Array.from(new Set(Array.from(assetIds ?? []).filter((assetId) => assetById.has(assetId))));
    const targetAssets = targetIds.map((assetId) => assetById.get(assetId)).filter(Boolean);
    if (targetAssets.length === 0) return;
    setAssetMenu(null);
    const targetLabel = targetAssets.length > 1 ? `选中的 ${targetAssets.length} 个素材` : `「${targetAssets[0].title}」`;
    const allTrashed = targetAssets.every(isAssetTrashed);
    if (allTrashed) {
      requestConfirm({
        title: "彻底删除素材",
        message: `确定彻底删除${targetLabel}吗？素材库目录中的本地副本也会同时删除，此操作不能撤销。`,
        confirmLabel: "彻底删除",
        onConfirm: () => deleteAssetsByIds(targetIds),
      });
      return;
    }
    requestConfirm({
      title: "移到垃圾桶",
      message: `确定将${targetLabel}移到垃圾桶吗？它们也会从所有白板中移除。`,
      confirmLabel: "移到垃圾桶",
      onConfirm: () => moveAssetsToTrash(targetIds),
    });
  }

  function confirmDeleteAsset(assetId) {
    confirmDeleteAssets([assetId]);
  }

  function showAssetMenu(event, asset) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget?.focus?.({ preventScroll: true });
    setBoardMenu(null);
    setLibraryMenu(null);
    setLibrarySwitcherMenu(null);
    const menuAssetIds = selectedAssetIds.has(asset.id) ? Array.from(selectedAssetIds) : [asset.id];
    if (!selectedAssetIds.has(asset.id) && selectedAssetIds.size > 0) {
      setSelectedAssetIds(new Set([asset.id]));
      setAssetRangeAnchorId(asset.id);
    }
    setSelectedAssetId(asset.id);
    setSelectedBoardItemId("");
    setAssetMenu({ x: event.clientX, y: event.clientY, assetId: asset.id, assetIds: menuAssetIds });
  }

  async function addBoardAssetsToLibrary(assetIds) {
    setAssetMenu(null);
    const targetAssets = Array.from(new Set(assetIds ?? []))
      .map((assetId) => assetById.get(assetId))
      .filter((asset) => isBoardFileAsset(asset) && !isAssetTrashed(asset) && asset?.source);
    if (targetAssets.length === 0 || !window.referenceBoard?.importImagePaths) {
      showToast("当前素材没有可入库的本地文件");
      return;
    }

    const importedAssets = [];
    for (const asset of targetAssets) {
      try {
        const result = await window.referenceBoard.importImagePaths([asset.source], "", "白板入库");
        const imported = result?.assets?.[0];
        if (!imported) continue;
        importedAssets.push({
          ...imported,
          title: asset.title || imported.title,
          originalSource: asset.originalSource || imported.originalSource,
          remoteSource: asset.remoteSource || "",
          note: asset.note || "从外部白板素材添加入库。",
          tags: (asset.tags ?? []).filter((tag) => tag !== "白板文件"),
          folder: "",
          boardFileAsset: false,
          importedFromBoard: false,
          boardFileSource: "",
        });
      } catch {
        // Continue importing the remaining selected board assets.
      }
    }
    if (importedAssets.length === 0) {
      showToast("素材入库失败，请确认原文件仍然存在");
      return;
    }

    const failedCount = targetAssets.length - importedAssets.length;
    addImportedAssets(
      importedAssets,
      "",
      failedCount > 0 ? `已添加入库，${failedCount} 个失败` : "已添加入库",
      { selectInLibrary: false },
    );
  }

  function showLibraryMenu(event) {
    if (event.target.closest?.(".asset-card, .sidebar-context-menu, button, input, select, textarea")) return;
    event.preventDefault();
    setBoardMenu(null);
    setAssetMenu(null);
    setLibrarySwitcherMenu(null);
    setLibraryMenu({ x: event.clientX, y: event.clientY });
  }

  function canRenameLibraryAsset(asset) {
    return Boolean(asset?.libraryCopy && asset?.source && !/^https?:\/\//i.test(asset.source));
  }

  function startRenameAsset(asset) {
    if (!canRenameLibraryAsset(asset)) {
      showToast("只有已复制到软件素材库的资产可以重命名文件");
      return;
    }

    setAssetMenu(null);
    cancelAssetRenameRef.current = false;
    setRenamingAssetId(asset.id);
    setRenameAssetInput(asset.title);
  }

  async function commitInlineAssetRename(asset) {
    if (cancelAssetRenameRef.current) {
      cancelAssetRenameRef.current = false;
      return;
    }

    const name = renameAssetInput.trim();
    setRenamingAssetId("");
    setRenameAssetInput("");
    if (!name || name === asset.title) return;

    if (!asset.source || !window.referenceBoard?.renameLibraryAsset) {
      showToast("只有已复制到软件素材库的资产可以重命名文件");
      return;
    }

    const result = await window.referenceBoard.renameLibraryAsset(asset.source, name);
    if (!result?.ok || !result.asset) {
      showToast("这个素材没有可重命名的库内副本");
      return;
    }

    updateAsset(asset.id, result.asset);
    setSelectedAssetId(asset.id);
    showToast(`已重命名为「${result.asset.title}」`);
  }

  async function locateAssetFile(asset) {
    setAssetMenu(null);
    const source = asset?.source || asset?.originalSource || "";
    if (/^https?:\/\//i.test(source)) {
      window.open(source, "_blank", "noopener,noreferrer");
      return;
    }
    const located = await window.referenceBoard?.showItemInFolder?.(source);
    if (!located) showToast("没有找到这个素材的本地副本");
  }

  async function locateOriginalSource(asset) {
    const originalSource = asset?.originalSource || asset?.remoteSource || "";
    if (!originalSource) {
      showToast("这个素材没有记录原始来源");
      return;
    }

    if (/^https?:\/\//i.test(originalSource)) {
      window.open(originalSource, "_blank", "noopener,noreferrer");
      return;
    }

    const located = await window.referenceBoard?.showItemInFolder?.(originalSource);
    if (!located) showToast("没有找到原始文件位置");
  }

  async function refreshAssetReferences(assetIds = null) {
    setAssetMenu(null);
    setLibraryMenu(null);
    const isFullRefresh = !assetIds;
    const targetIdSet = assetIds ? new Set(Array.from(assetIds).filter(Boolean)) : null;
    const targetAssets = assets.filter((asset) => !targetIdSet || targetIdSet.has(asset.id));
    const checkEntries = targetAssets
      .map((asset) => ({ asset, path: getAssetCheckPath(asset) }))
      .filter((entry) => entry.path);

    if (checkEntries.length === 0 && !isFullRefresh) {
      showToast("没有需要刷新的本地引用");
      return;
    }

    if (!window.referenceBoard?.resolveMediaReferences && !window.referenceBoard?.checkMediaPaths && !window.referenceBoard?.scanLibraryMedia) {
      showToast("刷新本地引用需要在桌面版里使用");
      return;
    }

    let nextAssets = assets;
    let relinkedCount = 0;
    let missingCount = 0;
    let addedCount = 0;

    if (checkEntries.length > 0) {
      if (window.referenceBoard?.resolveMediaReferences) {
        const result = await window.referenceBoard.resolveMediaReferences(
          checkEntries.map(({ asset, path }) => ({
            id: asset.id,
            path,
            mediaKind: isAssetVideo(asset) ? "video" : "image",
            title: asset.title,
            size: asset.size,
            pixelWidth: asset.pixelWidth,
            pixelHeight: asset.pixelHeight,
            folder: asset.folder,
            type: asset.type,
            note: asset.note,
            originalSource: asset.originalSource,
            referencedSource: Boolean(asset.referencedSource),
            boardFileAsset: isBoardFileAsset(asset),
          })),
        );
        const resolutionById = new Map((result?.items ?? []).filter((item) => item?.id).map((item) => [item.id, item]));

        nextAssets = nextAssets.map((asset) => {
          const resolution = resolutionById.get(asset.id);
          if (!resolution) return asset;
          if (resolution.status === "missing") {
            missingCount += 1;
            return asset;
          }
          const patch = { ...(resolution.patch ?? {}) };
          if (resolution.status === "relinked") relinkedCount += 1;

          const oldTitle = basenameWithoutExtension(getAssetCheckPath(asset)).toLowerCase();
          const currentTitle = String(asset.title || "").trim().toLowerCase();
          if (resolution.suggestedTitle && (!currentTitle || currentTitle === oldTitle)) {
            patch.title = resolution.suggestedTitle;
          }

          return Object.keys(patch).length > 0 ? { ...asset, ...patch } : asset;
        });
      } else if (window.referenceBoard?.checkMediaPaths) {
        const result = await window.referenceBoard.checkMediaPaths(checkEntries.map((entry) => entry.path));
        missingCount = checkEntries.filter((entry) => result?.[entry.path] === false).length;
      }
    }

    if (isFullRefresh && window.referenceBoard?.scanLibraryMedia) {
      const scanned = await window.referenceBoard.scanLibraryMedia();
      const knownPathKeys = new Set(nextAssets.flatMap(assetPathKeys));
      const newAssets = (scanned?.assets ?? []).filter((asset) => {
        const keys = assetPathKeys(asset);
        if (keys.length === 0 || keys.some((key) => knownPathKeys.has(key))) return false;
        keys.forEach((key) => knownPathKeys.add(key));
        return true;
      });

      if (newAssets.length > 0) {
        addedCount = newAssets.length;
        nextAssets = [...newAssets, ...nextAssets];
        setFolders((current) => sortFoldersByHierarchy([...current, ...newAssets.map((asset) => asset.folder).filter(Boolean)]));
      }
    }

    if (nextAssets !== assets) setAssets(nextAssets);

    const parts = [];
    if (relinkedCount > 0) parts.push(`重连 ${relinkedCount} 个`);
    if (addedCount > 0) parts.push(`新增 ${addedCount} 个`);
    if (missingCount > 0) parts.push(`${missingCount} 个仍未找到，已保留记录`);
    showToast(parts.length > 0 ? `刷新完成：${parts.join("，")}` : "刷新完成，素材库已是最新");
  }

  function toggleMultiSelectMode() {
    setMultiSelectMode((current) => {
      if (current) setSelectedAssetIds(new Set());
      return !current;
    });
    setAssetRangeAnchorId("");
  }

  function toggleAssetSelection(assetId) {
    setSelectedAssetIds((current) => {
      const next = new Set(current);
      if (next.has(assetId)) {
        next.delete(assetId);
      } else {
        next.add(assetId);
      }
      return next;
    });
    setAssetRangeAnchorId(assetId);
    setSelectedAssetId(assetId);
    setSelectedBoardItemId("");
  }

  function selectAssetRange(assetId, additive = false) {
    const assetIds = filteredAssets.map((asset) => asset.id);
    const targetIndex = assetIds.indexOf(assetId);
    if (targetIndex < 0) return;
    const anchorCandidate = assetRangeAnchorId && assetIds.includes(assetRangeAnchorId) ? assetRangeAnchorId : selectedAssetId;
    const anchorIndex = assetIds.includes(anchorCandidate) ? assetIds.indexOf(anchorCandidate) : targetIndex;
    const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
    const rangeIds = assetIds.slice(start, end + 1);
    setMultiSelectMode(true);
    setSelectedAssetIds((current) => {
      const next = additive ? new Set(current) : new Set();
      rangeIds.forEach((id) => next.add(id));
      return next;
    });
    setAssetRangeAnchorId(assetIds[anchorIndex] || assetId);
    setSelectedAssetId(assetId);
    setSelectedBoardItemId("");
  }

  function handleAssetCardClick(event, asset) {
    const modifier = selectionModifierFromEvent(event);
    if (modifier === "add") {
      selectAssetRange(asset.id, true);
      return;
    }
    if (modifier === "remove") {
      if (selectedAssetIds.has(asset.id)) toggleAssetSelection(asset.id);
      return;
    }
    if (multiSelectMode) {
      toggleAssetSelection(asset.id);
      return;
    }
    setSelectedAssetId(asset.id);
    setSelectedBoardItemId("");
    setAssetRangeAnchorId(asset.id);
    setSelectedAssetIds(new Set());
  }

  function selectAllFilteredAssets() {
    setSelectedAssetIds(new Set(filteredAssets.map((asset) => asset.id)));
    setMultiSelectMode(true);
    setAssetRangeAnchorId(filteredAssets[0]?.id ?? "");
  }

  function clearAssetSelection() {
    setSelectedAssetIds(new Set());
    setAssetRangeAnchorId("");
    setAssetSelectionBox(null);
  }

  function exitAssetMultiSelection() {
    clearAssetSelection();
    setMultiSelectMode(false);
  }

  function handleAssetPanelPointerDown(event) {
    if (event.button !== 0) return;
    if (event.target.closest?.(".asset-card, .panel-header, .color-filter-bar, button, input, label, select, textarea")) return;
    setAssetMenu(null);
    if (selectionModifierFromEvent(event) !== "replace") return;
    exitAssetMultiSelection();
  }

  function startAssetGridSelection(event) {
    if (event.button !== 0) return;
    if (event.target.closest?.(".asset-card, button, input, label, select, textarea")) return;

    const grid = event.currentTarget;
    grid.closest?.(".asset-panel")?.focus?.({ preventScroll: true });
    const startGridRect = grid.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startContentX = startX - startGridRect.left + grid.scrollLeft;
    const startContentY = startY - startGridRect.top + grid.scrollTop;
    const cardRects = Array.from(grid.querySelectorAll(".asset-card[data-asset-id]")).map((card) => {
      const rect = card.getBoundingClientRect();
      return {
        id: card.dataset.assetId,
        left: rect.left - startGridRect.left + grid.scrollLeft,
        top: rect.top - startGridRect.top + grid.scrollTop,
        width: rect.width,
        height: rect.height,
      };
    });
    const baseSelection = new Set(selectedAssetIds);
    let selecting = false;
    let currentClientX = startX;
    let currentClientY = startY;
    let autoScrollFrame = 0;
    const liveModifiers = { shiftKey: event.shiftKey, ctrlKey: event.ctrlKey || event.metaKey };

    setAssetMenu(null);

    const applySelection = (clientX, clientY) => {
      const gridRect = grid.getBoundingClientRect();
      const currentContentX = clientX - gridRect.left + grid.scrollLeft;
      const currentContentY = clientY - gridRect.top + grid.scrollTop;
      const left = Math.min(startContentX, currentContentX);
      const top = Math.min(startContentY, currentContentY);
      const right = Math.max(startContentX, currentContentX);
      const bottom = Math.max(startContentY, currentContentY);
      const viewportLeft = gridRect.left + left - grid.scrollLeft;
      const viewportTop = gridRect.top + top - grid.scrollTop;
      const viewportRight = gridRect.left + right - grid.scrollLeft;
      const viewportBottom = gridRect.top + bottom - grid.scrollTop;
      const clippedLeft = clampNumber(viewportLeft, gridRect.left, gridRect.right);
      const clippedTop = clampNumber(viewportTop, gridRect.top, gridRect.bottom);
      const clippedRight = clampNumber(viewportRight, gridRect.left, gridRect.right);
      const clippedBottom = clampNumber(viewportBottom, gridRect.top, gridRect.bottom);
      setAssetSelectionBox({
        left: clippedLeft,
        top: clippedTop,
        width: Math.max(0, clippedRight - clippedLeft),
        height: Math.max(0, clippedBottom - clippedTop),
      });

      const mode = selectionModifierFromEvent(liveModifiers);
      const hitIds = [];
      cardRects.forEach((card) => {
        const cardLeft = card.left;
        const cardTop = card.top;
        const cardRight = cardLeft + card.width;
        const cardBottom = cardTop + card.height;
        const intersects = cardLeft < right && cardRight > left && cardTop < bottom && cardBottom > top;
        if (intersects) hitIds.push(card.id);
      });
      const nextIds = combineSelection(baseSelection, hitIds, mode);

      setSelectedAssetIds(nextIds);
      if (mode === "replace") {
        const firstId = Array.from(nextIds)[0] ?? "";
        if (firstId) {
          setSelectedAssetId(firstId);
          setSelectedBoardItemId("");
          setAssetRangeAnchorId(firstId);
        }
      }
    };
    const scheduledSelection = createPointerMoveScheduler(applySelection);

    const autoScroll = () => {
      if (!selecting) return;
      const rect = grid.getBoundingClientRect();
      const edgeSize = Math.min(84, Math.max(48, rect.height * 0.12));
      let speed = 0;
      if (currentClientY < rect.top + edgeSize) {
        const strength = clampNumber((rect.top + edgeSize - currentClientY) / edgeSize, 0, 1);
        speed = -Math.max(3, Math.round(28 * strength * strength));
      } else if (currentClientY > rect.bottom - edgeSize) {
        const strength = clampNumber((currentClientY - (rect.bottom - edgeSize)) / edgeSize, 0, 1);
        speed = Math.max(3, Math.round(28 * strength * strength));
      }

      if (speed !== 0) {
        const previousScrollTop = grid.scrollTop;
        grid.scrollTop = clampNumber(grid.scrollTop + speed, 0, Math.max(0, grid.scrollHeight - grid.clientHeight));
        if (grid.scrollTop !== previousScrollTop) {
          applySelection(currentClientX, currentClientY);
          if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 420) {
            setAssetRenderLimit((current) => Math.min(filteredAssets.length, current + assetRenderBatchSize));
          }
        }
      }
      autoScrollFrame = window.requestAnimationFrame(autoScroll);
    };

    const move = (moveEvent) => {
      currentClientX = moveEvent.clientX;
      currentClientY = moveEvent.clientY;
      liveModifiers.shiftKey = moveEvent.shiftKey;
      liveModifiers.ctrlKey = moveEvent.ctrlKey || moveEvent.metaKey;
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!selecting && Math.hypot(dx, dy) > 4) {
        selecting = true;
        setMultiSelectMode(true);
        autoScrollFrame = window.requestAnimationFrame(autoScroll);
      }
      if (!selecting) return;
      moveEvent.preventDefault();
      scheduledSelection.move(moveEvent);
    };

    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("mouseup", stop);
      window.cancelAnimationFrame(autoScrollFrame);
      if (selecting) scheduledSelection.flush();
      else scheduledSelection.cancel();
      if (!selecting && selectionModifierFromEvent(liveModifiers) === "replace") {
        exitAssetMultiSelection();
      }
      setAssetSelectionBox(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("mouseup", stop);
  }

  function loadMoreAssetsOnScroll(event) {
    if (assetRenderLimit >= filteredAssets.length) return;
    const target = event.currentTarget;
    if (target.scrollTop + target.clientHeight < target.scrollHeight - 420) return;
    setAssetRenderLimit((current) => Math.min(filteredAssets.length, current + assetRenderBatchSize));
  }

  function confirmDeleteSelectedAssets() {
    confirmDeleteAssets(Array.from(selectedAssetIds));
  }

  function confirmEmptyTrash() {
    if (trashedAssets.length === 0) return;
    const libraryFileCount = new Set(trashedAssets.map(assetLibraryFilePath).filter(Boolean).map(localFilePathKey)).size;
    requestConfirm({
      title: "清空垃圾桶",
      message: `确定永久删除垃圾桶中的 ${trashedAssets.length} 个素材吗？${
        libraryFileCount > 0 ? `素材库目录中的 ${libraryFileCount} 个本地副本也会被删除。` : ""
      }此操作不能撤销。`,
      confirmLabel: "清空垃圾桶",
      onConfirm: () => deleteAssetsByIds(trashedAssets.map((asset) => asset.id)),
    });
  }

  async function appendAssetObjectsToBoard(targetAssets, options = {}) {
    if (!activeBoard) {
      showToast("请先新建一个白板");
      return [];
    }

    const uniqueAssets = Array.from(new Map((targetAssets ?? []).filter(Boolean).map((asset) => [asset.id, asset])).values());
    if (uniqueAssets.length === 0) return [];

    const preparedItems = [];
    for (const asset of uniqueAssets) {
      const storedDimensions = getStoredImageDimensions(asset);
      const loadedDimensions = storedDimensions ?? (await readAssetDimensions(asset));
      const nodeSize = fitImageNodeSize(loadedDimensions);

      if (loadedDimensions && !storedDimensions) {
        updateAsset(asset.id, {
          pixelWidth: loadedDimensions.width,
          pixelHeight: loadedDimensions.height,
          dimensions: `${loadedDimensions.width} x ${loadedDimensions.height}`,
        });
      }

      preparedItems.push({ asset, nodeSize });
    }

    const originX = Math.round(options.point?.x ?? 96 + ((activeItems.length * 42) % 260));
    const originY = Math.round(options.point?.y ?? 90 + ((activeItems.length * 34) % 180));
    let cursorX = originX;
    let cursorY = originY;
    let rowHeight = 0;
    const timestamp = Date.now();

    const nextItems = preparedItems.map(({ asset, nodeSize }, index) => {
      if (index > 0 && index % 3 === 0) {
        cursorX = originX;
        cursorY += rowHeight;
        rowHeight = 0;
      }
      const nextItem = {
        id: `i-${timestamp}-${index}-${asset.id}`,
        assetId: asset.id,
        x: Math.round(cursorX),
        y: Math.round(cursorY),
        width: nodeSize.width,
        height: nodeSize.height,
        note: options.note ?? "新发送",
      };
      cursorX += nodeSize.width;
      rowHeight = Math.max(rowHeight, nodeSize.height);
      return nextItem;
    });

    checkpointBoardItems(activeBoardId);
    setBoardItems((current) => ({
      ...current,
      [activeBoardId]: [...(current[activeBoardId] ?? []), ...nextItems],
    }));
    setSelectedAssetId(uniqueAssets[0].id);
    setSelectedBoardItemId(nextItems[0].id);
    setBoardSelectionRequest({ boardId: activeBoardId, itemIds: nextItems.map((item) => item.id), token: Date.now() });
    setSelectedAssetIds(new Set());
    setMultiSelectMode(false);
    if (options.message) showToast(options.message);
    return nextItems;
  }

  async function sendAssetsToBoard(assetIds) {
    if (!activeBoard) {
      showToast("请先新建一个白板");
      return;
    }

    const uniqueIds = Array.from(new Set(Array.from(assetIds ?? []).filter(Boolean)));
    if (uniqueIds.length === 0) {
      showToast("请先选择素材");
      return;
    }

    const existingByAssetId = new Map(activeItems.filter((item) => item.assetId).map((item) => [item.assetId, item]));
    const targetAssets = uniqueIds
      .map((assetId) => assetById.get(assetId))
      .filter(Boolean)
      .filter((asset) => !isAssetTrashed(asset))
      .filter((asset) => !existingByAssetId.has(asset.id));

    if (targetAssets.length === 0) {
      const existingAssetId = uniqueIds.find((assetId) => existingByAssetId.has(assetId));
      const existingItem = existingAssetId ? existingByAssetId.get(existingAssetId) : null;
      if (existingItem) {
        setSelectedBoardItemId(existingItem.id);
        setSelectedAssetId(existingAssetId);
      }
      showToast(uniqueIds.length > 1 ? "选中的素材已经在当前白板中" : "这个素材已经在当前白板中");
      return;
    }

    const preparedItems = [];
    for (const asset of targetAssets) {
      const storedDimensions = getStoredImageDimensions(asset);
      const loadedDimensions = storedDimensions ?? (await readAssetDimensions(asset));
      const nodeSize = fitImageNodeSize(loadedDimensions);

      if (loadedDimensions && !storedDimensions) {
        updateAsset(asset.id, {
          pixelWidth: loadedDimensions.width,
          pixelHeight: loadedDimensions.height,
          dimensions: `${loadedDimensions.width} x ${loadedDimensions.height}`,
        });
      }

      preparedItems.push({ asset, nodeSize });
    }

    const originX = 96 + ((activeItems.length * 42) % 260);
    const originY = 90 + ((activeItems.length * 34) % 180);
    let cursorX = originX;
    let cursorY = originY;
    let rowHeight = 0;
    const timestamp = Date.now();
    const nextItems = preparedItems.map(({ asset, nodeSize }, index) => {
      if (index > 0 && index % 3 === 0) {
        cursorX = originX;
        cursorY += rowHeight;
        rowHeight = 0;
      }
      const nextItem = {
        id: `i-${timestamp}-${index}-${asset.id}`,
        assetId: asset.id,
        x: Math.round(cursorX),
        y: Math.round(cursorY),
        width: nodeSize.width,
        height: nodeSize.height,
        note: "新发送",
      };
      cursorX += nodeSize.width;
      rowHeight = Math.max(rowHeight, nodeSize.height);
      return nextItem;
    });

    checkpointBoardItems(activeBoardId);
    setBoardItems((current) => ({
      ...current,
      [activeBoardId]: [...(current[activeBoardId] ?? []), ...nextItems],
    }));
    setSelectedAssetId(targetAssets[0].id);
    setSelectedBoardItemId(nextItems[0].id);
    setBoardSelectionRequest({ boardId: activeBoardId, itemIds: nextItems.map((item) => item.id), token: Date.now() });
    setSelectedAssetIds(new Set());
    setMultiSelectMode(false);
    showToast(targetAssets.length > 1 ? `已发送 ${targetAssets.length} 张到「${activeBoard?.name}」白板` : `已发送到「${activeBoard?.name}」白板`);
  }

  function sendSelectionToBoard() {
    if (multiSelectMode) {
      sendAssetsToBoard(selectedAssetIds);
      return;
    }
    if (selectedAsset) sendAssetsToBoard([selectedAsset.id]);
  }

  function sendToBoard(assetId) {
    return sendAssetsToBoard([assetId]);
  }

  function startAssetCardDrag(event, asset) {
    const draggingIds = multiSelectMode && selectedAssetIds.has(asset.id) ? Array.from(selectedAssetIds) : [asset.id];
    draggingAssetIdsRef.current = draggingIds;
    setAssetDragActive(true);
    setSelectedAssetId(asset.id);
    setSelectedBoardItemId("");

    const sourcePaths = draggingIds
      .map((assetId) => getAssetCheckPath(assetById.get(assetId)))
      .map((source) => String(source || "").trim())
      .filter((source) => source && !/^(https?:|blob:|data:)/i.test(source));
    if (sourcePaths.length > 0 && window.referenceBoard?.startNativeFileDrag) {
      event.preventDefault();
      nativeDragStartedRef.current = true;
      window.referenceBoard.startNativeFileDrag(sourcePaths);
      return;
    }

    writeAssetDragData(event.dataTransfer, draggingIds);
    const sourcePath = String(asset?.source || "").trim();
    const fileUrl = getAssetMediaUrl(asset) || asset?.image || "";
    if (sourcePath && fileUrl.startsWith("file:")) {
      const extension = extensionFromName(sourcePath);
      const mimeType = isAssetVideo(asset) ? "video/mp4" : extension === ".png" ? "image/png" : "image/jpeg";
      const fileName = sourcePath.split(/[\\/]/).pop() || `${asset.title || "MOTZ素材"}${extension || ".png"}`;
      event.dataTransfer.setData("text/uri-list", fileUrl);
      event.dataTransfer.setData("DownloadURL", `${mimeType}:${fileName}:${fileUrl}`);
    }
  }

  function endAssetCardDrag() {
    draggingAssetIdsRef.current = [];
    setAssetDragActive(false);
    setFolderDropTarget("");
    nativeDragStartedRef.current = false;
  }

  function handleFolderDragOver(event, folder) {
    if (!hasAssetDragData(event.dataTransfer) && draggingAssetIdsRef.current.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setFolderDropTarget(folder);
  }

  function handleFolderDragLeave(event, folder) {
    const nextTarget = event.relatedTarget;
    if (nextTarget && event.currentTarget.contains(nextTarget)) return;
    setFolderDropTarget((current) => (current === folder ? "" : current));
  }

  function handleFolderDrop(event, folder) {
    const dataIds = readAssetDragIds(event.dataTransfer);
    const fileIds = assetIdsFromDroppedFiles(event.dataTransfer.files, assets);
    const fallbackIds = draggingAssetIdsRef.current;
    const droppingIds = dataIds.length > 0 ? dataIds : fileIds.length > 0 ? fileIds : fallbackIds;
    if (!hasAssetDragData(event.dataTransfer) && droppingIds.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    setFolderDropTarget("");
    setAssetDragActive(false);
    draggingAssetIdsRef.current = [];
    moveAssetsToFolder(droppingIds, folder);
  }

  function arrangeBoard(mode = "grid", itemIds = null) {
    if (!activeBoard) {
      showToast("当前没有白板");
      return;
    }

    const tileWidth = 248;
    const tileHeight = 146;
    const selectedIds = itemIds?.size ? itemIds : null;

    checkpointBoardItems(activeBoardId);
    setBoardItems((current) => ({
      ...current,
      [activeBoardId]: (() => {
        const items = current[activeBoardId] ?? [];
        const imageItems = items.filter((item) => item.assetId && (!selectedIds || selectedIds.has(item.id)));
        if (imageItems.length === 0) return items;

        const startX = selectedIds ? Math.min(...imageItems.map((item) => item.x)) : 72;
        const startY = selectedIds ? Math.min(...imageItems.map((item) => item.y)) : 72;
        let cursor = 0;
        let gridX = startX;
        let gridY = startY;
        let rowHeight = 0;

        const arrangedImages = imageItems.map((item, index) => {
          if (mode === "row") {
            const next = { ...item, x: startX + cursor, y: startY };
            cursor += item.width;
            return next;
          }

          if (mode === "column") {
            const next = { ...item, x: startX, y: startY + cursor };
            cursor += item.height;
            return next;
          }

          const fittedSize = fitExistingItemSize(item, { maxWidth: tileWidth, maxHeight: tileWidth, minWidth: 80, minHeight: 64 });
          if (index > 0 && index % 3 === 0) {
            gridX = startX;
            gridY += rowHeight;
            rowHeight = 0;
          }
          const next = {
            ...item,
            x: gridX,
            y: gridY,
            width: fittedSize.width,
            height: fittedSize.height,
          };
          gridX += fittedSize.width;
          rowHeight = Math.max(rowHeight, fittedSize.height);
          return {
            ...next,
          };
        });

        if (!selectedIds) {
          const noteItems = items.filter((item) => !item.assetId);
          return [...arrangedImages, ...noteItems];
        }

        const arrangedById = new Map(arrangedImages.map((item) => [item.id, item]));
        return items.map((item) => arrangedById.get(item.id) ?? item);
      })(),
    }));
    showToast(selectedIds ? "已排列选中项" : "当前白板已重新排列");
  }

  function addNote(position = {}, initialText = "") {
    if (!activeBoard) {
      showToast("请先新建一个白板");
      return;
    }

    const fallbackX = 540;
    const fallbackY = 118 + activeItems.length * 32;
    const text = String(initialText || "").slice(0, 20000);
    const noteSize = fitTextNodeSize(text, 16);
    const nextItem = {
      id: `note-${Date.now()}`,
      type: "note",
      text,
      fontSize: 16,
      color: noteColorOptions[0],
      fontFamily: defaultNoteFont,
      x: Math.round(Number.isFinite(position.x) ? position.x : fallbackX),
      y: Math.round(Number.isFinite(position.y) ? position.y : fallbackY),
      width: noteSize.width,
      height: noteSize.height,
    };

    checkpointBoardItems(activeBoardId);
    setBoardItems((current) => ({
      ...current,
      [activeBoardId]: [...(current[activeBoardId] ?? []), nextItem],
    }));
    setSelectedBoardItemId(nextItem.id);
    setBoardSelectionRequest({ boardId: activeBoardId, itemIds: [nextItem.id], focusText: text.length === 0, token: Date.now() });
    showToast("已添加文本");
  }

  function openFloatingBoard(boardId = floatingTargetId) {
    const board = boards.find((item) => item.id === boardId);
    if (!board) {
      showToast("当前没有白板，不能打开浮窗");
      return;
    }

    if (window.referenceBoard?.openFloatingBoard) {
      window.referenceBoard.openFloatingBoard(board.id);
      showToast(`已打开「${board?.name}」无边框浮窗`);
    } else {
      showToast("无边框浮窗需要在打包后的桌面版里使用");
    }
  }

  function openFloatingBoardWithMotion(boardId = floatingTargetId) {
    const board = boards.find((item) => item.id === boardId);
    if (!board) {
      openFloatingBoard(boardId);
      return;
    }

    setFloatingLaunchActive(true);
    window.clearTimeout(floatingLaunchTimerRef.current);
    floatingLaunchTimerRef.current = window.setTimeout(() => {
      openFloatingBoard(board.id);
      floatingLaunchTimerRef.current = window.setTimeout(() => setFloatingLaunchActive(false), 460);
    }, 120);
  }

  function startDrag(event, item, itemIds = [item.id], itemsForDrag = activeItems) {
    if (event.button !== 0) return;
    event.stopPropagation();
    checkpointBoardItems(activeBoardId);
    setSelectedBoardItemId(item.id);
    if (item.assetId) setSelectedAssetId(item.assetId);
    const draggingIds = Array.from(new Set(itemIds.filter(Boolean)));
    const origins = Object.fromEntries(
      itemsForDrag
        .filter((candidate) => draggingIds.includes(candidate.id))
        .map((candidate) => [candidate.id, { x: candidate.x, y: candidate.y }]),
    );
    const draggingIdSet = new Set(draggingIds);
    const stationaryItems = itemsForDrag.filter((candidate) => candidate.assetId && !draggingIdSet.has(candidate.id));
    setDragState({
      ids: draggingIds,
      startX: event.clientX,
      startY: event.clientY,
      origins,
      stationaryEdges: {
        x: stationaryItems.flatMap((candidate) => [candidate.x, candidate.x + candidate.width]),
        y: stationaryItems.flatMap((candidate) => [candidate.y, candidate.y + candidate.height]),
      },
    });
  }

  function moveDraggedItem(clientX, clientY) {
    if (!dragState) return;
    const dx = (clientX - dragState.startX) / zoom;
    const dy = (clientY - dragState.startY) / zoom;

    setBoardItems((current) => {
      const currentItems = current[activeBoardId] ?? [];
      const movedById = Object.fromEntries(
        currentItems
          .filter((item) => dragState.origins[item.id])
          .map((item) => [
            item.id,
            {
              ...item,
              x: dragState.origins[item.id].x + dx,
              y: dragState.origins[item.id].y + dy,
            },
          ]),
      );
      if (Object.keys(movedById).length === 0) return current;

      const snappedById = snapDraggedItems(currentItems, dragState.ids, movedById, 12 / zoom, dragState.stationaryEdges);

      return {
        ...current,
        [activeBoardId]: currentItems.map((item) => snappedById[item.id] ?? item),
      };
    });
  }

  function stopDrag() {
    setDragState(null);
  }

  function changeAssetGridScale(delta) {
    setAssetGridScale((current) => {
      const next = current + delta;
      return Math.min(1.55, Math.max(0.72, Number(next.toFixed(2))));
    });
  }

  function startAssetPanelResize(event) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = assetPanelWidth;

    const move = (moveEvent) => {
      const maxWidth = Math.max(360, window.innerWidth - 880);
      setAssetPanelWidth(clampNumber(startWidth + moveEvent.clientX - startX, 320, maxWidth));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("mouseup", stop);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("mouseup", stop);
  }

  function deleteBoardItems(itemIds) {
    const deletingIds = new Set(Array.from(itemIds ?? []).filter(Boolean));
    if (deletingIds.size === 0) return;

    checkpointBoardItems(activeBoardId);
    setBoardItems((current) => ({
      ...current,
      [activeBoardId]: (current[activeBoardId] ?? []).filter((item) => !deletingIds.has(item.id)),
    }));
    if (deletingIds.has(selectedBoardItemId)) setSelectedBoardItemId("");
    showToast(deletingIds.size > 1 ? `已从当前白板移除 ${deletingIds.size} 项` : "已从当前白板移除");
  }

  function targetImportFolder() {
    return activeCollection === "folder" && activeFolder ? activeFolder : "";
  }

  function addImportedAssets(importedAssets, folderName, messagePrefix = "已导入", options = {}) {
    if (importedAssets.length === 0) {
      showToast("没有找到可导入的素材");
      return;
    }

    setFolders((current) => (folderName && !current.includes(folderName) ? sortFoldersByHierarchy([...current, folderName]) : current));
    setAssets((current) => [...importedAssets, ...current]);
    if (options.selectInLibrary !== false) {
      setActiveCollection(folderName ? "folder" : "unsorted");
      setActiveFolder(folderName || "");
      setSelectedAssetId(importedAssets[0].id);
    }
    setSelectedBoardItemId("");
    setMultiSelectMode(false);
    setSelectedAssetIds(new Set());
    showToast(`${messagePrefix} ${importedAssets.length} 个参考`);
  }

  async function openImageImportDialog() {
    const folderName = targetImportFolder();
    if (window.referenceBoard?.importImageFiles) {
      const result = await window.referenceBoard.importImageFiles(folderName, activeImportMode);
      if (!result || result.canceled) return;
      addImportedAssets(result.assets ?? [], folderName);
      return;
    }
    fileInputRef.current?.click();
  }

  async function importImagesToLibrary(files, metadata = {}, options = {}) {
    const importMeta = typeof metadata === "string" ? { originalSource: metadata, remoteSource: metadata, imageUrls: metadata ? [metadata] : [] } : metadata;
    const incomingFiles = Array.from(files ?? []).filter(isMediaFileLike);
    const imageUrlsForImport = Array.from(new Set([...(importMeta.imageUrls ?? [])].filter((url) => !looksLikeVideoUrl(url))));
    const videoUrlsForImport = Array.from(new Set([...(importMeta.videoUrls ?? []), ...(importMeta.imageUrls ?? []).filter(looksLikeVideoUrl)]));
    const folderName = normalizeFolderPath(options.folderName ?? targetImportFolder());
    const typeLabel = importMeta.typeLabel || (importMeta.clipboard ? "剪贴板" : importMeta.remoteSource ? "网页拖拽" : "导入");
    const tagsForImport = importMeta.tags || (importMeta.clipboard ? ["剪贴板"] : importMeta.remoteSource ? ["网页"] : ["本地"]);
    const noteForImport =
      importMeta.note ||
      (importMeta.clipboard
        ? "从剪贴板粘贴并复制到软件素材库。"
        : importMeta.remoteSource
          ? "从网页拖入并备份到软件素材库。"
          : "已复制到软件素材库。");
    const importedAssets = [];

    const filesWithPaths = [];
    const imageFilesWithoutPaths = [];
    const videoFilesWithoutPaths = [];
    incomingFiles.forEach((file) => {
      const filePath = localPathFromFile(file);
      if (filePath) {
        filesWithPaths.push(filePath);
      } else if (isImageFileLike(file)) {
        imageFilesWithoutPaths.push(file);
      } else {
        videoFilesWithoutPaths.push(file);
      }
    });

    if (filesWithPaths.length > 0 && window.referenceBoard?.importImagePaths) {
      const result = await window.referenceBoard.importImagePaths(filesWithPaths, folderName, typeLabel, activeImportMode);
      importedAssets.push(
        ...(result.assets ?? []).map((asset) => {
          const assetIsVideo = isAssetVideo(asset);
          return {
            ...asset,
            originalSource: importMeta.originalSource || asset.originalSource,
            remoteSource: importMeta.remoteSource || asset.remoteSource || "",
            tags: Array.from(new Set([...(asset.tags ?? []), ...tagsForImport, ...(assetIsVideo ? ["视频"] : [])])),
            note: importMeta.note || (asset.referencedSource || assetIsVideo ? asset.note : noteForImport),
          };
        }),
      );
    }

    const mediaFilesWithoutPaths = [
      ...imageFilesWithoutPaths.map((file, index) => ({ file, remoteSource: imageUrlsForImport[index] || "" })),
      ...videoFilesWithoutPaths.map((file, index) => ({ file, remoteSource: videoUrlsForImport[index] || "" })),
    ];
    if (mediaFilesWithoutPaths.length > 0 && window.referenceBoard?.importImageData) {
      const payload = await Promise.all(
        mediaFilesWithoutPaths.map(async ({ file, remoteSource }, index) => ({
          name:
            file.name ||
            `${isVideoFileLike(file) ? "web-video" : importMeta.clipboard ? "clipboard-image" : "web-image"}-${Date.now()}-${index}${
              isVideoFileLike(file) ? ".mp4" : ".png"
            }`,
          type: file.type || "",
          buffer: await file.arrayBuffer(),
          originalSource: importMeta.originalSource || importMeta.remoteSource || file.name,
          remoteSource: remoteSource || importMeta.remoteSource || "",
          typeLabel,
          tags: isVideoFileLike(file) ? Array.from(new Set(["视频", ...tagsForImport])) : tagsForImport,
          note: noteForImport,
        })),
      );
      const result = await window.referenceBoard.importImageData(payload, folderName);
      importedAssets.push(...(result.assets ?? []));
    }

    const mediaUrlsForImport = Array.from(new Set([...imageUrlsForImport, ...videoUrlsForImport]));
    if ((incomingFiles.length === 0 || importedAssets.length === 0) && mediaUrlsForImport.length > 0 && window.referenceBoard?.importImageUrls) {
      const result = await window.referenceBoard.importImageUrls(mediaUrlsForImport, folderName, importMeta.originalSource || importMeta.remoteSource || "");
      importedAssets.push(...(result.assets ?? []));
    }

    if (videoFilesWithoutPaths.length > 0 && !window.referenceBoard?.importImageData) {
      importedAssets.push(
        ...videoFilesWithoutPaths.map((file, index) =>
          createTransientVideoAsset(file, index, folderName, { ...importMeta, typeLabel }, tagsForImport),
        ),
      );
    }

    if (importedAssets.length > 0) {
      addImportedAssets(importedAssets, folderName, options.messagePrefix ?? (importMeta.clipboard ? "已从剪贴板粘贴" : "已导入"), {
        selectInLibrary: options.selectInLibrary,
      });
      return importedAssets;
    }

    if (incomingFiles.length === 0) {
      if (options.showEmptyToast !== false) showToast(imageUrlsForImport.length || videoUrlsForImport.length ? "网页素材导入失败" : "只支持导入图片和视频参考");
      return [];
    }

    const fallbackAssets = imageFilesWithoutPaths.map((file, index) => ({
      id: `local-${Date.now()}-${index}`,
      title: file.name.replace(/\.[^.]+$/, ""),
      size: "本地图片",
      type: typeLabel,
      image: URL.createObjectURL(file),
      mediaKind: "image",
      tags: tagsForImport,
      folder: folderName,
      source: "local import",
      originalSource: importMeta.originalSource || importMeta.remoteSource || file.name,
      remoteSource: importMeta.remoteSource || "",
      note: importMeta.clipboard ? "从剪贴板粘贴，当前环境未生成本地副本。" : importMeta.remoteSource ? "从网页拖入，当前环境未生成本地副本。" : "从本地导入，等待补充标签和备注。",
      created: "刚刚",
      libraryCopy: false,
    }));

    if (fallbackAssets.length === 0) return [];

    addImportedAssets(fallbackAssets, folderName, options.messagePrefix ?? (importMeta.clipboard ? "已从剪贴板粘贴" : "已导入"), {
      selectInLibrary: options.selectInLibrary,
    });
    return fallbackAssets;
  }

  async function handleImport(files, metadata = {}) {
    return importImagesToLibrary(files, metadata);
  }

  async function pasteImagesToBoard(files, metadata, point) {
    if (!activeBoard) {
      showToast("请先新建一个白板");
      return;
    }

    const importedAssets = await importImagesToLibrary(files, metadata, {
      selectInLibrary: false,
      messagePrefix: "已粘贴到素材库",
      showEmptyToast: true,
    });
    if (importedAssets.length === 0) return;

    await appendAssetObjectsToBoard(importedAssets, {
      point,
      note: "粘贴到白板",
      message: importedAssets.length > 1 ? `已粘贴 ${importedAssets.length} 张到「${activeBoard.name}」` : `已粘贴到「${activeBoard.name}」`,
    });
  }

  async function handlePluginCollect(payload) {
    const importedPayloadAssets = Array.isArray(payload?.assets) ? payload.assets : [];
    if (importedPayloadAssets.length > 0) {
      const target = payload?.target === "board" ? "board" : "library";
      const folderName = normalizeFolderPath(payload?.folderName || importedPayloadAssets[0]?.folder || "");
      addImportedAssets(importedPayloadAssets, folderName, target === "board" ? "已从浏览器收藏" : "已从浏览器收藏到素材库", {
        selectInLibrary: target !== "board",
      });

      if (target !== "board") return;
      if (!activeBoard) {
        showToast("已入库；当前没有白板，未发送到白板");
        return;
      }

      await appendAssetObjectsToBoard(importedPayloadAssets, {
        note: "浏览器插件收藏",
        message:
          importedPayloadAssets.length > 1
            ? `已从浏览器收藏 ${importedPayloadAssets.length} 个到「${activeBoard.name}」`
            : `已从浏览器收藏到「${activeBoard.name}」`,
      });
      return;
    }

    const items = Array.isArray(payload?.items) ? payload.items : [];
    const imageUrls = Array.from(new Set(items.map((item) => item?.url).filter(isHttpUrl)));
    if (imageUrls.length === 0) {
      showToast("浏览器插件没有传入可下载图片");
      return;
    }

    const firstItem = items.find((item) => imageUrls.includes(item?.url)) ?? items[0] ?? {};
    const target = payload?.target === "board" ? "board" : "library";
    const importedAssets = await importImagesToLibrary(
      [],
      {
        originalSource: firstItem.pageUrl || firstItem.url || imageUrls[0],
        remoteSource: imageUrls[0],
        imageUrls,
        typeLabel: "浏览器插件",
        tags: ["网页", "插件"],
        note: "通过浏览器插件拖拽收藏并备份到素材库。",
      },
      {
        selectInLibrary: target !== "board",
        messagePrefix: target === "board" ? "已从浏览器收藏" : "已从浏览器收藏到素材库",
        showEmptyToast: true,
      },
    );

    if (target !== "board" || importedAssets.length === 0) return;
    if (!activeBoard) {
      showToast("已入库；当前没有白板，未发送到白板");
      return;
    }

    await appendAssetObjectsToBoard(importedAssets, {
      note: "浏览器插件收藏",
      message: importedAssets.length > 1 ? `已从浏览器收藏 ${importedAssets.length} 个到「${activeBoard.name}」` : `已从浏览器收藏到「${activeBoard.name}」`,
    });
  }

  useEffect(() => {
    const unsubscribe = window.referenceBoard?.onPluginCollect?.((payload) => {
      handlePluginCollect(payload);
    });
    return () => unsubscribe?.();
  }, [activeBoard, activeCollection, activeFolder, activeLibraryId, assets]);

  async function handleAssetPanelPaste(event) {
    if (isTextEditingTarget(event.target)) return;
    const input = getClipboardMediaInput(event.clipboardData);
    if (!input.hasContent) return;
    event.preventDefault();
    event.stopPropagation();
    await importImagesToLibrary(input.files, input.metadata, { messagePrefix: "已粘贴到素材库" });
  }

  async function importImageFolder() {
    if (!window.referenceBoard?.importImageFolder) {
      showToast("添加本地文件夹需要在打包后的桌面版里使用");
      return;
    }

    const result = await window.referenceBoard.importImageFolder(activeImportMode);
    if (!result || result.canceled) return;

    const folderName = sanitizeName(result.folderName || "本地文件夹");
    const importedAssets = (result.assets ?? []).map((asset) => ({ ...asset, folder: folderName }));

    if (importedAssets.length === 0) {
      showToast(`「${folderName}」里没有检索到素材`);
      return;
    }

    addImportedAssets(importedAssets, folderName, `已从「${folderName}」导入`);
  }

  function handleDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    const droppedFiles = Array.from(event.dataTransfer.files ?? []);
    if (droppedFiles.length === 0 && (hasAssetDragData(event.dataTransfer) || draggingAssetIdsRef.current.length > 0)) {
      endAssetCardDrag();
      return;
    }
    const existingPaths = new Set(assets.flatMap(assetPathKeys));
    const newFiles = droppedFiles.filter((file) => !existingPaths.has(normalizePathKey(localPathFromFile(file))));
    endAssetCardDrag();
    if (newFiles.length === 0 && droppedFiles.length > 0) return;
    handleImport(newFiles.length > 0 ? newFiles : droppedFiles, getDropImportMetadata(event.dataTransfer));
  }

  const boardMenuTarget = boardMenu ? boards.find((board) => board.id === boardMenu.boardId) : null;
  const assetMenuTarget = assetMenu ? assetById.get(assetMenu.assetId) : null;
  const assetMenuTargetIds = assetMenu?.assetIds?.length ? assetMenu.assetIds : assetMenuTarget ? [assetMenuTarget.id] : [];
  const assetMenuTargets = assetMenuTargetIds.map((assetId) => assetById.get(assetId)).filter(Boolean);
  const assetMenuBoardTargets = assetMenuTargets.filter((asset) => isBoardFileAsset(asset) && !isAssetTrashed(asset));
  const assetMenuAllTrashed = assetMenuTargets.length > 0 && assetMenuTargets.every(isAssetTrashed);
  const tagsAvailableForInspector = inspectorAsset ? tags.filter((tag) => !inspectorAsset.tags.includes(tag)) : [];

  return (
    <main
      className={classNames(
        "app-shell",
        viewMode === "library" && "library-expanded",
        viewMode === "board" && "board-expanded",
        inspectorCollapsed && "inspector-collapsed",
        assetDragActive && "asset-dragging",
      )}
      style={{ "--asset-panel-width": `${assetPanelWidth}px` }}
      onClick={() => {
        setBoardMenu(null);
        setAssetMenu(null);
        setLibraryMenu(null);
        setLibrarySwitcherMenu(null);
        setAssetSortMenuOpen(false);
      }}
    >
      <header className="titlebar">
        <div className="window-group">
          <div className="project-switcher" onContextMenu={showLibrarySwitcherMenu}>
            <select
              className="library-select"
              value={activeLibraryId}
              onChange={(event) => switchLibrary(event.target.value)}
              title={libraryRoot ? `${activeLibrary?.name || "素材库"}：${libraryRoot}` : "切换素材库"}
              aria-label="切换素材库"
            >
              {libraries.map((library) => (
                <option key={library.id} value={library.id}>
                  {library.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label className="search-box" aria-label="搜索素材">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、标签、来源" />
          {query ? (
            <button type="button" className="search-clear" onClick={() => setQuery("")} title="清除搜索" aria-label="清除搜索">
              <X size={14} />
            </button>
          ) : null}
        </label>

        <div className="window-actions">
          <button
            className="toolbar-button icon-only"
            onClick={() => setSettingsOpen(true)}
            title="设置"
            aria-label="设置"
          >
            <Settings size={15} />
          </button>
          <button className="toolbar-button icon-only" onClick={openImageImportDialog} title="导入素材" aria-label="导入素材">
            <Upload size={15} />
          </button>
          <button className="toolbar-button icon-only" onClick={importImageFolder} title="添加本地文件夹" aria-label="添加本地文件夹">
            <FolderOpen size={15} />
          </button>
          <button
            className="toolbar-button icon-only send-action"
            onClick={sendSelectionToBoard}
            disabled={activeCollection === "trash" || !activeBoard || (multiSelectMode ? selectedAssetIds.size === 0 : !selectedAsset)}
            title={activeCollection === "trash" ? "恢复素材后再发送到白板" : multiSelectMode ? "发送选中素材到当前白板" : "发送到当前白板"}
            aria-label={multiSelectMode ? "发送选中素材到当前白板" : "发送到当前白板"}
          >
            <Send size={15} />
          </button>
        </div>

        <div className="window-controls">
          <button onClick={() => window.referenceBoard?.minimizeWindow?.()} aria-label="最小化">
            <Minus size={14} />
          </button>
          <button onClick={() => window.referenceBoard?.toggleMaximizeWindow?.()} aria-label="最大化">
            <Square size={12} />
          </button>
          <button className="close" onClick={() => window.referenceBoard?.closeWindow?.()} aria-label="关闭">
            <X size={15} />
          </button>
        </div>
      </header>

      <input
        ref={fileInputRef}
        className="hidden-input"
        type="file"
        accept="image/*,video/*,.mov,.MOV,.qt,.m4v,.mkv,.avi,.wmv,.ogv"
        multiple
        onChange={(event) => {
          handleImport(event.target.files);
          event.target.value = "";
        }}
      />

      <aside className="library-sidebar">
        <div className="sidebar-block">
          <div className="sidebar-heading">素材库</div>
          {collections.map((collection) => {
            const Icon = collection.icon;
            return (
              <button
                className={classNames("nav-item", activeCollection === collection.id && "active")}
                key={collection.id}
                onClick={() => {
                  setActiveCollection(collection.id);
                  if (collection.id !== "folder") setActiveFolder("");
                }}
              >
                <Icon size={16} />
                <span>{collection.label}</span>
                <strong>
                  {collection.id === "sent"
                    ? sentAssetIds.size
                    : collection.id === "board-assets"
                      ? boardFileAssets.length
                    : collection.id === "all"
                      ? collectionCounts.all
                      : collection.id === "images"
                        ? collectionCounts.images
                        : collection.id === "videos"
                          ? collectionCounts.videos
                          : collection.id === "untagged"
                            ? collectionCounts.untagged
                            : collection.id === "unsorted"
                              ? collectionCounts.unsorted
                              : collection.id === "trash"
                                ? trashedAssets.length
                                : collection.id === "recent"
                                  ? libraryAssets.length
                                  : liveAssets.length}
                </strong>
              </button>
            );
          })}
          {assetSelectionBox ? (
            <div
              className="asset-selection-box"
              style={{ left: assetSelectionBox.left, top: assetSelectionBox.top, width: assetSelectionBox.width, height: assetSelectionBox.height }}
            />
          ) : null}
        </div>

        <div className="sidebar-block">
          <div className="sidebar-heading with-action">
            <span>分类</span>
            <button onClick={() => createFolder("")} title="新建分类">
              <FolderPlus size={14} />
            </button>
          </div>
          {visibleFolders.map((folder) => {
            const hasChildren = foldersWithChildren.has(folder);
            const isCollapsed = collapsedFolderSet.has(folder);
            return (
            <div
              className={classNames(
                "nav-row folder-item",
                activeFolder === folder && activeCollection === "folder" && "active",
                folderDropTarget === folder && "drop-target",
                hasChildren && "has-children",
                isCollapsed && "collapsed",
              )}
              key={folder}
              style={{ "--folder-depth": folderDepth(folder) }}
              onDragEnter={(event) => handleFolderDragOver(event, folder)}
              onDragOver={(event) => handleFolderDragOver(event, folder)}
              onDragLeave={(event) => handleFolderDragLeave(event, folder)}
              onDrop={(event) => handleFolderDrop(event, folder)}
              title={folder}
            >
              {hasChildren ? (
                <button
                  className="folder-toggle"
                  onClick={(event) => toggleFolderCollapsed(folder, event)}
                  title={isCollapsed ? `展开 ${folder}` : `收起 ${folder}`}
                  aria-label={isCollapsed ? `展开 ${folder}` : `收起 ${folder}`}
                  aria-expanded={!isCollapsed}
                >
                  <ChevronDown size={13} />
                </button>
              ) : (
                <span className="folder-toggle-spacer" aria-hidden="true" />
              )}
              <button
                className="nav-item"
                onClick={() => {
                  setActiveCollection("folder");
                  setActiveFolder(folder);
                }}
              >
                <Folder size={16} />
                <span>{folderLeafName(folder)}</span>
                <strong>{folderAssetCounts.get(folder) ?? 0}</strong>
              </button>
              <button className="row-action" onClick={() => createFolder(folder)} title={`在 ${folder} 下新建子分类`} aria-label={`在 ${folder} 下新建子分类`}>
                <Plus size={12} />
              </button>
              <button className="row-delete" onClick={() => confirmDeleteFolder(folder)} title={`删除分类 ${folder}`} aria-label={`删除分类 ${folder}`}>
                <X size={13} />
              </button>
            </div>
            );
          })}
        </div>

        <div className="sidebar-block board-list-block">
          <div className="sidebar-heading with-action">
            <button className="sidebar-heading-button" onClick={() => setBoardManagerOpen(true)} title="管理白板">
              白板
            </button>
            <button onClick={createBoard} title="新建白板">
              <Plus size={14} />
            </button>
          </div>
          {boards.map((board) => (
            <button
              className={classNames("nav-item board-nav-item", activeBoardId === board.id && "active", board.tone)}
              key={board.id}
              onContextMenu={(event) => showBoardMenu(event, board)}
              onClick={() => {
                setActiveBoardId(board.id);
                setFloatingTargetId(board.id);
                setSelectedBoardItemId("");
              }}
              title={board.name}
            >
              <CircleDot size={15} />
              <span>{board.name}</span>
              <strong>{boardItems[board.id]?.length ?? 0}</strong>
            </button>
          ))}
        </div>

        <div className="sidebar-block tags-block">
          <div className="sidebar-heading with-action">
            <span>标签</span>
            <div className="sidebar-heading-actions">
              {selectedTagFilterList.length > 0 ? (
                <button onClick={clearTagFilters} title="清除标签筛选" aria-label="清除标签筛选">
                  <X size={13} />
                </button>
              ) : null}
              <button onClick={addTagToSelectedAsset} title="给当前素材新建标签">
                <Plus size={14} />
              </button>
            </div>
          </div>
          <div className="tag-cloud">
            {tags.map((tag) => (
              <span className={classNames("tag-pill", selectedTagFilterSet.has(tag) && "active")} key={tag}>
                <button className="tag-name" onClick={() => toggleTagFilter(tag)} title={selectedTagFilterSet.has(tag) ? "取消这个标签筛选" : "按这个标签筛选"}>
                  {tag}
                </button>
                <button className="tag-remove" onClick={() => confirmDeleteTag(tag)} title={`删除标签 ${tag}`} aria-label={`删除标签 ${tag}`}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        </div>

      </aside>

      <section
        className="asset-panel"
        tabIndex={0}
        onPaste={handleAssetPanelPaste}
        onPointerDown={handleAssetPanelPointerDown}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
        onContextMenu={showLibraryMenu}
      >
        <div className="panel-header">
          <div>
            <p>参考收集</p>
            <h1>{activeCollection === "folder" ? activeFolder || "未分类" : collections.find((item) => item.id === activeCollection)?.label}</h1>
          </div>
          <div className="panel-actions">
            <span className="panel-count">{multiSelectMode ? `已选 ${selectedAssetIds.size}` : `${filteredAssets.length} 个素材`}</span>
            <div className="asset-sort-control">
              <button
                type="button"
                className={classNames("asset-sort-button", assetSortMenuOpen && "active")}
                onClick={(event) => {
                  event.stopPropagation();
                  setAssetSortMenuOpen((current) => !current);
                }}
                title="素材排序"
                aria-label="素材排序"
                aria-expanded={assetSortMenuOpen}
              >
                <ArrowDownUp size={13} />
                <span>{({ recent: "最近添加", oldest: "最早添加", name: "名称", resolution: "分辨率", size: "文件大小" })[assetSortMode]}</span>
                <ChevronDown size={12} />
              </button>
              {assetSortMenuOpen ? (
                <div className="asset-sort-menu" onClick={(event) => event.stopPropagation()}>
                  {[
                    ["recent", "最近添加"],
                    ["oldest", "最早添加"],
                    ["name", "名称"],
                    ["resolution", "分辨率"],
                    ["size", "文件大小"],
                  ].map(([value, label]) => (
                    <button
                      type="button"
                      className={assetSortMode === value ? "active" : ""}
                      key={value}
                      onClick={() => {
                        setAssetSortMode(value);
                        setAssetSortMenuOpen(false);
                      }}
                    >
                      <span>{label}</span>
                      {assetSortMode === value ? <Check size={13} /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {activeCollection === "trash" && !multiSelectMode ? (
              <button
                type="button"
                className="toolbar-button subtle icon-only"
                onClick={confirmEmptyTrash}
                disabled={trashedAssets.length === 0}
                title="清空垃圾桶"
                aria-label="清空垃圾桶"
              >
                <Trash2 size={14} />
              </button>
            ) : null}
            <button
              className={classNames("toolbar-button icon-only", viewMode === "library" && "primary")}
              onClick={() => setViewMode((current) => (current === "library" ? "split" : "library"))}
              title={viewMode === "library" ? "取消素材库全屏" : "素材库全屏"}
              aria-label={viewMode === "library" ? "取消素材库全屏" : "素材库全屏"}
            >
              <Maximize2 size={14} />
            </button>
            {inspectorCollapsed && viewMode === "library" ? (
              <button
                type="button"
                className="toolbar-button icon-only"
                onClick={() => setInspectorCollapsed(false)}
                title="展开详情栏"
                aria-label="展开详情栏"
              >
                <PanelRight size={14} />
              </button>
            ) : null}
            {multiSelectMode ? (
              <>
                <button className="toolbar-button subtle icon-only" onClick={selectAllFilteredAssets} disabled={filteredAssets.length === 0} title="全选当前素材" aria-label="全选当前素材">
                  <Check size={14} />
                </button>
                <button className="toolbar-button subtle icon-only" onClick={clearAssetSelection} disabled={selectedAssetIds.size === 0} title="清空选择" aria-label="清空选择">
                  <X size={14} />
                </button>
                {activeCollection === "trash" ? (
                  <button className="toolbar-button subtle icon-only" onClick={() => restoreAssetsByIds(selectedAssetIds)} disabled={selectedAssetIds.size === 0} title="恢复选中素材" aria-label="恢复选中素材">
                    <RefreshCw size={14} />
                  </button>
                ) : null}
                <button
                  className="toolbar-button danger icon-only"
                  onClick={confirmDeleteSelectedAssets}
                  disabled={selectedAssetIds.size === 0}
                  title={activeCollection === "trash" ? "彻底删除选中素材" : "移到垃圾桶"}
                  aria-label={activeCollection === "trash" ? "彻底删除选中素材" : "移到垃圾桶"}
                >
                  <Trash2 size={14} />
                </button>
              </>
            ) : null}
            <button
              className={classNames("toolbar-button icon-only", multiSelectMode && "primary")}
              onClick={toggleMultiSelectMode}
              title={multiSelectMode ? "退出多选" : "多选素材"}
              aria-label={multiSelectMode ? "退出多选" : "多选素材"}
            >
              <MousePointer2 size={14} />
            </button>
          </div>
        </div>

        {availableColorFilters.length > 0 ? (
          <div className="color-filter-bar" aria-label="按主色筛选素材">
            <button
              className={classNames("color-filter-chip", colorFilter === "all" && "active")}
              onClick={() => setColorFilter("all")}
              title="显示全部颜色"
            >
              <span className="color-filter-swatch all" />
              <span>全部</span>
              <strong>{baseFilteredAssets.length}</strong>
            </button>
            {availableColorFilters.map((filter) => (
              <button
                className={classNames("color-filter-chip", colorFilter === filter.id && "active")}
                key={filter.id}
                style={{ "--filter-color": filter.color }}
                onClick={() => setColorFilter(filter.id)}
                title={`筛选${filter.label}色素材`}
              >
                <span className="color-filter-swatch" />
                <span>{filter.label}</span>
                <strong>{colorFilterCounts.get(filter.id)}</strong>
              </button>
            ))}
          </div>
        ) : null}

        <div
          ref={assetGridRef}
          className="asset-grid"
          onScroll={loadMoreAssetsOnScroll}
          onPointerDown={startAssetGridSelection}
          style={{
            "--asset-card-min": `${Math.round(176 * assetGridScale)}px`,
            "--asset-card-width": `${Math.round(196 * assetGridScale)}px`,
            "--asset-grid-gap-x": `${Math.round(12 * assetGridScale)}px`,
            "--asset-grid-gap-y": `${Math.round(18 * assetGridScale)}px`,
          }}
        >
          {renderedAssets.map((asset) => {
            const isSelected = selectedAssetId === asset.id && !selectedBoardItem;
            const isMultiSelected = selectedAssetIds.has(asset.id);
            const isSent = activeItemAssetIds.has(asset.id);
            const isTrashed = isAssetTrashed(asset);
            const assetColorPalette = colorPaletteForAsset(asset);
            const assetCheckPath = getAssetCheckPath(asset);
            const thumbnailEntry = assetThumbnailUrls[asset.id];
            const thumbnailUrl = thumbnailEntry?.source === assetCheckPath ? thumbnailEntry.url : "";
            return (
              <article
                className={classNames("asset-card", isSelected && "selected", isMultiSelected && "multi-selected")}
                key={asset.id}
                data-asset-id={asset.id}
                tabIndex={0}
                draggable={!isTrashed && renamingAssetId !== asset.id}
                onDragStart={(event) => startAssetCardDrag(event, asset)}
                onDragEnd={endAssetCardDrag}
                onContextMenu={(event) => showAssetMenu(event, asset)}
                onKeyDown={(event) => {
                  if (event.key !== "Delete" || isTextEditingTarget(event.target)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  if (isMultiSelected && selectedAssetIds.size > 1) {
                    confirmDeleteSelectedAssets();
                    return;
                  }
                  confirmDeleteAsset(asset.id);
                }}
                onDoubleClick={(event) => {
                  if (event.target.closest?.("button, input, label")) return;
                  setPreviewAssetId(asset.id);
                  setSelectedAssetId(asset.id);
                  setSelectedBoardItemId("");
                }}
                onClick={(event) => {
                  event.currentTarget.focus({ preventScroll: true });
                  handleAssetCardClick(event, asset);
                }}
              >
                <div
                  className={classNames("asset-thumb", isAssetVideo(asset) && "video-thumb")}
                  style={{ "--asset-aspect-ratio": getAssetAspectRatio(asset) }}
                  onMouseMove={isAssetVideo(asset) ? scrubVideoThumbnail : undefined}
                  onMouseLeave={isAssetVideo(asset) ? resetVideoThumbnailScrub : undefined}
                >
                  <MediaElement
                    asset={asset}
                    alt={asset.title}
                    defer
                    mediaUrl={thumbnailUrl}
                    waitForMediaUrl={Boolean(
                      !isAssetVideo(asset) && window.referenceBoard?.getMediaThumbnails && assetCheckPath && !thumbnailEntry?.failed,
                    )}
                    onImageLoad={(event) =>
                      thumbnailUrl ? scheduleAssetColorAnalysis(asset, event.currentTarget) : syncAssetDimensions(asset, event.currentTarget)
                    }
                    onVideoMetadata={(event) => syncAssetVideoDimensions(asset, event.currentTarget)}
                  />
                  {isAssetVideo(asset) ? (
                    <span className="video-badge" title="视频">
                      <Play size={12} />
                    </span>
                  ) : null}
                  {multiSelectMode ? (
                    <label className="asset-select-check" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isMultiSelected}
                        onChange={() => toggleAssetSelection(asset.id)}
                        aria-label={`选择素材 ${asset.title}`}
                      />
                    </label>
                  ) : null}
                  <button
                    className={classNames("send-chip", isSent && "sent")}
                    disabled={isTrashed}
                    onClick={(event) => {
                      event.stopPropagation();
                      sendToBoard(asset.id);
                    }}
                    title={isTrashed ? "恢复后才能发送到白板" : isSent ? "已在当前白板" : "发送到当前白板"}
                    aria-label={`发送 ${asset.title} 到白板`}
                  >
                    {isSent ? <Check size={13} /> : <Send size={13} />}
                  </button>
                  {assetColorPalette.length > 0 && !isAssetVideo(asset) ? (
                    <div className="asset-color-strip" aria-hidden="true">
                      {assetColorPalette.slice(0, 5).map((entry) => (
                        <span key={entry.group} style={{ "--swatch-color": entry.color, "--swatch-ratio": String(entry.ratio) }} />
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="asset-meta">
                  {renamingAssetId === asset.id ? (
                    <input
                      className="asset-title-input"
                      value={renameAssetInput}
                      autoFocus
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => setRenameAssetInput(event.target.value)}
                      onClick={(event) => event.stopPropagation()}
                      onDoubleClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                      onBlur={() => commitInlineAssetRename(asset)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          cancelAssetRenameRef.current = true;
                          setRenamingAssetId("");
                          setRenameAssetInput("");
                        }
                      }}
                      aria-label={`重命名素材 ${asset.title}`}
                    />
                  ) : (
                    <button
                      className="asset-title-button"
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        startRenameAsset(asset);
                      }}
                      title={canRenameLibraryAsset(asset) ? "双击重命名库内文件" : asset.title}
                    >
                      {asset.title}
                    </button>
                  )}
                  <span className="asset-dimensions">{asset.dimensions || ""}</span>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <div className="main-pane-resizer" onPointerDown={startAssetPanelResize} onMouseDown={startAssetPanelResize} title="拖动调整素材库宽度" />

      <section className={classNames("board-workspace", floatingLaunchActive && "floating-launching")}>
        <div className="board-toolbar">
          <div className="board-switcher">
            <span className="status-dot" />
            <div>
              <p>当前白板</p>
              <strong>{activeBoard?.name ?? "无白板"}</strong>
            </div>
          </div>

          <div className="canvas-tools">
            <select
              className="board-select"
              value={activeBoardId}
              disabled={boards.length === 0}
              onChange={(event) => {
                setActiveBoardId(event.target.value);
                setFloatingTargetId(event.target.value);
                setSelectedBoardItemId("");
              }}
              title="切换当前白板"
            >
              {boards.map((board) => (
                <option key={board.id} value={board.id}>
                  {board.name}
                </option>
              ))}
              {boards.length === 0 ? <option value="">无白板</option> : null}
            </select>
            <button
              className="toolbar-button icon-only"
              onClick={openBoardFile}
              title="打开 MOTZ 白板文件"
              aria-label="打开白板文件"
            >
              <FileUp size={15} />
            </button>
            <button
              className="toolbar-button icon-only"
              onClick={saveActiveBoardFile}
              disabled={!activeBoard}
              title="另存当前白板"
              aria-label="另存当前白板"
            >
              <Save size={15} />
            </button>
            <button
              className={classNames("toolbar-button icon-only", floatingLaunchActive && "launching")}
              onClick={() => openFloatingBoardWithMotion()}
              disabled={!activeBoard}
              title="打开无边框浮窗"
              aria-label="打开无边框浮窗"
            >
              <PictureInPicture2 size={15} />
            </button>
            <button className="icon-button" onClick={() => setBoardZoomAroundViewportCenterRef.current?.(-0.12)} title="缩小白板" aria-label="缩小">
              <ZoomOut size={16} />
            </button>
            <input
              className="zoom-range"
              type="range"
              min={minBoardZoom}
              max={maxBoardZoom}
              step="0.001"
              value={zoom}
              onChange={(event) => setBoardZoomAroundViewportCenterRef.current?.(0, Number(event.target.value))}
              aria-label="白板缩放"
            />
            <button className="icon-button" onClick={() => setBoardZoomAroundViewportCenterRef.current?.(0.12)} title="放大白板" aria-label="放大">
              <ZoomIn size={16} />
            </button>
            <button className="toolbar-button icon-only" onClick={() => arrangeBoard("grid")} disabled={!activeBoard} title="排列当前白板" aria-label="排列当前白板">
              <AlignCenter size={15} />
            </button>
            <button
              className={classNames("icon-button", viewMode === "board" && "primary")}
              onClick={() => setViewMode((current) => (current === "board" ? "split" : "board"))}
              title={viewMode === "board" ? "取消白板全屏" : "白板全屏"}
              aria-label={viewMode === "board" ? "取消白板全屏" : "白板全屏"}
            >
              <Maximize2 size={16} />
            </button>
            {inspectorCollapsed ? (
              <button
                type="button"
                className="toolbar-button icon-only"
                onClick={() => setInspectorCollapsed(false)}
                title="展开详情栏"
                aria-label="展开详情栏"
              >
                <PanelRight size={15} />
              </button>
            ) : null}
          </div>
        </div>

        <Canvas
          activeBoardId={activeBoardId}
          activeBoardName={activeBoard?.name}
          addNote={addNote}
          arrangeBoard={arrangeBoard}
          assets={assets}
          boardSelectionRequest={boardSelectionRequest}
          boardViewStates={boardViewStates}
          boardItems={boardItems}
          checkpointBoardItems={checkpointBoardItems}
          deleteBoardItems={deleteBoardItems}
          floatingLaunchActive={floatingLaunchActive}
          openFloatingBoard={openFloatingBoardWithMotion}
          pasteImagesToBoard={pasteImagesToBoard}
          selectedBoardItemId={selectedBoardItemId}
          setSelectedAssetId={setSelectedAssetId}
          setSelectedBoardItemId={setSelectedBoardItemId}
          setBoardItems={setBoardItems}
          setBoardViewStates={setBoardViewStates}
          setZoom={setZoom}
          setZoomAroundViewportCenterRef={setBoardZoomAroundViewportCenterRef}
          startDrag={startDrag}
          stopDrag={stopDrag}
          undoBoardItems={undoBoardItems}
          redoBoardItems={redoBoardItems}
          updateBoardItem={updateBoardItem}
          zoom={zoom}
        />
      </section>

      <aside className="inspector">
        <div className="inspector-title">
          <span>
            <BadgeInfo size={15} />
            详情
          </span>
          <button
            type="button"
            className="inspector-collapse-button"
            onClick={() => setInspectorCollapsed(true)}
            title="收纳详情栏"
            aria-label="收纳详情栏"
          >
            <ChevronRight size={15} />
          </button>
        </div>

        {isBulkAssetEditing ? (
          <div className="inspector-body bulk-inspector">
            <div className="bulk-summary">
              <Tags size={22} />
              <strong>{selectedAssets.length} 个素材</strong>
              <span>批量修改分类和标签</span>
            </div>

            <div className="field-group">
              <label>分类</label>
              <select className="field-value" value={bulkFolderValue} onChange={(event) => updateSelectedAssetsFolder(event.target.value)}>
                {bulkFolderValue === "__mixed__" ? (
                  <option value="__mixed__" disabled>
                    多个分类
                  </option>
                ) : null}
                <option value="">未分类</option>
                {sortedFolders.map((folder) => (
                  <option key={folder} value={folder}>
                    {folder}
                  </option>
                ))}
              </select>
            </div>

            <div className="field-group">
              <label>备注</label>
              <textarea
                className="bulk-note-field"
                value={bulkNoteState.value}
                onChange={(event) => updateSelectedAssetsNote(event.target.value)}
                placeholder={bulkNoteState.mixed ? "多个备注，输入后会覆盖选中素材" : "批量备注"}
              />
            </div>

            <div className="field-group">
              <label>标签</label>
              <div className="detail-tags bulk-tags">
                {bulkTags.map((tag) => {
                  const count = selectedAssets.filter((asset) => asset.tags.includes(tag)).length;
                  return (
                    <button key={tag} onClick={() => removeTagFromSelectedAssets(tag)} title="从选中素材移除标签">
                      {tag}
                      <small>{count}</small>
                      <X size={12} />
                    </button>
                  );
                })}
                <button onClick={addTagToSelectedAsset}>
                  <Plus size={13} />
                  新建标签
                </button>
                {tagsAvailableForBulk.length > 0 ? (
                  <select
                    className="existing-tag-select"
                    value=""
                    onChange={(event) => {
                      addExistingTagToSelectedAssets(event.target.value);
                      event.target.value = "";
                    }}
                    aria-label="批量添加已有标签"
                    title="批量添加已有标签"
                  >
                    <option value="">添加已有</option>
                    {tagsAvailableForBulk.map((tag) => (
                      <option key={tag} value={tag}>
                        {tag}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
            </div>
          </div>
        ) : inspectorAsset ? (
          <div className="inspector-body">
            <div className="preview-block">
              <MediaElement
                asset={inspectorAsset}
                alt={inspectorAsset.title}
                controls={isAssetVideo(inspectorAsset)}
                muted={false}
                onImageLoad={(event) => syncAssetDimensions(inspectorAsset, event.currentTarget)}
                onVideoMetadata={(event) => syncAssetVideoDimensions(inspectorAsset, event.currentTarget)}
              />
            </div>

            <div className="field-group">
              <label>标题</label>
              <input className="field-value strong" value={inspectorAsset.title} onChange={(event) => updateAsset(inspectorAsset.id, { title: event.target.value })} />
            </div>

            <div className="field-group">
              <label>备注</label>
              <textarea value={inspectorAsset.note} onChange={(event) => updateAsset(inspectorAsset.id, { note: event.target.value })} />
            </div>

            <div className="field-group">
              <label>分类</label>
              <select className="field-value" value={inspectorAsset.folder || ""} onChange={(event) => updateAsset(inspectorAsset.id, { folder: event.target.value })}>
                <option value="">未分类</option>
                {sortedFolders.map((folder) => (
                  <option key={folder} value={folder}>
                    {folder}
                  </option>
                ))}
              </select>
            </div>

            <div className="info-grid">
              <span>类型</span>
              <strong>{inspectorAsset.type}</strong>
              <span>尺寸</span>
              <strong>{inspectorAsset.dimensions || "未知"}</strong>
              <span>文件大小</span>
              <strong>{inspectorAsset.size || "未知"}</strong>
              <span>时间</span>
              <strong>{inspectorAsset.created}</strong>
            </div>

            {inspectorColorPalette.length > 0 && !isAssetVideo(inspectorAsset) ? (
              <div className="color-distribution">
                <div className="color-distribution-heading">
                  <span>颜色分布</span>
                  <strong>{colorFilterById(inspectorAsset.colorGroup)?.label || "未分析"}</strong>
                </div>
                <div className="color-distribution-bar" aria-hidden="true">
                  {inspectorColorPalette.map((entry) => (
                    <span key={entry.group} style={{ "--swatch-color": entry.color, "--swatch-ratio": String(entry.ratio) }} />
                  ))}
                </div>
                <div className="color-distribution-list">
                  {inspectorColorPalette.slice(0, 5).map((entry) => (
                    <button key={entry.group} type="button" onClick={() => setColorFilter(entry.group)} title={`筛选${entry.label}色素材`}>
                      <span style={{ "--swatch-color": entry.color }} />
                      {entry.label}
                      <strong>{Math.round(entry.ratio * 100)}%</strong>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <section className={classNames("source-details", sourceDetailsOpen && "open")}>
              <button
                type="button"
                className="source-details-toggle"
                onClick={() => setSourceDetailsOpen((current) => !current)}
                aria-expanded={sourceDetailsOpen}
              >
                <span>路径信息</span>
                <ChevronDown size={14} />
              </button>
              {sourceDetailsOpen ? (
                <div className="source-details-body">
                  <span>库内</span>
                  <button className="source-path" onClick={() => locateAssetFile(inspectorAsset)} title={inspectorAsset.source || inspectorAsset.originalSource || ""}>
                    {inspectorAsset.source || inspectorAsset.originalSource || "未知来源"}
                  </button>
                  <span>原始</span>
                  <button
                    className="source-path"
                    onClick={() => locateOriginalSource(inspectorAsset)}
                    title={inspectorAsset.originalSource || inspectorAsset.source || ""}
                  >
                    {inspectorAsset.originalSource || "未记录"}
                  </button>
                </div>
              ) : null}
            </section>

            <div className="field-group">
              <label>标签</label>
              <div className="detail-tags">
                {inspectorAsset.tags.map((tag) => (
                  <button key={tag} onClick={() => removeTagFromSelectedAsset(tag)} title="点击移除标签">
                    {tag}
                    <X size={12} />
                  </button>
                ))}
                <button onClick={addTagToSelectedAsset}>
                  <Plus size={13} />
                  新建标签
                </button>
                {tagsAvailableForInspector.length > 0 ? (
                  <select
                    className="existing-tag-select"
                    value=""
                    onChange={(event) => {
                      addExistingTagToSelectedAsset(event.target.value);
                      event.target.value = "";
                    }}
                    aria-label="添加已有标签"
                    title="添加已有标签"
                  >
                    <option value="">添加已有</option>
                    {tagsAvailableForInspector.map((tag) => (
                      <option key={tag} value={tag}>
                        {tag}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
            </div>

          </div>
        ) : (
          <div className="empty-inspector">
            <Tags size={28} />
            <p>选择素材后可以编辑标题、备注、分类和标签</p>
          </div>
        )}
      </aside>

      <footer className="statusbar">
        <span>
          <MousePointer2 size={14} />
          {filteredAssets.length} 个素材
        </span>
        <span>
          <PanelRight size={14} />
          白板缩放 {Math.round(zoom * 100)}%
        </span>
        <span>
          <Clipboard size={14} />
          支持拖放导入
        </span>
        <span>
          <Sparkles size={14} />
          可指定白板打开无边框浮窗
        </span>
      </footer>

      {toast ? (
        <div className="toast">
          <Star size={16} />
          {toast}
        </div>
      ) : null}

      {boardManagerOpen ? (
        <div className="dialog-backdrop board-manager-backdrop" onMouseDown={() => setBoardManagerOpen(false)}>
          <section className="board-manager" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="board-manager-header">
              <div>
                <p>白板管理</p>
                <h2>{boards.length} 个白板</h2>
              </div>
              <div className="board-manager-actions">
                <button
                  type="button"
                  className="toolbar-button primary"
                  onClick={() => {
                    setBoardManagerOpen(false);
                    createBoard();
                  }}
                >
                  <Plus size={14} />
                  新建
                </button>
                <button type="button" className="icon-button" onClick={() => setBoardManagerOpen(false)} aria-label="关闭">
                  <X size={16} />
                </button>
              </div>
            </div>

            {boards.length === 0 ? (
              <div className="board-manager-empty">
                <FolderPlus size={30} />
                <strong>还没有白板</strong>
                <span>新建一个白板后，可以把参考图发送进去长期保存布局。</span>
              </div>
            ) : (
              <div className="board-manager-grid">
                {boards.map((board) => {
                  const previewItems = getBoardPreviewAssets(board.id);
                  return (
                    <article className={classNames("board-manager-card", activeBoardId === board.id && "active")} key={board.id}>
                      <button className="board-preview-button" onClick={() => selectBoardFromManager(board.id)} title={`打开 ${board.name}`}>
                        <div className="board-preview-mosaic">
                          {previewItems.length > 0 ? (
                            previewItems.map((asset) => <MediaElement key={asset.id} asset={asset} alt="" />)
                          ) : (
                            <div className="board-preview-empty">
                              <Images size={28} />
                            </div>
                          )}
                        </div>
                        <div className="board-manager-meta">
                          <strong>{board.name}</strong>
                          <span>{boardItems[board.id]?.length ?? 0} 个参考</span>
                        </div>
                      </button>
                      <div className="board-card-actions">
                        <button type="button" onClick={() => startRenameBoard(board)} title="重命名白板" aria-label="重命名白板">
                          <Search size={13} />
                        </button>
                        <button type="button" className="danger" onClick={() => confirmDeleteBoard(board)} title="删除白板" aria-label="删除白板">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      ) : null}

      {previewAsset ? (
        <div className="image-preview-backdrop" role="dialog" aria-modal="true" onMouseDown={() => setPreviewAssetId("")}>
          <section className="image-preview-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="image-preview-topbar">
              <button type="button" onClick={() => movePreviewAsset(-1)} aria-label="上一张" title="上一张">
                <ChevronLeft size={17} />
              </button>
              <div>
                <strong>{previewAsset.title}</strong>
                <span>
                  {previewAssetIndex + 1}/{previewAssets.length} · {previewAsset.dimensions || previewAsset.size}
                </span>
              </div>
              <button type="button" onClick={() => movePreviewAsset(1)} aria-label="下一张" title="下一张">
                <ChevronRight size={17} />
              </button>
              <button type="button" onClick={() => setPreviewAssetId("")} aria-label="关闭预览" title="关闭预览">
                <X size={17} />
              </button>
            </div>
            <div
              ref={previewStageRef}
              className={classNames(
                "image-preview-stage",
                isAssetVideo(previewAsset) && "is-video",
                !isAssetVideo(previewAsset) && previewZoom > 1 && "zoomed",
                previewPanState && "panning",
              )}
              onWheel={handlePreviewWheel}
              onPointerDown={startPreviewPan}
              onDoubleClick={togglePreviewZoom}
            >
              <div
                className="image-preview-viewport"
                style={
                  isAssetVideo(previewAsset)
                    ? undefined
                    : {
                        width: `${previewFitSize.width}px`,
                        height: `${previewFitSize.height}px`,
                        transform: `translate3d(calc(-50% + ${previewOffset.x}px), calc(-50% + ${previewOffset.y}px), 0) scale(${previewZoom})`,
                      }
                }
              >
                {isAssetVideo(previewAsset) ? (
                  <div className="image-preview-video-frame">
                    <InlineVideoMedia
                      asset={previewAsset}
                      alt={previewAsset.title}
                      preload="auto"
                      autoPlay
                      onVideoMetadata={(event) => syncAssetVideoDimensions(previewAsset, event.currentTarget)}
                    />
                  </div>
                ) : (
                  <MediaElement
                    asset={previewAsset}
                    alt={previewAsset.title}
                    onImageLoad={(event) => syncAssetDimensions(previewAsset, event.currentTarget)}
                  />
                )}
              </div>
            </div>
            <div className="image-preview-strip">
              {previewAssets.map((asset) => (
                <button
                  key={asset.id}
                  className={classNames("image-preview-thumb", asset.id === previewAsset.id && "active")}
                  onClick={() => {
                    setPreviewAssetId(asset.id);
                    setSelectedAssetId(asset.id);
                    setSelectedBoardItemId("");
                  }}
                  title={asset.title}
                  aria-label={`查看 ${asset.title}`}
                >
                  <MediaElement asset={asset} alt="" />
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {librarySwitcherMenu ? (
        <div
          className="sidebar-context-menu library-switcher-menu"
          style={{ left: librarySwitcherMenu.x, top: librarySwitcherMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" onClick={createLibrary}>
            <Plus size={14} />
            新建库
          </button>
          <button type="button" onClick={renameActiveLibrary}>
            <Pencil size={14} />
            修改名字
          </button>
          <button type="button" onClick={() => { setLibrarySwitcherMenu(null); setSettingsOpen(true); }}>
            <Settings size={14} />
            设置
          </button>
          <button type="button" className="danger" disabled={libraries.length <= 1} onClick={() => deleteLibrary(activeLibraryId)}>
            <Trash2 size={14} />
            删除库
          </button>
        </div>
      ) : null}

      {boardMenu && boardMenuTarget ? (
        <div className="sidebar-context-menu" style={{ left: boardMenu.x, top: boardMenu.y }}>
          <button onClick={() => startRenameBoard(boardMenuTarget)}>
            <Search size={14} />
            重命名白板
          </button>
          <button className="danger" onClick={() => confirmDeleteBoard(boardMenuTarget)}>
            <Trash2 size={14} />
            删除白板
          </button>
        </div>
      ) : null}

      {assetMenu && assetMenuTarget ? (
        <div className="sidebar-context-menu" style={{ left: assetMenu.x, top: assetMenu.y }}>
          {activeCollection === "board-assets" && assetMenuBoardTargets.length > 0 ? (
            <button onClick={() => addBoardAssetsToLibrary(assetMenuBoardTargets.map((asset) => asset.id))}>
              <LibraryBig size={14} />
              {assetMenuBoardTargets.length > 1 ? `添加 ${assetMenuBoardTargets.length} 项入库` : "添加入库"}
            </button>
          ) : null}
          {assetMenuTargetIds.length === 1 && canRenameLibraryAsset(assetMenuTarget) ? (
            <button onClick={() => startRenameAsset(assetMenuTarget)}>
              <Search size={14} />
              重命名文件
            </button>
          ) : null}
          <button onClick={() => refreshAssetReferences(assetMenuTargetIds)}>
            <RefreshCw size={14} />
            {assetMenuTargetIds.length > 1 ? `刷新 ${assetMenuTargetIds.length} 项` : "刷新此素材"}
          </button>
          <button onClick={() => locateAssetFile(assetMenuTarget)}>
            <FolderOpen size={14} />
            定位文件
          </button>
          {assetMenuAllTrashed ? (
            <button onClick={() => restoreAssetsByIds(assetMenuTargetIds)}>
              <RefreshCw size={14} />
              {assetMenuTargetIds.length > 1 ? `恢复 ${assetMenuTargetIds.length} 项` : "恢复素材"}
            </button>
          ) : null}
          <button className="danger" onClick={() => confirmDeleteAssets(assetMenuTargetIds)}>
            <Trash2 size={14} />
            {assetMenuAllTrashed
              ? assetMenuTargetIds.length > 1
                ? `彻底删除 ${assetMenuTargetIds.length} 项`
                : "彻底删除"
              : assetMenuTargetIds.length > 1
                ? `移动 ${assetMenuTargetIds.length} 项到垃圾桶`
                : "移到垃圾桶"}
          </button>
        </div>
      ) : null}

      {libraryMenu ? (
        <div className="sidebar-context-menu" style={{ left: libraryMenu.x, top: libraryMenu.y }}>
          <button onClick={() => refreshAssetReferences()}>
            <RefreshCw size={14} />
            刷新素材库
          </button>
        </div>
      ) : null}

      {!onboardingComplete ? (
        <div className="dialog-backdrop onboarding-backdrop">
          <form className="setup-dialog" onSubmit={finishOnboarding}>
            <div className="setup-dialog-heading">
              <LibraryBig size={22} />
              <div>
                <p>首次使用</p>
                <h2>创建你的素材库</h2>
              </div>
            </div>
            <label>
              <span>素材库名称</span>
              <input value={onboardingName} onChange={(event) => setOnboardingName(event.target.value)} autoFocus placeholder="例如：日常收集" />
            </label>
            <div className="settings-field">
              <span>保存位置</span>
              <button type="button" className="path-picker" onClick={chooseOnboardingLibraryRoot} title={libraryRoot || "选择保存位置"}>
                <FolderOpen size={15} />
                <strong>{libraryRoot || "选择文件夹"}</strong>
                <span>更改</span>
              </button>
            </div>
            <fieldset className="import-mode-options">
              <legend>本机文件导入方式</legend>
              <label className={classNames(onboardingImportMode === "copy" && "active")}>
                <input type="radio" name="onboarding-import-mode" value="copy" checked={onboardingImportMode === "copy"} onChange={() => setOnboardingImportMode("copy")} />
                <HardDrive size={17} />
                <span><strong>复制副本</strong><small>集中管理，原文件移动后仍可使用</small></span>
              </label>
              <label className={classNames(onboardingImportMode === "reference" && "active")}>
                <input type="radio" name="onboarding-import-mode" value="reference" checked={onboardingImportMode === "reference"} onChange={() => setOnboardingImportMode("reference")} />
                <Link2 size={17} />
                <span><strong>引用原文件</strong><small>不额外占用空间，原文件不能随意移动</small></span>
              </label>
            </fieldset>
            <div className="dialog-actions">
              <button type="submit" className="primary">开始使用</button>
            </div>
          </form>
        </div>
      ) : null}

      {settingsOpen ? (
        <div className="dialog-backdrop" onMouseDown={() => setSettingsOpen(false)}>
          <section className="settings-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="dialog-title">
              <div>
                <span>当前素材库</span>
                <strong>{activeLibrary?.name || "素材库"}</strong>
              </div>
              <button type="button" onClick={() => setSettingsOpen(false)} aria-label="关闭"><X size={15} /></button>
            </div>
            <div className="settings-section">
              <div className="settings-section-heading">
                <strong>文件管理</strong>
                <span>这些设置仅作用于当前素材库</span>
              </div>
              <div className="settings-field">
                <span>保存位置</span>
                <button type="button" className="path-picker" onClick={chooseLibraryRoot} title={libraryRoot || "选择保存位置"}>
                  <FolderOpen size={15} />
                  <strong>{libraryRoot || "尚未设置"}</strong>
                  <span>更改</span>
                </button>
              </div>
              <fieldset className="import-mode-options compact">
                <legend>本机文件导入方式</legend>
                <label className={classNames(activeImportMode === "copy" && "active")}>
                  <input type="radio" name="settings-import-mode" value="copy" checked={activeImportMode === "copy"} onChange={() => updateActiveLibraryImportMode("copy")} />
                  <HardDrive size={17} />
                  <span><strong>复制副本</strong><small>复制到当前库的保存位置</small></span>
                </label>
                <label className={classNames(activeImportMode === "reference" && "active")}>
                  <input type="radio" name="settings-import-mode" value="reference" checked={activeImportMode === "reference"} onChange={() => updateActiveLibraryImportMode("reference")} />
                  <Link2 size={17} />
                  <span><strong>引用原文件</strong><small>只保存路径，不复制本机文件</small></span>
                </label>
              </fieldset>
              <p className="settings-note">网页、剪贴板和外部白板中的素材仍会复制进库，以保证内容可以长期使用。</p>
            </div>
          </section>
        </div>
      ) : null}

      {nameDialog ? (
        <div className="dialog-backdrop" onMouseDown={closeNameDialog}>
          <form className="name-dialog" onSubmit={submitNameDialog} onMouseDown={(event) => event.stopPropagation()}>
            <div className="dialog-title">
              <strong>{nameDialog.title}</strong>
              <button type="button" onClick={closeNameDialog} aria-label="关闭">
                <X size={15} />
              </button>
            </div>
            <label>
              <span>{nameDialog.label}</span>
              <input
                autoFocus
                value={nameInput}
                onChange={(event) => setNameInput(event.target.value)}
                placeholder={nameDialog.placeholder}
              />
            </label>
            <div className="dialog-actions">
              <button type="button" onClick={closeNameDialog}>
                取消
              </button>
              <button type="submit" className="primary">
                确认
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {confirmDialog ? (
        <div className="dialog-backdrop" onMouseDown={closeConfirmDialog}>
          <section className="confirm-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="dialog-title">
              <strong>{confirmDialog.title}</strong>
              <button type="button" onClick={closeConfirmDialog} aria-label="关闭">
                <X size={15} />
              </button>
            </div>
            <p>{confirmDialog.message}</p>
            <div className="dialog-actions">
              <button type="button" onClick={closeConfirmDialog}>
                取消
              </button>
              <button type="button" className="danger" onClick={submitConfirmDialog}>
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function Canvas({
  activeBoardId,
  activeBoardName,
  addNote,
  arrangeBoard,
  assets,
  boardSelectionRequest,
  boardViewStates,
  boardItems,
  checkpointBoardItems,
  deleteBoardItems,
  floatingLaunchActive,
  openFloatingBoard,
  pasteImagesToBoard,
  selectedBoardItemId,
  setSelectedAssetId,
  setSelectedBoardItemId,
  setBoardItems,
  setBoardViewStates,
  setZoom: setWorkspaceZoom,
  setZoomAroundViewportCenterRef,
  startDrag,
  stopDrag,
  undoBoardItems,
  redoBoardItems,
  updateBoardItem,
  zoom: workspaceZoom,
}) {
  const hasBoard = Boolean(activeBoardId && activeBoardName);
  const activeItems = hasBoard ? (boardItems[activeBoardId] ?? []) : [];
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const activeItemIdSet = useMemo(() => new Set(activeItems.map((item) => item.id)), [activeItems]);
  const [viewportOffset, setViewportOffset] = useState({ x: 0, y: 0 });
  const [panState, setPanState] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [selectedBoardItemIds, setSelectedBoardItemIds] = useState(() => new Set());
  const [selectionBox, setSelectionBox] = useState(null);
  const [canvasPreviewAssetId, setCanvasPreviewAssetId] = useState("");
  const [resizeState, setResizeState] = useState(null);
  const [editingNoteId, setEditingNoteId] = useState("");
  const [zoom, setCanvasZoom] = useState(workspaceZoom);
  const availableNoteFonts = useNoteFontOptions();
  const contextMenuItem = contextMenu?.itemId ? activeItems.find((item) => item.id === contextMenu.itemId) : null;
  const contextMenuIsNote = contextMenuItem?.type === "note";
  const selectedCanvasItems = activeItems.filter((item) => selectedBoardItemIds.has(item.id));
  const canvasPreviewAsset = assetById.get(canvasPreviewAssetId);
  const groupSelectionBox = selectedCanvasItems.length > 1 ? createResizeSnapshot(selectedCanvasItems)?.box : null;
  const frameRef = useRef(null);
  const surfaceRef = useRef(null);
  const consumedSelectionRequestRef = useRef(null);
  const clipboardPasteGenerationRef = useRef(0);
  const clipboardPasteAnchorRef = useRef(null);
  const activeBoardIdRef = useRef(activeBoardId);
  const zoomRef = useRef(workspaceZoom);
  const viewportOffsetRef = useRef(viewportOffset);
  const wheelZoomFrameRef = useRef(0);
  const wheelZoomCommitTimerRef = useRef(0);

  const applyCanvasTransform = useCallback((offset = viewportOffsetRef.current, nextZoom = zoomRef.current) => {
    const surface = surfaceRef.current;
    if (!surface) return;
    surface.style.transform = viewportTransform(offset, nextZoom);
    surface.style.setProperty("--selection-control-scale", String(1 / nextZoom));
    surface.style.setProperty("--selection-outline-width", `${2 / nextZoom}px`);
    surface.style.setProperty("--selection-stroke-width", `${1 / nextZoom}px`);
    surface.style.setProperty("--selection-toolbar-gap", `${8 / nextZoom}px`);
  }, []);

  const rememberCanvasView = useCallback((boardId, offset = viewportOffsetRef.current, nextZoom = zoomRef.current) => {
    if (!boardId) return;
    const nextView = {
      x: Number.isFinite(Number(offset?.x)) ? Number(offset.x) : 0,
      y: Number.isFinite(Number(offset?.y)) ? Number(offset.y) : 0,
      zoom: clampNumber(Number(nextZoom) || defaultBoardZoom, minBoardZoom, maxBoardZoom),
    };
    setBoardViewStates((current) => {
      const currentViews = current && typeof current === "object" && !Array.isArray(current) ? current : {};
      const previous = currentViews[boardId];
      if (
        previous &&
        Math.abs(Number(previous.x) - nextView.x) < 0.01 &&
        Math.abs(Number(previous.y) - nextView.y) < 0.01 &&
        Math.abs(Number(previous.zoom) - nextView.zoom) < 0.0001
      ) {
        return currentViews;
      }
      return { ...currentViews, [boardId]: nextView };
    });
  }, [setBoardViewStates]);

  useEffect(() => {
    if (Math.abs(workspaceZoom - zoomRef.current) < 0.0001) return;
    zoomRef.current = workspaceZoom;
    setCanvasZoom(workspaceZoom);
  }, [workspaceZoom]);

  useEffect(() => {
    viewportOffsetRef.current = viewportOffset;
  }, [viewportOffset]);

  useLayoutEffect(() => {
    applyCanvasTransform(viewportOffset, zoom);
  }, [applyCanvasTransform, viewportOffset, zoom]);

  useEffect(() => {
    return () => {
      if (wheelZoomFrameRef.current) window.cancelAnimationFrame(wheelZoomFrameRef.current);
      window.clearTimeout(wheelZoomCommitTimerRef.current);
    };
  }, []);

  useLayoutEffect(() => {
    const previousBoardId = activeBoardIdRef.current;
    if (previousBoardId && previousBoardId !== activeBoardId) {
      rememberCanvasView(previousBoardId);
    }
    activeBoardIdRef.current = activeBoardId;

    const storedView = boardViewStates?.[activeBoardId];
    const restoredOffset = {
      x: Number.isFinite(Number(storedView?.x)) ? Number(storedView.x) : 0,
      y: Number.isFinite(Number(storedView?.y)) ? Number(storedView.y) : 0,
    };
    const restoredZoom = clampNumber(Number(storedView?.zoom) || defaultBoardZoom, minBoardZoom, maxBoardZoom);
    viewportOffsetRef.current = restoredOffset;
    zoomRef.current = restoredZoom;
    setViewportOffset(restoredOffset);
    setCanvasZoom(restoredZoom);
    setWorkspaceZoom(restoredZoom);
    setPanState(null);
    setContextMenu(null);
    setSelectedBoardItemIds(new Set());
    setSelectionBox(null);
    setResizeState(null);
    setEditingNoteId("");
    clipboardPasteGenerationRef.current = 0;
    clipboardPasteAnchorRef.current = null;
  }, [activeBoardId]);

  useEffect(() => {
    const itemIds = new Set(activeItems.map((item) => item.id));
    setSelectedBoardItemIds((current) => {
      const next = new Set(Array.from(current).filter((itemId) => itemIds.has(itemId)));
      return next.size === current.size ? current : next;
    });
  }, [activeItems]);

  useLayoutEffect(() => {
    if (!activeBoardId) return;
    setBoardItems((current) => {
      const currentItems = current[activeBoardId] ?? [];
      const normalizedItems = normalizeBoardTextNodes(currentItems, availableNoteFonts);
      return normalizedItems === currentItems ? current : { ...current, [activeBoardId]: normalizedItems };
    });
  }, [activeBoardId, availableNoteFonts, setBoardItems]);

  useEffect(() => {
    if (!boardSelectionRequest || boardSelectionRequest.boardId !== activeBoardId) return;
    if (consumedSelectionRequestRef.current === boardSelectionRequest.token) return;
    const nextIds = (boardSelectionRequest.itemIds ?? []).filter((itemId) => activeItemIdSet.has(itemId));
    consumedSelectionRequestRef.current = boardSelectionRequest.token;
    setSelectedBoardItemIds(new Set(nextIds));
    setSelectedBoardItemId(nextIds[0] ?? "");
    if (boardSelectionRequest.fitItems && nextIds.length > 0) {
      window.requestAnimationFrame(() => {
        const frameRect = frameRef.current?.getBoundingClientRect();
        const selectedItems = activeItems.filter((item) => nextIds.includes(item.id));
        const bounds = boundsFromItems(selectedItems);
        if (!frameRect || !bounds) return;

        const contentWidth = Math.max(1, bounds.right - bounds.left);
        const contentHeight = Math.max(1, bounds.bottom - bounds.top);
        const padding = 72;
        const fittedZoom = clampNumber(
          Math.min(
            Math.max(1, frameRect.width - padding * 2) / contentWidth,
            Math.max(1, frameRect.height - padding * 2) / contentHeight,
            1,
          ),
          minBoardZoom,
          maxBoardZoom,
        );
        const centerX = (bounds.left + bounds.right) / 2;
        const centerY = (bounds.top + bounds.bottom) / 2;
        const fittedOffset = {
          x: frameRect.width / 2 - centerX * fittedZoom,
          y: frameRect.height / 2 - centerY * fittedZoom,
        };
        const nextZoom = Number(fittedZoom.toFixed(4));
        viewportOffsetRef.current = fittedOffset;
        zoomRef.current = nextZoom;
        setViewportOffset(fittedOffset);
        setCanvasZoom(nextZoom);
        setWorkspaceZoom(nextZoom);
        rememberCanvasView(activeBoardId, fittedOffset, nextZoom);
      });
    }
    if (boardSelectionRequest.focusText && nextIds[0]) {
      setEditingNoteId(nextIds[0]);
      window.requestAnimationFrame(() => {
        const textarea = frameRef.current?.querySelector(`[data-note-id="${nextIds[0]}"] textarea`);
        textarea?.focus?.({ preventScroll: true });
        if (boardSelectionRequest.selectText) textarea?.select?.();
      });
    }
  }, [activeBoardId, activeItemIdSet, activeItems, boardSelectionRequest, rememberCanvasView, setSelectedBoardItemId, setWorkspaceZoom]);

  useEffect(() => {
    if (!panState) return undefined;

    const scheduledMove = createPointerMoveScheduler((clientX, clientY) => {
      const nextOffset = {
        x: panState.originX + clientX - panState.startX,
        y: panState.originY + clientY - panState.startY,
      };
      viewportOffsetRef.current = nextOffset;
      applyCanvasTransform(nextOffset, zoomRef.current);
    });
    const move = (event) => scheduledMove.move(event);
    const stop = () => {
      scheduledMove.flush();
      setViewportOffset({ ...viewportOffsetRef.current });
      rememberCanvasView(activeBoardId);
      setPanState(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
    return () => {
      scheduledMove.cancel();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
    };
  }, [activeBoardId, applyCanvasTransform, panState, rememberCanvasView]);

  useEffect(() => {
    if (!resizeState) return undefined;

    const scheduledMove = createPointerMoveScheduler((clientX, clientY) => {
      const dx = (clientX - resizeState.startX) / zoom;
      const dy = (clientY - resizeState.startY) / zoom;
      const scale = resizeScaleFromSnapshot(resizeState.snapshot, dx, dy, resizeState.handle);

      setBoardItems((current) => ({
        ...current,
        [activeBoardId]: (current[activeBoardId] ?? []).map((item) => applyResizeSnapshot(item, resizeState.snapshot, scale, resizeState.handle)),
      }));
    });
    const move = (event) => scheduledMove.move(event);
    const stop = () => {
      scheduledMove.flush();
      setResizeState(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
    return () => {
      scheduledMove.cancel();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
    };
  }, [activeBoardId, resizeState, setBoardItems, zoom]);

  useEffect(() => {
    if (selectedBoardItemIds.size === 0) return undefined;

    const handleKeyDown = (event) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (isTextEditingTarget(event.target) || canvasPreviewAssetId) return;
      event.preventDefault();
      deleteBoardItems(selectedBoardItemIds);
      setSelectedBoardItemIds(new Set());
      setSelectedBoardItemId("");
      setContextMenu(null);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canvasPreviewAssetId, deleteBoardItems, selectedBoardItemIds, setSelectedBoardItemId]);

  useEffect(() => {
    if (selectedBoardItemIds.size === 0) return undefined;

    const handleArrangementKeyDown = (event) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTextEditingTarget(event.target) || canvasPreviewAssetId) return;
      const anchor = keyboardArrangementKeys[event.key.toLowerCase()];
      if (!anchor) return;
      // 焦点在画布内才响应，避免在素材库等其它区域按键时波及白板选区。
      const frame = frameRef.current;
      const activeElement = document.activeElement;
      if (!frame || (activeElement !== frame && !frame.contains(activeElement))) return;
      if (document.querySelector(".dialog-backdrop")) return;
      const positions = keyboardArrangementPositions(activeItems, selectedBoardItemIds, anchor);
      if (!positions) return;
      event.preventDefault();
      event.stopPropagation();
      // 长按自动重复时合并为一次撤销步。
      if (!event.repeat) checkpointBoardItems(activeBoardId);
      setBoardItems((current) => ({
        ...current,
        [activeBoardId]: (current[activeBoardId] ?? []).map((item) => (positions[item.id] ? { ...item, ...positions[item.id] } : item)),
      }));
      setContextMenu(null);
    };

    window.addEventListener("keydown", handleArrangementKeyDown);
    return () => window.removeEventListener("keydown", handleArrangementKeyDown);
  }, [activeBoardId, activeItems, canvasPreviewAssetId, checkpointBoardItems, selectedBoardItemIds, setBoardItems]);

  useEffect(() => {
    const handleCanvasPreviewKeyDown = (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTextEditingTarget(event.target)) return;
      if (canvasPreviewAssetId) {
        if (event.code !== "Space" && event.key !== "Escape") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        closeCanvasPreview();
        return;
      }
      if (event.code !== "Space") return;
      // 焦点在画布内才响应，避免和素材库的空格预览互相顶掉。
      const frame = frameRef.current;
      const activeElement = document.activeElement;
      if (!frame || (activeElement !== frame && !frame.contains(activeElement))) return;
      const targetAsset = selectedCanvasItems.map((item) => assetById.get(item.assetId)).find(Boolean);
      if (!targetAsset) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setCanvasPreviewAssetId(targetAsset.id);
    };

    window.addEventListener("keydown", handleCanvasPreviewKeyDown);
    return () => window.removeEventListener("keydown", handleCanvasPreviewKeyDown);
  }, [assetById, canvasPreviewAssetId, selectedCanvasItems]);

  useEffect(() => {
    const handleHistoryKeyDown = (event) => {
      if (event.defaultPrevented || isTextEditingTarget(event.target)) return;
      if (!event.ctrlKey && !event.metaKey) return;
      const frame = frameRef.current;
      const activeElement = document.activeElement;
      if (!frame || (activeElement !== frame && !frame.contains(activeElement))) return;

      const key = event.key.toLowerCase();
      const wantsUndo = key === "z" && !event.shiftKey;
      const wantsRedo = (key === "z" && event.shiftKey) || key === "y";
      if (!wantsUndo && !wantsRedo) return;

      const restored = wantsRedo ? redoBoardItems(activeBoardId) : undoBoardItems(activeBoardId);
      if (!restored) return;
      event.preventDefault();
      event.stopPropagation();
      setSelectedBoardItemIds(new Set());
      setSelectedBoardItemId("");
      setEditingNoteId("");
      setContextMenu(null);
    };

    window.addEventListener("keydown", handleHistoryKeyDown, true);
    return () => window.removeEventListener("keydown", handleHistoryKeyDown, true);
  }, [activeBoardId, redoBoardItems, setSelectedBoardItemId, undoBoardItems]);

  function handleCanvasWheel(event) {
    event.preventDefault();
    const frameRect = frameRef.current?.getBoundingClientRect();
    if (!frameRect) return;

    const deltaScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frameRect.height : 1;
    const normalizedDelta = clampNumber(event.deltaY * deltaScale, -240, 240);
    const currentZoom = zoomRef.current;
    const currentOffset = viewportOffsetRef.current;
    const nextZoom = clampNumber(
      Number((currentZoom * Math.exp(-normalizedDelta * 0.0015)).toFixed(4)),
      minBoardZoom,
      maxBoardZoom,
    );
    if (nextZoom === currentZoom) return;
    startViewportComposite(frameRef.current);

    const anchorX = event.clientX - frameRect.left;
    const anchorY = event.clientY - frameRect.top;
    const boardX = (anchorX - currentOffset.x) / currentZoom;
    const boardY = (anchorY - currentOffset.y) / currentZoom;
    zoomRef.current = nextZoom;
    viewportOffsetRef.current = {
      x: anchorX - boardX * nextZoom,
      y: anchorY - boardY * nextZoom,
    };

    if (!wheelZoomFrameRef.current) {
      wheelZoomFrameRef.current = window.requestAnimationFrame(() => {
        wheelZoomFrameRef.current = 0;
        applyCanvasTransform(viewportOffsetRef.current, zoomRef.current);
      });
    }

    window.clearTimeout(wheelZoomCommitTimerRef.current);
    wheelZoomCommitTimerRef.current = window.setTimeout(() => {
      setCanvasZoom(zoomRef.current);
      setViewportOffset({ ...viewportOffsetRef.current });
      setWorkspaceZoom(zoomRef.current);
      rememberCanvasView(activeBoardId);
      settleViewportComposite(frameRef.current, surfaceRef.current, () => {
        applyCanvasTransform(viewportOffsetRef.current, zoomRef.current);
      });
    }, 90);
  }

  async function addDroppedAssetsToCanvas(assetIds, clientX, clientY) {
    if (!hasBoard) return;

    const targetAssets = Array.from(new Set(assetIds ?? []))
      .map((assetId) => assetById.get(assetId))
      .filter(Boolean);
    if (targetAssets.length === 0) return;

    const frameRect = frameRef.current?.getBoundingClientRect();
    const fallbackIndex = activeItems.length;
    const startX = frameRect ? (clientX - frameRect.left - viewportOffset.x) / zoom : 96 + ((fallbackIndex * 92) % 420);
    const startY = frameRect ? (clientY - frameRect.top - viewportOffset.y) / zoom : 90 + ((fallbackIndex * 118) % 320);
    const timestamp = Date.now();
    const preparedItems = [];

    for (const [index, asset] of targetAssets.entries()) {
      const storedDimensions = getStoredImageDimensions(asset);
      const loadedDimensions = storedDimensions ?? (await readAssetDimensions(asset));
      const nodeSize = fitImageNodeSize(loadedDimensions);
      const column = index % 3;
      const row = Math.floor(index / 3);
      preparedItems.push({
        id: `i-${timestamp}-${index}-${Math.random().toString(36).slice(2, 7)}`,
        assetId: asset.id,
        x: Math.round(startX - nodeSize.width / 2 + column * nodeSize.width),
        y: Math.round(startY - nodeSize.height / 2 + row * nodeSize.height),
        width: nodeSize.width,
        height: nodeSize.height,
        note: "拖入白板",
      });
    }

    checkpointBoardItems(activeBoardId);
    setBoardItems((current) => ({
      ...current,
      [activeBoardId]: [...(current[activeBoardId] ?? []), ...preparedItems],
    }));
    setSelectedAssetId(targetAssets[0].id);
    setSelectedBoardItemId(preparedItems[0].id);
    setSelectedBoardItemIds(new Set(preparedItems.map((item) => item.id)));
    setContextMenu(null);
  }

  function isAssetDrag(event) {
    return hasAssetDragData(event.dataTransfer);
  }

  function isExternalImageDrag(event) {
    return isExternalMediaDrag(event);
  }

  function handleCanvasDragOver(event) {
    if (!hasBoard || (!isAssetDrag(event) && !isExternalImageDrag(event))) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  async function handleCanvasDrop(event) {
    if (!hasBoard) return;
    if (!isAssetDrag(event) && !isExternalImageDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (isAssetDrag(event)) {
      addDroppedAssetsToCanvas(readAssetDragIds(event.dataTransfer), event.clientX, event.clientY);
      return;
    }

    const existingAssetIds = assetIdsFromDroppedFiles(event.dataTransfer.files, assets);
    if (existingAssetIds.length > 0) {
      addDroppedAssetsToCanvas(existingAssetIds, event.clientX, event.clientY);
      return;
    }

    const metadata = getDropImportMetadata(event.dataTransfer);
    await pasteImagesToBoard?.(event.dataTransfer.files, metadata, canvasPointFromClient(event.clientX, event.clientY));
  }

  function startCanvasPan(event) {
    if (event.button !== 1) return;
    event.preventDefault();
    setContextMenu(null);
    setPanState({
      startX: event.clientX,
      startY: event.clientY,
      originX: viewportOffset.x,
      originY: viewportOffset.y,
    });
  }

  function startCanvasSelection(event) {
    if (event.button !== 0 || !hasBoard) return;
    if (event.target.closest?.(".board-item, .board-note, .board-context-menu")) return;

    setContextMenu(null);
    const startX = event.clientX;
    const startY = event.clientY;
    const baseSelection = new Set(selectedBoardItemIds);
    const liveModifiers = { shiftKey: event.shiftKey, ctrlKey: event.ctrlKey || event.metaKey };
    let selecting = false;

    const applySelection = (clientX, clientY) => {
      const frameRect = frameRef.current?.getBoundingClientRect();
      if (!frameRect) return;

      const left = Math.min(startX, clientX);
      const top = Math.min(startY, clientY);
      const right = Math.max(startX, clientX);
      const bottom = Math.max(startY, clientY);
      setSelectionBox({ left, top, width: right - left, height: bottom - top });

      const hitIds = activeItems
        .filter((item) => {
          const itemLeft = frameRect.left + viewportOffset.x + item.x * zoom;
          const itemTop = frameRect.top + viewportOffset.y + item.y * zoom;
          const itemRight = itemLeft + item.width * zoom;
          const itemBottom = itemTop + item.height * zoom;
          return itemLeft < right && itemRight > left && itemTop < bottom && itemBottom > top;
        })
        .map((item) => item.id);

      const mode = selectionModifierFromEvent(liveModifiers);
      const nextSelectedIds = combineSelection(baseSelection, hitIds, mode);
      setSelectedBoardItemIds(nextSelectedIds);
      if (mode === "replace") {
        setSelectedBoardItemId(hitIds[0] ?? "");
      } else {
        // 焦点素材被减选掉时同步清空，否则它仍会显示为选中。
        setSelectedBoardItemId((current) => (current && !nextSelectedIds.has(current) ? "" : current));
      }
    };

    const move = (moveEvent) => {
      liveModifiers.shiftKey = moveEvent.shiftKey;
      liveModifiers.ctrlKey = moveEvent.ctrlKey || moveEvent.metaKey;
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!selecting && Math.hypot(dx, dy) > 5) {
        selecting = true;
      }
      if (selecting) {
        moveEvent.preventDefault();
        applySelection(moveEvent.clientX, moveEvent.clientY);
      }
    };

    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("mouseup", stop);
      if (!selecting && selectionModifierFromEvent(liveModifiers) === "replace") {
        setSelectedBoardItemIds(new Set());
        setSelectedBoardItemId("");
      }
      setSelectionBox(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("mouseup", stop);
  }

  function handleCanvasPointerDown(event) {
    frameRef.current?.focus?.({ preventScroll: true });
    clipboardPasteAnchorRef.current = canvasPointFromClient(event.clientX, event.clientY);
    if (event.button === 1) {
      startCanvasPan(event);
      return;
    }
    startCanvasSelection(event);
  }

  function handleCanvasPointerMove(event) {
    clipboardPasteAnchorRef.current = canvasPointFromClient(event.clientX, event.clientY);
  }

  function applyCanvasSelectionModifier(modifier, itemId) {
    setSelectedBoardItemIds((current) => {
      const next = new Set(current);
      if (modifier === "add") next.add(itemId);
      else next.delete(itemId);
      return next;
    });
    // 减选后焦点不能停在已取消选中的素材上，否则它仍会显示为选中。
    setSelectedBoardItemId((current) => (modifier === "add" ? itemId : current === itemId ? "" : current));
  }

  // 整组选框会盖住组内素材，修饰键点选需要按坐标命中最上层素材。
  function canvasItemAtClientPoint(clientX, clientY) {
    const point = canvasPointFromClient(clientX, clientY);
    for (let index = activeItems.length - 1; index >= 0; index -= 1) {
      const item = activeItems[index];
      if (point.x >= item.x && point.x <= item.x + item.width && point.y >= item.y && point.y <= item.y + item.height) return item;
    }
    return null;
  }

  function startCanvasItemDrag(event, item) {
    if (editingNoteId === item.id) return;
    frameRef.current?.focus?.({ preventScroll: true });
    const modifier = selectionModifierFromEvent(event);
    if (event.button === 0 && modifier !== "replace") {
      setContextMenu(null);
      applyCanvasSelectionModifier(modifier, item.id);
      return;
    }
    beginCanvasItemDrag(event, item);
  }

  function beginCanvasItemDrag(event, item) {
    setEditingNoteId("");
    if (event.button === 0 && item.assetId) {
      setBoardItems((current) => {
        const currentItems = current[activeBoardId] ?? [];
        const nextItems = bringBoardItemToFront(currentItems, item.id);
        return nextItems === currentItems ? current : { ...current, [activeBoardId]: nextItems };
      });
    }
    const draggingIds = event.button === 0 && selectedBoardItemIds.has(item.id) ? Array.from(selectedBoardItemIds) : [item.id];
    if (event.button === 0) {
      setSelectedBoardItemIds(new Set(draggingIds));
    }
    startDrag(event, item, draggingIds, activeItems);
  }

  function startCanvasGroupDrag(event) {
    if (event.button !== 0 || selectedCanvasItems.length < 2) return;
    // 按住 Shift / Ctrl 时只调整选区：点到组内素材按素材加选/减选，空白处让位给框选。
    const modifier = selectionModifierFromEvent(event);
    if (modifier !== "replace") {
      const hitItem = canvasItemAtClientPoint(event.clientX, event.clientY);
      if (hitItem) {
        setContextMenu(null);
        applyCanvasSelectionModifier(modifier, hitItem.id);
      }
      return;
    }
    beginCanvasItemDrag(event, selectedCanvasItems[0]);
  }

  function startCanvasResize(event, item, handle = "se") {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    frameRef.current?.focus?.({ preventScroll: true });
    setContextMenu(null);

    const candidateIds = selectedBoardItemIds.has(item.id) ? selectedBoardItemIds : new Set([item.id]);
    const resizingItems = activeItems.filter((candidate) => candidateIds.has(candidate.id));
    const snapshot = createResizeSnapshot(resizingItems);
    if (!snapshot) return;

    checkpointBoardItems(activeBoardId);
    setSelectedBoardItemIds(new Set(snapshot.ids));
    setSelectedBoardItemId(item.id);
    if (item.assetId) setSelectedAssetId(item.assetId);
    setResizeState({ startX: event.clientX, startY: event.clientY, snapshot, handle });
  }

  function syncCanvasItemAspect(item, imageElement) {
    const naturalWidth = imageElement?.naturalWidth || imageElement?.videoWidth;
    const naturalHeight = imageElement?.naturalHeight || imageElement?.videoHeight;
    if (!(naturalWidth > 0) || !(naturalHeight > 0)) return;

    const naturalAspect = naturalWidth / naturalHeight;
    const currentAspect = item.width / item.height;
    if (Math.abs(currentAspect - naturalAspect) / naturalAspect < 0.08) return;

    const nextSize = fitImageNodeSizeToExistingFrame({ width: naturalWidth, height: naturalHeight }, item);
    if (!nextSize) return;
    updateBoardItem(item.id, nextSize);
  }

  function deleteCanvasItem(event, item) {
    event.preventDefault();
    event.stopPropagation();
    frameRef.current?.focus?.({ preventScroll: true });
    setSelectedBoardItemId(item.id);
    if (item.assetId) setSelectedAssetId(item.assetId);
    if (!selectedBoardItemIds.has(item.id)) {
      setSelectedBoardItemIds(new Set([item.id]));
    }
    setContextMenu({ x: event.clientX, y: event.clientY, itemId: item.id });
  }

  function canvasPointFromClient(clientX, clientY) {
    const frameRect = frameRef.current?.getBoundingClientRect();
    if (!frameRect) return { x: 96, y: 96 };
    const currentOffset = viewportOffsetRef.current;
    const currentZoom = zoomRef.current;
    return {
      x: (clientX - frameRect.left - currentOffset.x) / currentZoom,
      y: (clientY - frameRect.top - currentOffset.y) / currentZoom,
    };
  }

  function canvasClientPointFromBoard(point) {
    const frameRect = frameRef.current?.getBoundingClientRect();
    if (!frameRect) return { x: 0, y: 0 };
    const currentOffset = viewportOffsetRef.current;
    const currentZoom = zoomRef.current;
    return {
      x: frameRect.left + currentOffset.x + point.x * currentZoom,
      y: frameRect.top + currentOffset.y + point.y * currentZoom,
    };
  }

  function closeCanvasPreview() {
    setCanvasPreviewAssetId("");
    frameRef.current?.focus?.({ preventScroll: true });
  }

  function setCanvasZoomAnchored(nextZoom, anchorClientX, anchorClientY) {
    if (wheelZoomFrameRef.current) {
      window.cancelAnimationFrame(wheelZoomFrameRef.current);
      wheelZoomFrameRef.current = 0;
    }
    window.clearTimeout(wheelZoomCommitTimerRef.current);
    startViewportComposite(frameRef.current);

    const frameRect = frameRef.current?.getBoundingClientRect();
    if (!frameRect) {
      zoomRef.current = nextZoom;
      setCanvasZoom(nextZoom);
      setWorkspaceZoom(nextZoom);
      rememberCanvasView(activeBoardId, viewportOffsetRef.current, nextZoom);
      frameRef.current?.classList.remove("viewport-transforming");
      return;
    }

    const anchorX = anchorClientX - frameRect.left;
    const anchorY = anchorClientY - frameRect.top;
    const currentZoom = zoomRef.current;
    const currentOffset = viewportOffsetRef.current;
    const boardX = (anchorX - currentOffset.x) / currentZoom;
    const boardY = (anchorY - currentOffset.y) / currentZoom;
    const nextOffset = {
      x: anchorX - boardX * nextZoom,
      y: anchorY - boardY * nextZoom,
    };
    zoomRef.current = nextZoom;
    viewportOffsetRef.current = nextOffset;
    setViewportOffset(nextOffset);
    setCanvasZoom(nextZoom);
    setWorkspaceZoom(nextZoom);
    rememberCanvasView(activeBoardId, nextOffset, nextZoom);
    settleViewportComposite(frameRef.current, surfaceRef.current, () => applyCanvasTransform(nextOffset, nextZoom));
  }

  function changeCanvasZoom(delta, anchorClientX, anchorClientY, explicitZoom = null) {
    const currentZoom = zoomRef.current;
    const steppedZoom = delta === 0 ? currentZoom : currentZoom * (delta > 0 ? 1.16 : 1 / 1.16);
    const nextZoom = Math.min(
      maxBoardZoom,
      Math.max(minBoardZoom, Number((explicitZoom ?? steppedZoom).toFixed(4))),
    );
    if (nextZoom === currentZoom) return;
    setCanvasZoomAnchored(nextZoom, anchorClientX, anchorClientY);
  }

  useEffect(() => {
    if (!setZoomAroundViewportCenterRef) return undefined;
    setZoomAroundViewportCenterRef.current = (delta = 0, explicitZoom = null) => {
      const frameRect = frameRef.current?.getBoundingClientRect();
      if (!frameRect) {
        const currentZoom = zoomRef.current;
        const steppedZoom = delta === 0 ? currentZoom : currentZoom * (delta > 0 ? 1.16 : 1 / 1.16);
        const nextZoom = Math.min(maxBoardZoom, Math.max(minBoardZoom, Number((explicitZoom ?? steppedZoom).toFixed(4))));
        zoomRef.current = nextZoom;
        setCanvasZoom(nextZoom);
        setWorkspaceZoom(nextZoom);
        rememberCanvasView(activeBoardId, viewportOffsetRef.current, nextZoom);
        return;
      }
      changeCanvasZoom(delta, frameRect.left + frameRect.width / 2, frameRect.top + frameRect.height / 2, explicitZoom);
    };

    return () => {
      setZoomAroundViewportCenterRef.current = null;
    };
  }, [activeBoardId, rememberCanvasView, setZoomAroundViewportCenterRef, setWorkspaceZoom]);

  function visibleCanvasCenterPoint() {
    const frameRect = frameRef.current?.getBoundingClientRect();
    if (!frameRect) return { x: 96, y: 96 };
    return canvasPointFromClient(frameRect.left + frameRect.width / 2, frameRect.top + frameRect.height / 2);
  }

  function duplicateCanvasClipboardItems(sourceItems) {
    if (!hasBoard || sourceItems.length === 0) return;
    clipboardPasteGenerationRef.current = Math.min(8, clipboardPasteGenerationRef.current + 1);
    const nextItems = cloneBoardClipboardItems(
      sourceItems,
      clipboardPasteGenerationRef.current,
      clipboardPasteAnchorRef.current ?? visibleCanvasCenterPoint(),
    );
    checkpointBoardItems(activeBoardId);
    setBoardItems((current) => ({
      ...current,
      [activeBoardId]: [...(current[activeBoardId] ?? []), ...nextItems],
    }));
    const nextIds = nextItems.map((item) => item.id);
    setSelectedBoardItemIds(new Set(nextIds));
    setSelectedBoardItemId(nextIds[0] ?? "");
    setEditingNoteId("");
    setContextMenu(null);
  }

  function handleCanvasCopy(event) {
    if ((editingNoteId && isTextEditingTarget(event.target)) || selectedBoardItemIds.size === 0) return;
    const copiedItems = activeItems.filter((item) => selectedBoardItemIds.has(item.id));
    if (writeBoardClipboard(event, copiedItems, assetById, { surface: frameRef.current, noteFonts: availableNoteFonts })) {
      clipboardPasteGenerationRef.current = 0;
    }
  }

  function handleCanvasCut(event) {
    if ((editingNoteId && isTextEditingTarget(event.target)) || selectedBoardItemIds.size === 0) return;
    const copiedItems = activeItems.filter((item) => selectedBoardItemIds.has(item.id));
    if (!writeBoardClipboard(event, copiedItems, assetById, { surface: frameRef.current, noteFonts: availableNoteFonts })) return;
    deleteBoardItems(selectedBoardItemIds);
    setSelectedBoardItemIds(new Set());
    setSelectedBoardItemId("");
    setEditingNoteId("");
    clipboardPasteGenerationRef.current = 0;
  }

  function handleCanvasPaste(event) {
    if (!hasBoard || (editingNoteId && isTextEditingTarget(event.target))) return;
    const copiedItems = readBoardClipboard(event.clipboardData);
    if (copiedItems.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      duplicateCanvasClipboardItems(copiedItems);
      return;
    }
    const input = getClipboardMediaInput(event.clipboardData);
    if (input.hasContent) {
      event.preventDefault();
      event.stopPropagation();
      const anchor = clipboardPasteAnchorRef.current ?? visibleCanvasCenterPoint();
      // 剪贴板里是本库已有文件（例如刚复制的素材）时直接复用，不再导入一份副本。
      const existingAssetIds = assetIdsFromDroppedFiles(input.files, assets);
      if (existingAssetIds.length > 0) {
        const clientPoint = canvasClientPointFromBoard(anchor);
        void addDroppedAssetsToCanvas(existingAssetIds, clientPoint.x, clientPoint.y);
        return;
      }
      pasteImagesToBoard?.(input.files, input.metadata, anchor);
      return;
    }

    const text = readExternalClipboardText(event.clipboardData);
    if (!text) return;
    event.preventDefault();
    event.stopPropagation();
    addNote(clipboardPasteAnchorRef.current ?? visibleCanvasCenterPoint(), text);
  }

  useEffect(() => {
    const ownsClipboardEvent = (event) => {
      const frame = frameRef.current;
      const activeElement = document.activeElement;
      return Boolean(
        frame &&
          (activeElement === frame || frame.contains(activeElement) || (event.target instanceof Node && frame.contains(event.target))),
      );
    };
    const copy = (event) => {
      if (!event.defaultPrevented && ownsClipboardEvent(event)) handleCanvasCopy(event);
    };
    const cut = (event) => {
      if (!event.defaultPrevented && ownsClipboardEvent(event)) handleCanvasCut(event);
    };
    const paste = (event) => {
      if (!event.defaultPrevented && ownsClipboardEvent(event)) handleCanvasPaste(event);
    };

    window.addEventListener("copy", copy, true);
    window.addEventListener("cut", cut, true);
    window.addEventListener("paste", paste, true);
    return () => {
      window.removeEventListener("copy", copy, true);
      window.removeEventListener("cut", cut, true);
      window.removeEventListener("paste", paste, true);
    };
  }, [activeBoardId, activeItems, editingNoteId, hasBoard, pasteImagesToBoard, selectedBoardItemIds]);

  function showCanvasMenu(event) {
    event.preventDefault();
    if (!hasBoard) {
      setContextMenu(null);
      return;
    }
    const point = canvasPointFromClient(event.clientX, event.clientY);
    setContextMenu({ x: event.clientX, y: event.clientY, boardX: point.x, boardY: point.y, selectionCount: selectedBoardItemIds.size });
  }

  function removeContextItem() {
    if (!contextMenu?.itemId) return;
    const deletingIds =
      selectedBoardItemIds.has(contextMenu.itemId) && selectedBoardItemIds.size > 1 ? selectedBoardItemIds : new Set([contextMenu.itemId]);
    deleteBoardItems(deletingIds);
    setSelectedBoardItemIds(new Set());
    setContextMenu(null);
  }

  function arrangeFromMenu(mode) {
    arrangeBoard(mode, selectedBoardItemIds.size > 0 ? selectedBoardItemIds : null);
    setContextMenu(null);
  }

  function updateNoteStyleFromMenu(patch) {
    if (!contextMenuItem || contextMenuItem.type !== "note") return;
    checkpointBoardItems(activeBoardId);
    const fitted = patch.fontFamily
      ? fitTextNodeSize(contextMenuItem.text, contextMenuItem.fontSize, patch.fontFamily)
      : {};
    updateBoardItem(contextMenuItem.id, { ...patch, ...fitted });
  }

  function updateNoteText(item, text) {
    updateBoardItem(item.id, { text, ...growTextNodeSize(item, text) });
  }

  function updateCanvasNoteStyle(item, patch) {
    checkpointBoardItems(activeBoardId);
    const fitted = patch.fontFamily ? fitTextNodeSize(item.text, item.fontSize, patch.fontFamily) : {};
    updateBoardItem(item.id, { ...patch, ...fitted });
  }

  function beginCanvasNoteEditing(itemId, selectAll = false) {
    checkpointBoardItems(activeBoardId);
    setEditingNoteId(itemId);
    setSelectedBoardItemIds(new Set([itemId]));
    setSelectedBoardItemId(itemId);
    window.requestAnimationFrame(() => {
      const textarea = frameRef.current?.querySelector(`[data-note-id="${itemId}"] textarea`);
      textarea?.focus?.({ preventScroll: true });
      if (selectAll) textarea?.select?.();
    });
  }

  function addNoteFromMenu() {
    if (!contextMenu) return;
    addNote({ x: contextMenu.boardX ?? 96, y: contextMenu.boardY ?? 96 });
    setContextMenu(null);
  }

  function addTextFromDoubleClick(event) {
    if (!hasBoard || event.target.closest?.(".board-item, .board-note, .board-context-menu")) return;
    const point = canvasPointFromClient(event.clientX, event.clientY);
    addNote(point);
  }

  return (
    <div
      ref={frameRef}
      className={classNames("canvas-frame", panState && "viewport-panning", resizeState && "resizing-items")}
      tabIndex={0}
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={handleCanvasPointerMove}
      onWheel={handleCanvasWheel}
      onAuxClick={(event) => event.preventDefault()}
      onClick={() => setContextMenu(null)}
      onContextMenu={showCanvasMenu}
      onDoubleClick={addTextFromDoubleClick}
      onDragOver={handleCanvasDragOver}
      onDrop={handleCanvasDrop}
    >
      <div
        ref={surfaceRef}
        className="canvas-surface"
        style={{
          transform: viewportTransform(viewportOffset, zoom),
          "--selection-control-scale": String(1 / zoom),
          "--selection-outline-width": `${2 / zoom}px`,
          "--selection-stroke-width": `${1 / zoom}px`,
          "--selection-toolbar-gap": `${8 / zoom}px`,
        }}
      >
        {!hasBoard ? (
          <div className="canvas-empty">
            <FolderPlus size={30} />
            <strong>无白板</strong>
            <span>左侧白板区可以新建一个白板</span>
          </div>
        ) : null}

        {activeItems.map((item) => {
          const asset = item.assetId ? assetById.get(item.assetId) : null;
          const isSelected = selectedBoardItemId === item.id || selectedBoardItemIds.has(item.id);

          if (item.type === "note") {
            return (
              <div
                className={classNames("board-note", isSelected && "selected", editingNoteId === item.id && "editing")}
                key={item.id}
                data-note-id={item.id}
                style={{ left: item.x, top: item.y, width: item.width, height: item.height }}
                onPointerDown={(event) => startCanvasItemDrag(event, item)}
                onPointerUp={stopDrag}
                onContextMenu={(event) => deleteCanvasItem(event, item)}
              >
                <textarea
                  value={item.text}
                  readOnly={editingNoteId !== item.id}
                  style={{
                    color: noteColorValue(item),
                    fontFamily: noteFontValue(item, availableNoteFonts),
                    fontSize: `${Number(item.fontSize) || 16}px`,
                  }}
                  onChange={(event) => updateNoteText(item, event.target.value)}
                  onFocus={() => {
                    setEditingNoteId(item.id);
                    setSelectedBoardItemId(item.id);
                  }}
                  onBlur={() => setEditingNoteId((current) => (current === item.id ? "" : current))}
                  onPointerDown={(event) => {
                    if (editingNoteId === item.id) {
                      event.stopPropagation();
                    } else {
                      event.preventDefault();
                    }
                  }}
                  onMouseDown={(event) => {
                    if (editingNoteId === item.id) event.stopPropagation();
                  }}
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    beginCanvasNoteEditing(item.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") event.currentTarget.blur();
                  }}
                  placeholder="输入文字"
                  spellCheck={false}
                  aria-label="编辑文本"
                />
                {isSelected && selectedBoardItemIds.size === 1 && editingNoteId !== item.id ? (
                  <TextNodeToolbar
                    item={item}
                    onChange={(patch) => updateCanvasNoteStyle(item, patch)}
                    placeBelow={viewportOffset.y + item.y * zoom < 48}
                  />
                ) : null}
                {isSelected && selectedBoardItemIds.size === 1 ? (
                  <div
                    className="selection-handles"
                    onPointerDown={(event) => {
                      if (event.defaultPrevented) return;
                      const handle = resizeHandleFromTarget(event.target);
                      if (handle) startCanvasResize(event, item, handle);
                    }}
                  >
                    {["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((handle) =>
                      handle === "se" ? (
                        <button
                          key={handle}
                          type="button"
                          className="selection-handle se item-resize-handle"
                          onPointerDown={(event) => startCanvasResize(event, item)}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          title="拖动缩放"
                          aria-label="拖动缩放"
                        />
                      ) : (
                        <span key={handle} className={`selection-handle ${handle}`} />
                      ),
                    )}
                  </div>
                ) : null}
              </div>
            );
          }

          if (!asset) return null;

          return (
            <article
              className={classNames("board-item", isAssetVideo(asset) && "is-video", isSelected && "selected")}
              key={item.id}
              style={{ left: item.x, top: item.y, width: item.width, height: item.height }}
              onPointerDown={(event) => startCanvasItemDrag(event, item)}
              onPointerUp={stopDrag}
              onContextMenu={(event) => deleteCanvasItem(event, item)}
            >
              <BoardMedia
                asset={asset}
                item={item}
                zoom={zoom}
                alt={asset.title}
                onImageLoad={(event) => syncCanvasItemAspect(item, event.currentTarget)}
                onVideoMetadata={(event) => syncCanvasItemAspect(item, event.currentTarget)}
              />
              {isSelected && selectedBoardItemIds.size === 1 ? (
                <div
                  className="selection-handles"
                  onPointerDown={(event) => {
                    if (event.defaultPrevented) return;
                    const handle = resizeHandleFromTarget(event.target);
                    if (handle) startCanvasResize(event, item, handle);
                  }}
                >
                  {["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((handle) =>
                    handle === "se" ? (
                      <button
                        key={handle}
                        type="button"
                        className="selection-handle se item-resize-handle"
                        onPointerDown={(event) => startCanvasResize(event, item)}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        title="拖动缩放"
                        aria-label="拖动缩放"
                      />
                    ) : (
                      <span key={handle} className={`selection-handle ${handle}`} />
                    ),
                  )}
                </div>
              ) : null}
            </article>
          );
        })}
        {groupSelectionBox ? (
          <div
            className="group-selection-frame"
            style={{
              left: groupSelectionBox.x,
              top: groupSelectionBox.y,
              width: groupSelectionBox.width,
              height: groupSelectionBox.height,
            }}
            onPointerDown={startCanvasGroupDrag}
            onContextMenu={(event) => deleteCanvasItem(event, selectedCanvasItems[0])}
            onDoubleClick={(event) => event.stopPropagation()}
            title="拖动移动选中内容"
          >
            <div
              className="selection-handles"
              onPointerDown={(event) => {
                const handle = resizeHandleFromTarget(event.target);
                if (handle) startCanvasResize(event, selectedCanvasItems[0], handle);
              }}
            >
              {resizeHandleNames.map((handle) => (
                <button
                  key={handle}
                  type="button"
                  className={`selection-handle ${handle} item-resize-handle`}
                  title="拖动缩放选中内容"
                  aria-label={`从${handle}方向缩放选中内容`}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className={classNames("canvas-floating-launch", floatingLaunchActive && "launching")}
        onClick={() => openFloatingBoard(activeBoardId)}
        disabled={!hasBoard}
        title="打开浮窗画布"
        aria-label="打开浮窗画布"
      >
        <PictureInPicture2 size={17} />
      </button>
      {selectionBox ? (
        <div
          className="canvas-selection-box"
          style={{ left: selectionBox.left, top: selectionBox.top, width: selectionBox.width, height: selectionBox.height }}
        />
      ) : null}
      {contextMenu ? (
        <div
          className="board-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
        >
          {contextMenu.itemId ? (
            <>
              <button className="danger" onClick={removeContextItem}>
                <Trash2 size={14} />
                {selectedBoardItemIds.size > 1 && selectedBoardItemIds.has(contextMenu.itemId) ? "移除选中" : "从白板移除"}
              </button>
              {contextMenuIsNote ? (
                <div className="note-style-panel">
                  <select
                    className="note-font-select"
                    value={noteFontValue(contextMenuItem, availableNoteFonts)}
                    onChange={(event) => updateNoteStyleFromMenu({ fontFamily: event.target.value })}
                    aria-label="字体"
                  >
                    {availableNoteFonts.map((option) => (
                      <option key={option.label} value={option.value} style={{ fontFamily: option.value }}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <div className="note-color-row" aria-label="文本颜色">
                    {noteColorOptions.map((color) => (
                      <button
                        key={color}
                        className={classNames(noteColorValue(contextMenuItem) === color && "active")}
                        style={{ "--note-color": color }}
                        onClick={() => updateNoteStyleFromMenu({ color })}
                        title="文本颜色"
                        aria-label={`文本颜色 ${color}`}
                      />
                    ))}
                    <input
                      className="note-custom-color"
                      type="color"
                      value={noteColorValue(contextMenuItem)}
                      onChange={(event) => updateNoteStyleFromMenu({ color: event.target.value })}
                      title="自定义颜色"
                      aria-label="自定义文字颜色"
                    />
                  </div>
                </div>
              ) : null}
              <button onClick={() => arrangeFromMenu("grid")}>
                <AlignCenter size={14} />
                {selectedBoardItemIds.size > 0 ? "网格排列选中" : "网格排列"}
              </button>
              <button onClick={() => arrangeFromMenu("row")}>
                <AlignCenter size={14} />
                {selectedBoardItemIds.size > 0 ? "横向排列选中" : "横向排列"}
              </button>
              <button onClick={() => arrangeFromMenu("column")}>
                <AlignCenter size={14} />
                {selectedBoardItemIds.size > 0 ? "纵向排列选中" : "纵向排列"}
              </button>
            </>
          ) : (
            <>
              <button onClick={addNoteFromMenu}>
                <MessageSquareText size={14} />
                添加文本
              </button>
              <button onClick={() => arrangeFromMenu("grid")}>
                <AlignCenter size={14} />
                {selectedBoardItemIds.size > 0 ? "网格排列选中" : "网格排列"}
              </button>
              <button onClick={() => arrangeFromMenu("row")}>
                <AlignCenter size={14} />
                {selectedBoardItemIds.size > 0 ? "横向排列选中" : "横向排列"}
              </button>
              <button onClick={() => arrangeFromMenu("column")}>
                <AlignCenter size={14} />
                {selectedBoardItemIds.size > 0 ? "纵向排列选中" : "纵向排列"}
              </button>
            </>
          )}
        </div>
      ) : null}
      {canvasPreviewAsset
        ? createPortal(
            // 画布内是 isolated 堆叠上下文，预览需要挂到 body 才能盖住素材库与详情栏；
            // 门户仍沿 React 树冒泡到画布，因此预览内部拦掉指针事件，避免关掉预览时清空选区。
            <div
              className="image-preview-backdrop"
              role="dialog"
              aria-modal="true"
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={closeCanvasPreview}
            >
              <section className="image-preview-modal" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
                <div className="image-preview-topbar">
                  <div>
                    <strong>{canvasPreviewAsset.title}</strong>
                    <span>{canvasPreviewAsset.dimensions || canvasPreviewAsset.size} · 空格关闭</span>
                  </div>
                  <button type="button" onClick={closeCanvasPreview} aria-label="关闭预览" title="关闭预览">
                    <X size={17} />
                  </button>
                </div>
                <div className={classNames("image-preview-stage", isAssetVideo(canvasPreviewAsset) && "is-video")}>
                  <div
                    className="image-preview-viewport"
                    style={
                      isAssetVideo(canvasPreviewAsset)
                        ? undefined
                        : { width: "calc(100% - 48px)", height: "calc(100% - 32px)", transform: "translate3d(-50%, -50%, 0)" }
                    }
                  >
                    {isAssetVideo(canvasPreviewAsset) ? (
                      <div className="image-preview-video-frame">
                        <InlineVideoMedia asset={canvasPreviewAsset} alt={canvasPreviewAsset.title} preload="auto" autoPlay />
                      </div>
                    ) : (
                      <MediaElement asset={canvasPreviewAsset} alt={canvasPreviewAsset.title} />
                    )}
                  </div>
                </div>
                <div className="image-preview-strip" />
              </section>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function FloatingBoard({
  assets,
  boards,
  boardId,
  boardItems,
  checkpointBoardItems,
  undoBoardItems,
  redoBoardItems,
  setAssets,
  setBoardItems,
  activeLibrary,
}) {
  const [zoom, setZoom] = useState(0.94);
  const [controlsVisible, setControlsVisible] = useState(false);
  const [dragState, setDragState] = useState(null);
  const [panState, setPanState] = useState(null);
  const [viewportOffset, setViewportOffset] = useState({ x: 0, y: 0 });
  const [selectedFloatingIds, setSelectedFloatingIds] = useState(() => new Set());
  const [selectionBox, setSelectionBox] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [resizeState, setResizeState] = useState(null);
  const [editingNoteId, setEditingNoteId] = useState("");
  const [windowDragState, setWindowDragState] = useState(null);
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);
  const [floatingPreviewAssetId, setFloatingPreviewAssetId] = useState("");
  const availableNoteFonts = useNoteFontOptions();
  const windowDragTimerRef = useRef(null);
  const controlsHideTimerRef = useRef(null);
  const suppressNextFloatingMenuRef = useRef(false);
  const floatingShellRef = useRef(null);
  const floatingSurfaceRef = useRef(null);
  const pendingFloatingTextFocusRef = useRef("");
  const clipboardPasteGenerationRef = useRef(0);
  const clipboardPasteAnchorRef = useRef(null);
  const floatingZoomRef = useRef(zoom);
  const floatingOffsetRef = useRef(viewportOffset);
  const floatingWheelFrameRef = useRef(0);
  const floatingWheelCommitTimerRef = useRef(0);

  const applyFloatingTransform = useCallback((offset = floatingOffsetRef.current, nextZoom = floatingZoomRef.current) => {
    const surface = floatingSurfaceRef.current;
    if (!surface) return;
    surface.style.transform = viewportTransform(offset, nextZoom);
    surface.style.setProperty("--selection-control-scale", String(1 / nextZoom));
    surface.style.setProperty("--selection-outline-width", `${2 / nextZoom}px`);
    surface.style.setProperty("--selection-stroke-width", `${1 / nextZoom}px`);
    surface.style.setProperty("--selection-toolbar-gap", `${8 / nextZoom}px`);
  }, []);

  useEffect(() => {
    floatingZoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    floatingOffsetRef.current = viewportOffset;
  }, [viewportOffset]);

  useLayoutEffect(() => {
    applyFloatingTransform(viewportOffset, zoom);
  }, [applyFloatingTransform, viewportOffset, zoom]);

  useEffect(
    () => () => {
      if (floatingWheelFrameRef.current) window.cancelAnimationFrame(floatingWheelFrameRef.current);
      window.clearTimeout(floatingWheelCommitTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    window.referenceBoard?.activateLibrary?.(activeLibrary);
  }, [activeLibrary]);
  const board = boards.find((item) => item.id === boardId) ?? boards[0] ?? { id: "", name: "无白板" };
  const items = board.id ? (boardItems[board.id] ?? []) : [];
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const floatingContextItem = contextMenu?.itemId ? items.find((item) => item.id === contextMenu.itemId) : null;
  const floatingContextIsNote = floatingContextItem?.type === "note";
  const selectedFloatingItems = items.filter((item) => selectedFloatingIds.has(item.id));
  const floatingPreviewAsset = assetById.get(floatingPreviewAssetId);
  const floatingGroupSelectionBox = selectedFloatingItems.length > 1 ? createResizeSnapshot(selectedFloatingItems)?.box : null;

  useLayoutEffect(() => {
    if (!board.id) return;
    setBoardItems((current) => {
      const currentItems = current[board.id] ?? [];
      const normalizedItems = normalizeBoardTextNodes(currentItems, availableNoteFonts);
      return normalizedItems === currentItems ? current : { ...current, [board.id]: normalizedItems };
    });
  }, [availableNoteFonts, board.id, setBoardItems]);

  useEffect(() => {
    let mounted = true;
    window.referenceBoard?.isAlwaysOnTop?.().then((value) => {
      if (mounted && typeof value === "boolean") setAlwaysOnTop(value);
    });
    return () => {
      mounted = false;
      window.clearTimeout(windowDragTimerRef.current);
      window.clearTimeout(controlsHideTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!dragState) return undefined;

    const scheduledMove = createPointerMoveScheduler(moveFloatingItem);
    const move = (event) => scheduledMove.move(event);
    const stop = () => {
      scheduledMove.flush();
      setDragState(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("mouseup", stop);
    return () => {
      scheduledMove.cancel();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("mouseup", stop);
    };
  }, [board.id, dragState, zoom]);

  useEffect(() => {
    const targetId = pendingFloatingTextFocusRef.current;
    if (!targetId) return;
    pendingFloatingTextFocusRef.current = "";
    setEditingNoteId(targetId);
    window.requestAnimationFrame(() => {
      const textarea = floatingShellRef.current?.querySelector(`[data-note-id="${targetId}"] textarea`);
      textarea?.focus?.({ preventScroll: true });
      textarea?.select?.();
    });
  }, [items]);

  useEffect(() => {
    if (!resizeState) return undefined;

    const scheduledMove = createPointerMoveScheduler((clientX, clientY) => {
      const dx = (clientX - resizeState.startX) / zoom;
      const dy = (clientY - resizeState.startY) / zoom;
      const scale = resizeScaleFromSnapshot(resizeState.snapshot, dx, dy, resizeState.handle);

      setBoardItems((current) => ({
        ...current,
        [board.id]: (current[board.id] ?? []).map((item) => applyResizeSnapshot(item, resizeState.snapshot, scale, resizeState.handle)),
      }));
    });
    const move = (event) => scheduledMove.move(event);
    const stop = () => {
      scheduledMove.flush();
      setResizeState(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
    return () => {
      scheduledMove.cancel();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
    };
  }, [board.id, resizeState, setBoardItems, zoom]);

  useEffect(() => {
    if (!windowDragState) return undefined;

    const move = () => window.referenceBoard?.moveWindowDrag?.(windowDragState);
    const stop = () => {
      window.clearTimeout(windowDragTimerRef.current);
      setWindowDragState(null);
    };
    const interval = window.setInterval(move, 16);

    window.addEventListener("pointerup", stop);
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
    };
  }, [windowDragState]);

  useEffect(() => {
    if (!panState) return undefined;

    const scheduledMove = createPointerMoveScheduler((clientX, clientY) => {
      const nextOffset = {
        x: panState.originX + clientX - panState.startX,
        y: panState.originY + clientY - panState.startY,
      };
      floatingOffsetRef.current = nextOffset;
      applyFloatingTransform(nextOffset, floatingZoomRef.current);
    });
    const move = (event) => scheduledMove.move(event);
    const stop = () => {
      scheduledMove.flush();
      setViewportOffset({ ...floatingOffsetRef.current });
      setPanState(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
    return () => {
      scheduledMove.cancel();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
    };
  }, [applyFloatingTransform, panState]);

  useEffect(() => {
    const itemIds = new Set(items.map((item) => item.id));
    setSelectedFloatingIds((current) => {
      const next = new Set(Array.from(current).filter((itemId) => itemIds.has(itemId)));
      return next.size === current.size ? current : next;
    });
  }, [items]);

  useEffect(() => {
    const handleFloatingPreviewKeyDown = (event) => {
      if (event.code !== "Space" || event.ctrlKey || event.metaKey || event.altKey || isTextEditingTarget(event.target)) return;
      if (floatingPreviewAssetId) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setFloatingPreviewAssetId("");
        return;
      }
      const targetAsset = selectedFloatingItems.map((item) => assetById.get(item.assetId)).find(Boolean);
      if (!targetAsset) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setFloatingPreviewAssetId(targetAsset.id);
    };

    window.addEventListener("keydown", handleFloatingPreviewKeyDown);
    return () => window.removeEventListener("keydown", handleFloatingPreviewKeyDown);
  }, [assetById, floatingPreviewAssetId, selectedFloatingItems]);

  useEffect(() => {
    if (selectedFloatingIds.size === 0) return undefined;

    const handleKeyDown = (event) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (isTextEditingTarget(event.target) || floatingPreviewAssetId) return;
      event.preventDefault();
      deleteFloatingItems(selectedFloatingIds);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [floatingPreviewAssetId, selectedFloatingIds]);

  useEffect(() => {
    if (selectedFloatingIds.size === 0) return undefined;

    const handleArrangementKeyDown = (event) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTextEditingTarget(event.target) || floatingPreviewAssetId) return;
      const anchor = keyboardArrangementKeys[event.key.toLowerCase()];
      if (!anchor) return;
      const positions = keyboardArrangementPositions(items, selectedFloatingIds, anchor);
      if (!positions) return;
      event.preventDefault();
      event.stopPropagation();
      // 长按自动重复时合并为一次撤销步。
      if (!event.repeat) checkpointBoardItems(board.id);
      setBoardItems((current) => ({
        ...current,
        [board.id]: (current[board.id] ?? []).map((item) => (positions[item.id] ? { ...item, ...positions[item.id] } : item)),
      }));
      setContextMenu(null);
    };

    window.addEventListener("keydown", handleArrangementKeyDown);
    return () => window.removeEventListener("keydown", handleArrangementKeyDown);
  }, [board.id, checkpointBoardItems, floatingPreviewAssetId, items, selectedFloatingIds, setBoardItems]);

  useEffect(() => {
    const handleHistoryKeyDown = (event) => {
      if (event.defaultPrevented || isTextEditingTarget(event.target)) return;
      if (!event.ctrlKey && !event.metaKey) return;
      const shell = floatingShellRef.current;
      const activeElement = document.activeElement;
      if (!shell || (activeElement !== shell && !shell.contains(activeElement))) return;

      const key = event.key.toLowerCase();
      const wantsUndo = key === "z" && !event.shiftKey;
      const wantsRedo = (key === "z" && event.shiftKey) || key === "y";
      if (!wantsUndo && !wantsRedo) return;

      const restored = wantsRedo ? redoBoardItems(board.id) : undoBoardItems(board.id);
      if (!restored) return;
      event.preventDefault();
      event.stopPropagation();
      setSelectedFloatingIds(new Set());
      setEditingNoteId("");
      setContextMenu(null);
    };

    window.addEventListener("keydown", handleHistoryKeyDown, true);
    return () => window.removeEventListener("keydown", handleHistoryKeyDown, true);
  }, [board.id, redoBoardItems, undoBoardItems]);

  function closeWindow() {
    if (window.referenceBoard?.closeFloatingWindow) {
      window.referenceBoard.closeFloatingWindow();
    } else {
      window.close();
    }
  }

  function updateFloatingItem(itemId, patch) {
    if (!board.id) return;
    setBoardItems((current) => ({
      ...current,
      [board.id]: (current[board.id] ?? []).map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
    }));
  }

  function updateFloatingNoteStyleFromMenu(patch) {
    if (!floatingContextItem || floatingContextItem.type !== "note") return;
    checkpointBoardItems(board.id);
    const fitted = patch.fontFamily
      ? fitTextNodeSize(floatingContextItem.text, floatingContextItem.fontSize, patch.fontFamily)
      : {};
    updateFloatingItem(floatingContextItem.id, { ...patch, ...fitted });
  }

  function updateFloatingText(item, text) {
    updateFloatingItem(item.id, { text, ...growTextNodeSize(item, text) });
  }

  function updateFloatingNoteStyle(item, patch) {
    checkpointBoardItems(board.id);
    const fitted = patch.fontFamily ? fitTextNodeSize(item.text, item.fontSize, patch.fontFamily) : {};
    updateFloatingItem(item.id, { ...patch, ...fitted });
  }

  function beginFloatingNoteEditing(itemId, selectAll = false) {
    checkpointBoardItems(board.id);
    setEditingNoteId(itemId);
    setSelectedFloatingIds(new Set([itemId]));
    window.requestAnimationFrame(() => {
      const textarea = floatingShellRef.current?.querySelector(`[data-note-id="${itemId}"] textarea`);
      textarea?.focus?.({ preventScroll: true });
      if (selectAll) textarea?.select?.();
    });
  }

  function floatingPointFromClient(clientX, clientY) {
    return {
      x: (clientX - viewportOffset.x) / zoom,
      y: (clientY - viewportOffset.y) / zoom,
    };
  }

  function floatingClientPointFromBoard(point) {
    return {
      x: viewportOffset.x + point.x * zoom,
      y: viewportOffset.y + point.y * zoom,
    };
  }

  function addFloatingText(position = {}, initialText = "") {
    if (!board.id) return;
    const text = String(initialText || "").slice(0, 20000);
    const noteSize = fitTextNodeSize(text, 16);
    const nextItem = {
      id: `note-${Date.now()}`,
      type: "note",
      text,
      fontSize: 16,
      color: noteColorOptions[0],
      fontFamily: defaultNoteFont,
      x: Math.round(Number.isFinite(position.x) ? position.x : 96),
      y: Math.round(Number.isFinite(position.y) ? position.y : 96),
      width: noteSize.width,
      height: noteSize.height,
    };
    checkpointBoardItems(board.id);
    setBoardItems((current) => ({
      ...current,
      [board.id]: [...(current[board.id] ?? []), nextItem],
    }));
    setSelectedFloatingIds(new Set([nextItem.id]));
    pendingFloatingTextFocusRef.current = text.length === 0 ? nextItem.id : "";
    setContextMenu(null);
  }

  async function addDroppedAssetsToFloating(assetIds, clientX, clientY) {
    if (!board.id) return;
    const targetAssets = Array.from(new Set(assetIds ?? []))
      .map((assetId) => assetById.get(assetId))
      .filter(Boolean);
    if (targetAssets.length === 0) return;

    await addAssetObjectsToFloating(targetAssets, clientX, clientY);
  }

  async function addAssetObjectsToFloating(targetAssets, clientX, clientY) {
    if (!board.id) return;
    const uniqueAssets = Array.from(new Map((targetAssets ?? []).filter(Boolean).map((asset) => [asset.id, asset])).values());
    if (uniqueAssets.length === 0) return;

    const point = floatingPointFromClient(clientX, clientY);
    const timestamp = Date.now();
    const preparedItems = [];
    for (const [index, asset] of uniqueAssets.entries()) {
      const dimensions = getStoredImageDimensions(asset) ?? (await readAssetDimensions(asset));
      const nodeSize = fitImageNodeSize(dimensions);
      const column = index % 3;
      const row = Math.floor(index / 3);
      preparedItems.push({
        id: `i-${timestamp}-${index}-${Math.random().toString(36).slice(2, 7)}`,
        assetId: asset.id,
        x: Math.round(point.x - nodeSize.width / 2 + column * nodeSize.width),
        y: Math.round(point.y - nodeSize.height / 2 + row * nodeSize.height),
        width: nodeSize.width,
        height: nodeSize.height,
        note: "拖入浮窗",
      });
    }

    checkpointBoardItems(board.id);
    setBoardItems((current) => ({
      ...current,
      [board.id]: [...(current[board.id] ?? []), ...preparedItems],
    }));
    setSelectedFloatingIds(new Set(preparedItems.map((item) => item.id)));
    setContextMenu(null);
  }

  async function importExternalMediaToFloating(files, metadata = {}) {
    const importMeta = typeof metadata === "string" ? { originalSource: metadata, remoteSource: metadata, imageUrls: metadata ? [metadata] : [] } : metadata;
    const incomingFiles = Array.from(files ?? []).filter(isMediaFileLike);
    const imageUrlsForImport = Array.from(new Set([...(importMeta.imageUrls ?? [])].filter((url) => !looksLikeVideoUrl(url))));
    const videoUrlsForImport = Array.from(new Set([...(importMeta.videoUrls ?? []), ...(importMeta.imageUrls ?? []).filter(looksLikeVideoUrl)]));
    const typeLabel = importMeta.typeLabel || (importMeta.remoteSource ? "网页拖拽" : "拖入白板");
    const tagsForImport = importMeta.tags || (importMeta.remoteSource ? ["网页"] : ["本地"]);
    const importedAssets = [];
    const filesWithPaths = [];
    const imageFilesWithoutPaths = [];
    const videoFilesWithoutPaths = [];

    incomingFiles.forEach((file) => {
      const filePath = localPathFromFile(file);
      if (filePath) {
        filesWithPaths.push(filePath);
      } else if (isImageFileLike(file)) {
        imageFilesWithoutPaths.push(file);
      } else {
        videoFilesWithoutPaths.push(file);
      }
    });

    if (filesWithPaths.length > 0 && window.referenceBoard?.importImagePaths) {
      const result = await window.referenceBoard.importImagePaths(filesWithPaths, "", typeLabel, activeLibrary?.importMode === "reference" ? "reference" : "copy");
      importedAssets.push(...(result.assets ?? []));
    }

    const mediaFilesWithoutPaths = [
      ...imageFilesWithoutPaths.map((file, index) => ({ file, remoteSource: imageUrlsForImport[index] || "" })),
      ...videoFilesWithoutPaths.map((file, index) => ({ file, remoteSource: videoUrlsForImport[index] || "" })),
    ];
    if (mediaFilesWithoutPaths.length > 0 && window.referenceBoard?.importImageData) {
      const payload = await Promise.all(
        mediaFilesWithoutPaths.map(async ({ file, remoteSource }, index) => ({
          name: file.name || `drop-${isVideoFileLike(file) ? "video" : "image"}-${Date.now()}-${index}.${isVideoFileLike(file) ? "mp4" : "png"}`,
          type: file.type || "",
          buffer: await file.arrayBuffer(),
          originalSource: importMeta.originalSource || importMeta.remoteSource || file.name,
          remoteSource: remoteSource || importMeta.remoteSource || "",
          typeLabel,
          tags: isVideoFileLike(file) ? Array.from(new Set(["视频", ...tagsForImport])) : tagsForImport,
          note: "从外部拖入浮窗白板并复制到素材库。",
        })),
      );
      const result = await window.referenceBoard.importImageData(payload, "");
      importedAssets.push(...(result.assets ?? []));
    }

    const mediaUrlsForImport = Array.from(new Set([...imageUrlsForImport, ...videoUrlsForImport]));
    if ((incomingFiles.length === 0 || importedAssets.length === 0) && mediaUrlsForImport.length > 0 && window.referenceBoard?.importImageUrls) {
      const result = await window.referenceBoard.importImageUrls(mediaUrlsForImport, "", importMeta.originalSource || importMeta.remoteSource || "");
      importedAssets.push(...(result.assets ?? []));
    }

    if (videoFilesWithoutPaths.length > 0 && !window.referenceBoard?.importImageData) {
      importedAssets.push(
        ...videoFilesWithoutPaths.map((file, index) =>
          createTransientVideoAsset(file, index, "", { ...importMeta, typeLabel }, tagsForImport),
        ),
      );
    }

    if (importedAssets.length > 0) {
      setAssets?.((current) => [...importedAssets, ...current]);
    }

    return importedAssets;
  }

  async function importClipboardImagesToFloating(files, metadata) {
    const incomingFiles = Array.from(files ?? []).filter(isImageFileLike);
    const importedAssets = [];

    if (incomingFiles.length > 0 && window.referenceBoard?.importImageData) {
      const payload = await Promise.all(
        incomingFiles.map(async (file, index) => ({
          name: file.name || `clipboard-image-${Date.now()}-${index}.png`,
          type: file.type || "",
          buffer: await file.arrayBuffer(),
          originalSource: metadata?.originalSource || metadata?.remoteSource || file.name || "clipboard",
          remoteSource: metadata?.imageUrls?.[index] || metadata?.remoteSource || "",
          typeLabel: "剪贴板",
          tags: ["剪贴板"],
          note: "从剪贴板粘贴并复制到软件素材库。",
        })),
      );
      const result = await window.referenceBoard.importImageData(payload, "");
      importedAssets.push(...(result.assets ?? []));
    }

    if (incomingFiles.length === 0 && metadata?.imageUrls?.length > 0 && window.referenceBoard?.importImageUrls) {
      const result = await window.referenceBoard.importImageUrls(metadata.imageUrls, "", metadata.originalSource || metadata.remoteSource || "");
      importedAssets.push(...(result.assets ?? []));
    }

    if (importedAssets.length > 0) {
      setAssets?.((current) => [...importedAssets, ...current]);
    }

    return importedAssets;
  }

  async function pasteImagesToFloating(files, metadata) {
    const importedAssets = await importClipboardImagesToFloating(files, metadata);
    if (importedAssets.length === 0) return;
    const anchor = floatingCenterPoint();
    await addAssetObjectsToFloating(importedAssets, anchor.x, anchor.y);
  }

  function duplicateFloatingClipboardItems(sourceItems) {
    if (!board.id || sourceItems.length === 0) return;
    clipboardPasteGenerationRef.current = Math.min(8, clipboardPasteGenerationRef.current + 1);
    const center = floatingCenterPoint();
    const nextItems = cloneBoardClipboardItems(
      sourceItems,
      clipboardPasteGenerationRef.current,
      clipboardPasteAnchorRef.current ?? floatingPointFromClient(center.x, center.y),
    );
    checkpointBoardItems(board.id);
    setBoardItems((current) => ({
      ...current,
      [board.id]: [...(current[board.id] ?? []), ...nextItems],
    }));
    setSelectedFloatingIds(new Set(nextItems.map((item) => item.id)));
    setEditingNoteId("");
    setContextMenu(null);
  }

  function handleFloatingCopy(event) {
    if ((editingNoteId && isTextEditingTarget(event.target)) || selectedFloatingIds.size === 0) return;
    const copiedItems = items.filter((item) => selectedFloatingIds.has(item.id));
    if (writeBoardClipboard(event, copiedItems, assetById, { surface: floatingShellRef.current, noteFonts: availableNoteFonts })) {
      clipboardPasteGenerationRef.current = 0;
    }
  }

  function handleFloatingCut(event) {
    if ((editingNoteId && isTextEditingTarget(event.target)) || selectedFloatingIds.size === 0) return;
    const copiedItems = items.filter((item) => selectedFloatingIds.has(item.id));
    if (!writeBoardClipboard(event, copiedItems, assetById, { surface: floatingShellRef.current, noteFonts: availableNoteFonts })) return;
    deleteFloatingItems(selectedFloatingIds);
    setEditingNoteId("");
    clipboardPasteGenerationRef.current = 0;
  }

  function showFloatingControls() {
    window.clearTimeout(controlsHideTimerRef.current);
    setControlsVisible(true);
  }

  function scheduleHideFloatingControls(delay = 760) {
    window.clearTimeout(controlsHideTimerRef.current);
    controlsHideTimerRef.current = window.setTimeout(() => setControlsVisible(false), delay);
  }

  function handlePointerMove(event) {
    clipboardPasteAnchorRef.current = floatingPointFromClient(event.clientX, event.clientY);
    const isOnFloatingChrome = event.target.closest?.(".floating-grip, .floating-hotzone");
    if (event.clientY <= floatingRevealZoneHeight || isOnFloatingChrome || (controlsVisible && event.clientY <= floatingHideZoneHeight)) {
      showFloatingControls();
      return;
    }
    if (event.clientY > floatingHideZoneHeight) {
      scheduleHideFloatingControls(760);
    }
  }

  function hideFloatingControls(event) {
    if (event.clientY <= floatingHideZoneHeight) return;
    scheduleHideFloatingControls(760);
  }

  function setFloatingZoomAnchored(nextZoom, anchorClientX, anchorClientY) {
    startViewportComposite(floatingShellRef.current);
    const currentZoom = floatingZoomRef.current;
    const currentOffset = floatingOffsetRef.current;
    const boardX = (anchorClientX - currentOffset.x) / currentZoom;
    const boardY = (anchorClientY - currentOffset.y) / currentZoom;
    const nextOffset = {
      x: anchorClientX - boardX * nextZoom,
      y: anchorClientY - boardY * nextZoom,
    };
    floatingZoomRef.current = nextZoom;
    floatingOffsetRef.current = nextOffset;
    setViewportOffset(nextOffset);
    setZoom(nextZoom);
    settleViewportComposite(floatingShellRef.current, floatingSurfaceRef.current, () => {
      applyFloatingTransform(nextOffset, nextZoom);
    });
  }

  function floatingCenterPoint() {
    const rect = floatingShellRef.current?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }

  function changeFloatingZoom(delta, anchorClientX = null, anchorClientY = null) {
    const currentZoom = floatingZoomRef.current;
    const steppedZoom = delta === 0 ? currentZoom : currentZoom * (delta > 0 ? 1.16 : 1 / 1.16);
    const nextZoom = Math.min(maxBoardZoom, Math.max(minBoardZoom, Number(steppedZoom.toFixed(4))));
    if (nextZoom === currentZoom) return;
    const anchor = anchorClientX === null || anchorClientY === null ? floatingCenterPoint() : { x: anchorClientX, y: anchorClientY };
    setFloatingZoomAnchored(nextZoom, anchor.x, anchor.y);
  }

  function handleFloatingWheel(event) {
    event.preventDefault();
    const currentZoom = floatingZoomRef.current;
    const wheelZoom = currentZoom * Math.exp(-event.deltaY * 0.0015);
    const nextZoom = Math.min(maxBoardZoom, Math.max(minBoardZoom, Number(wheelZoom.toFixed(4))));
    if (nextZoom === currentZoom) return;
    startViewportComposite(floatingShellRef.current);

    const currentOffset = floatingOffsetRef.current;
    const boardX = (event.clientX - currentOffset.x) / currentZoom;
    const boardY = (event.clientY - currentOffset.y) / currentZoom;
    floatingZoomRef.current = nextZoom;
    floatingOffsetRef.current = {
      x: event.clientX - boardX * nextZoom,
      y: event.clientY - boardY * nextZoom,
    };

    if (!floatingWheelFrameRef.current) {
      floatingWheelFrameRef.current = window.requestAnimationFrame(() => {
        floatingWheelFrameRef.current = 0;
        applyFloatingTransform(floatingOffsetRef.current, floatingZoomRef.current);
      });
    }
    window.clearTimeout(floatingWheelCommitTimerRef.current);
    floatingWheelCommitTimerRef.current = window.setTimeout(() => {
      setViewportOffset({ ...floatingOffsetRef.current });
      setZoom(floatingZoomRef.current);
      settleViewportComposite(floatingShellRef.current, floatingSurfaceRef.current, () => {
        applyFloatingTransform(floatingOffsetRef.current, floatingZoomRef.current);
      });
    }, 90);
  }

  function handleFloatingPaste(event) {
    if (editingNoteId && isTextEditingTarget(event.target)) return;
    const copiedItems = readBoardClipboard(event.clipboardData);
    if (copiedItems.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      duplicateFloatingClipboardItems(copiedItems);
      return;
    }
    const input = getClipboardMediaInput(event.clipboardData);
    if (input.hasContent) {
      event.preventDefault();
      event.stopPropagation();
      // 剪贴板里是本库已有文件（例如刚复制的素材）时直接复用，不再导入一份副本。
      const existingAssetIds = assetIdsFromDroppedFiles(input.files, assets);
      if (existingAssetIds.length > 0) {
        const clientPoint = clipboardPasteAnchorRef.current
          ? floatingClientPointFromBoard(clipboardPasteAnchorRef.current)
          : floatingCenterPoint();
        void addDroppedAssetsToFloating(existingAssetIds, clientPoint.x, clientPoint.y);
        return;
      }
      pasteImagesToFloating(input.files, input.metadata);
      return;
    }

    const text = readExternalClipboardText(event.clipboardData);
    if (!text) return;
    event.preventDefault();
    event.stopPropagation();
    const center = floatingCenterPoint();
    addFloatingText(clipboardPasteAnchorRef.current ?? floatingPointFromClient(center.x, center.y), text);
  }

  // 原生剪贴板事件落在 body 上，不会冒泡到浮窗根节点，必须像主画布一样挂在 window 上。
  useEffect(() => {
    const copy = (event) => {
      if (!event.defaultPrevented) handleFloatingCopy(event);
    };
    const cut = (event) => {
      if (!event.defaultPrevented) handleFloatingCut(event);
    };
    const paste = (event) => {
      if (!event.defaultPrevented) handleFloatingPaste(event);
    };

    window.addEventListener("copy", copy, true);
    window.addEventListener("cut", cut, true);
    window.addEventListener("paste", paste, true);
    return () => {
      window.removeEventListener("copy", copy, true);
      window.removeEventListener("cut", cut, true);
      window.removeEventListener("paste", paste, true);
    };
  }, [board.id, editingNoteId, items, selectedFloatingIds]);

  function startWindowDragCandidate(event) {
    if (event.button !== 0) return;
    if (event.target.closest?.(".floating-item, .floating-note, .floating-actions, .floating-context-menu")) return;
    setContextMenu(null);
    window.clearTimeout(windowDragTimerRef.current);
    let selecting = false;
    let draggingWindow = false;
    const startX = event.clientX;
    const startY = event.clientY;
    const baseSelection = new Set(selectedFloatingIds);
    // 标题栏、边缘热区和操作按钮保持原有拖动行为，修饰键只在画布空白处生效。
    const onWindowChrome = Boolean(event.target.closest?.(".floating-grip, .floating-hotzone, .floating-actions"));
    const liveModifiers = {
      shiftKey: onWindowChrome ? false : event.shiftKey,
      ctrlKey: onWindowChrome ? false : event.ctrlKey,
      metaKey: onWindowChrome ? false : event.metaKey,
    };
    const startsModified = selectionModifierFromEvent(liveModifiers) !== "replace";

    const applySelection = (clientX, clientY) => {
      const left = Math.min(startX, clientX);
      const top = Math.min(startY, clientY);
      const right = Math.max(startX, clientX);
      const bottom = Math.max(startY, clientY);
      setSelectionBox({ left, top, width: right - left, height: bottom - top });

      const hitIds = items
        .filter((item) => {
          const itemLeft = viewportOffset.x + item.x * zoom;
          const itemTop = viewportOffset.y + item.y * zoom;
          const itemRight = itemLeft + item.width * zoom;
          const itemBottom = itemTop + item.height * zoom;
          return itemLeft < right && itemRight > left && itemTop < bottom && itemBottom > top;
        })
        .map((item) => item.id);

      setSelectedFloatingIds(combineSelection(baseSelection, hitIds, selectionModifierFromEvent(liveModifiers)));
    };

    const move = (moveEvent) => {
      if (draggingWindow) return;
      if (!onWindowChrome) {
        liveModifiers.shiftKey = moveEvent.shiftKey;
        liveModifiers.ctrlKey = moveEvent.ctrlKey;
        liveModifiers.metaKey = moveEvent.metaKey;
      }
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!selecting && Math.hypot(dx, dy) > 5) {
        selecting = true;
        window.clearTimeout(windowDragTimerRef.current);
      }
      if (selecting) {
        moveEvent.preventDefault();
        applySelection(moveEvent.clientX, moveEvent.clientY);
      }
    };

    const stop = () => {
      window.clearTimeout(windowDragTimerRef.current);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("mouseup", stop);
      if (!selecting && !draggingWindow && selectionModifierFromEvent(liveModifiers) === "replace") {
        setSelectedFloatingIds(new Set());
      }
      setSelectionBox(null);
    };

    if (onWindowChrome || !startsModified) {
      windowDragTimerRef.current = window.setTimeout(async () => {
        const nextDrag = await window.referenceBoard?.beginWindowDrag?.();
        if (nextDrag) {
          draggingWindow = true;
          setSelectionBox(null);
          setWindowDragState(nextDrag);
        }
      }, 180);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("mouseup", stop);
  }

  function startViewportPan(event) {
    if (event.button !== 1) return;
    event.preventDefault();
    setContextMenu(null);
    setPanState({
      startX: event.clientX,
      startY: event.clientY,
      originX: viewportOffset.x,
      originY: viewportOffset.y,
    });
  }

  async function startRightWindowDrag(event) {
    if (event.button !== 2) return;
    if (event.target.closest?.(".floating-item, .floating-note, .floating-actions, .floating-context-menu")) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    const startX = event.clientX;
    const startY = event.clientY;
    const startPoint = floatingPointFromClient(startX, startY);
    let draggingWindow = false;

    const move = async (moveEvent) => {
      if (draggingWindow || Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 7) return;
      draggingWindow = true;
      suppressNextFloatingMenuRef.current = true;
      const nextDrag = await window.referenceBoard?.beginWindowDrag?.();
      if (nextDrag) {
        setWindowDragState(nextDrag);
      }
    };

    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("mouseup", stop);
      if (!draggingWindow) {
        setContextMenu({ x: startX, y: startY, boardX: startPoint.x, boardY: startPoint.y });
      }
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("mouseup", stop);
  }

  function handleFloatingPointerDown(event) {
    floatingShellRef.current?.focus?.({ preventScroll: true });
    if (event.button === 2) {
      startRightWindowDrag(event);
      return;
    }
    if (event.button === 1) {
      startViewportPan(event);
      return;
    }
    startWindowDragCandidate(event);
  }

  function stopWindowDrag() {
    window.clearTimeout(windowDragTimerRef.current);
    setWindowDragState(null);
    window.setTimeout(() => {
      suppressNextFloatingMenuRef.current = false;
    }, 120);
  }

  async function toggleAlwaysOnTop() {
    const requested = !alwaysOnTop;
    setAlwaysOnTop(requested);
    const actual = await window.referenceBoard?.setAlwaysOnTop?.(requested);
    if (typeof actual === "boolean") setAlwaysOnTop(actual);
  }

  function applyFloatingSelectionModifier(modifier, itemId) {
    setSelectedFloatingIds((current) => {
      const next = new Set(current);
      if (modifier === "add") next.add(itemId);
      else next.delete(itemId);
      return next;
    });
  }

  // 整组选框会盖住组内素材，修饰键点选需要按坐标命中最上层素材。
  function floatingItemAtClientPoint(clientX, clientY) {
    const boardX = (clientX - viewportOffset.x) / zoom;
    const boardY = (clientY - viewportOffset.y) / zoom;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (boardX >= item.x && boardX <= item.x + item.width && boardY >= item.y && boardY <= item.y + item.height) return item;
    }
    return null;
  }

  function startFloatingDrag(event, item) {
    if (event.button !== 0) return;
    if (editingNoteId === item.id) return;
    event.stopPropagation();
    floatingShellRef.current?.focus?.({ preventScroll: true });
    const modifier = selectionModifierFromEvent(event);
    if (modifier !== "replace") {
      setContextMenu(null);
      applyFloatingSelectionModifier(modifier, item.id);
      return;
    }
    beginFloatingItemDrag(event, item);
  }

  function beginFloatingItemDrag(event, item) {
    setEditingNoteId("");
    setContextMenu(null);
    checkpointBoardItems(board.id);
    if (item.assetId) {
      setBoardItems((current) => {
        const currentItems = current[board.id] ?? [];
        const nextItems = bringBoardItemToFront(currentItems, item.id);
        return nextItems === currentItems ? current : { ...current, [board.id]: nextItems };
      });
    }
    const draggingIds = selectedFloatingIds.has(item.id) ? Array.from(selectedFloatingIds) : [item.id];
    const origins = Object.fromEntries(
      items.filter((candidate) => draggingIds.includes(candidate.id)).map((candidate) => [candidate.id, { x: candidate.x, y: candidate.y }]),
    );
    const draggingIdSet = new Set(draggingIds);
    const stationaryItems = items.filter((candidate) => candidate.assetId && !draggingIdSet.has(candidate.id));
    if (!selectedFloatingIds.has(item.id)) {
      setSelectedFloatingIds(new Set([item.id]));
    }
    setDragState({
      ids: draggingIds,
      startX: event.clientX,
      startY: event.clientY,
      origins,
      stationaryEdges: {
        x: stationaryItems.flatMap((candidate) => [candidate.x, candidate.x + candidate.width]),
        y: stationaryItems.flatMap((candidate) => [candidate.y, candidate.y + candidate.height]),
      },
    });
  }

  function startFloatingGroupDrag(event) {
    if (event.button !== 0 || selectedFloatingItems.length < 2) return;
    // 按住 Shift / Ctrl 时只调整选区：点到组内素材按素材加选/减选，空白处让位给框选。
    const modifier = selectionModifierFromEvent(event);
    if (modifier !== "replace") {
      const hitItem = floatingItemAtClientPoint(event.clientX, event.clientY);
      if (hitItem) {
        setContextMenu(null);
        applyFloatingSelectionModifier(modifier, hitItem.id);
      }
      return;
    }
    event.stopPropagation();
    floatingShellRef.current?.focus?.({ preventScroll: true });
    beginFloatingItemDrag(event, selectedFloatingItems[0]);
  }

  function startFloatingResize(event, item, handle = "se") {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    floatingShellRef.current?.focus?.({ preventScroll: true });
    setContextMenu(null);

    const candidateIds = selectedFloatingIds.has(item.id) ? selectedFloatingIds : new Set([item.id]);
    const resizingItems = items.filter((candidate) => candidateIds.has(candidate.id));
    const snapshot = createResizeSnapshot(resizingItems);
    if (!snapshot) return;

    checkpointBoardItems(board.id);
    setSelectedFloatingIds(new Set(snapshot.ids));
    setResizeState({ startX: event.clientX, startY: event.clientY, snapshot, handle });
  }

  function syncFloatingItemAspect(item, imageElement) {
    const naturalWidth = imageElement?.naturalWidth || imageElement?.videoWidth;
    const naturalHeight = imageElement?.naturalHeight || imageElement?.videoHeight;
    if (!(naturalWidth > 0) || !(naturalHeight > 0)) return;

    const naturalAspect = naturalWidth / naturalHeight;
    const currentAspect = item.width / item.height;
    if (Math.abs(currentAspect - naturalAspect) / naturalAspect < 0.08) return;

    const nextSize = fitImageNodeSizeToExistingFrame({ width: naturalWidth, height: naturalHeight }, item);
    if (!nextSize) return;
    setBoardItems((current) => ({
      ...current,
      [board.id]: (current[board.id] ?? []).map((candidate) => (candidate.id === item.id ? { ...candidate, ...nextSize } : candidate)),
    }));
  }

  function moveFloatingItem(clientX, clientY) {
    if (!dragState) return;
    const dx = (clientX - dragState.startX) / zoom;
    const dy = (clientY - dragState.startY) / zoom;

    setBoardItems((current) => {
      const currentItems = current[board.id] ?? [];
      const movedById = Object.fromEntries(
        currentItems
          .filter((item) => dragState.origins[item.id])
          .map((item) => [
            item.id,
            {
              ...item,
              x: dragState.origins[item.id].x + dx,
              y: dragState.origins[item.id].y + dy,
            },
          ]),
      );
      const snappedById = snapDraggedItems(currentItems, dragState.ids, movedById, 12 / zoom, dragState.stationaryEdges);

      return {
        ...current,
        [board.id]: currentItems.map((item) => snappedById[item.id] ?? item),
      };
    });
  }

  function showArrangeMenu(event) {
    event.preventDefault();
    if (suppressNextFloatingMenuRef.current) {
      suppressNextFloatingMenuRef.current = false;
      setContextMenu(null);
      return;
    }
    if (!board.id) {
      setContextMenu(null);
      return;
    }
    const point = floatingPointFromClient(event.clientX, event.clientY);
    setContextMenu({ x: event.clientX, y: event.clientY, boardX: point.x, boardY: point.y });
  }

  function addFloatingTextFromMenu() {
    addFloatingText({ x: contextMenu?.boardX ?? 96, y: contextMenu?.boardY ?? 96 });
  }

  function addFloatingTextFromDoubleClick(event) {
    if (event.target.closest?.(".floating-item, .floating-note, .floating-context-menu, .floating-grip, .floating-hotzone")) return;
    addFloatingText(floatingPointFromClient(event.clientX, event.clientY));
  }

  function handleFloatingDragOver(event) {
    if (!hasAssetDragData(event.dataTransfer) && !isExternalMediaDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  }

  async function handleFloatingDrop(event) {
    if (!hasAssetDragData(event.dataTransfer) && !isExternalMediaDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (hasAssetDragData(event.dataTransfer)) {
      addDroppedAssetsToFloating(readAssetDragIds(event.dataTransfer), event.clientX, event.clientY);
      return;
    }

    const existingAssetIds = assetIdsFromDroppedFiles(event.dataTransfer.files, assets);
    if (existingAssetIds.length > 0) {
      addDroppedAssetsToFloating(existingAssetIds, event.clientX, event.clientY);
      return;
    }

    const metadata = getDropImportMetadata(event.dataTransfer);
    const importedAssets = await importExternalMediaToFloating(event.dataTransfer.files, metadata);
    if (importedAssets.length > 0) {
      await addAssetObjectsToFloating(importedAssets, event.clientX, event.clientY);
    }
  }

  function arrangeFloating(mode) {
    if (!board.id) {
      setContextMenu(null);
      return;
    }
    const selectedIds = selectedFloatingIds.size > 0 ? selectedFloatingIds : null;
    const imageItems = items.filter((item) => item.assetId && (!selectedIds || selectedIds.has(item.id)));
    if (imageItems.length === 0) {
      setContextMenu(null);
      return;
    }

    checkpointBoardItems(board.id);
    const startX = selectedIds ? Math.min(...imageItems.map((item) => item.x)) : 0;
    const startY = selectedIds ? Math.min(...imageItems.map((item) => item.y)) : 0;
    let cursor = 0;
    let gridX = startX;
    let gridY = startY;
    let rowHeight = 0;
    const arranged = imageItems.map((item, index) => {
      if (mode === "row") {
        const next = { ...item, x: startX + cursor, y: startY };
        cursor += item.width;
        return next;
      }
      if (mode === "column") {
        const next = { ...item, x: startX, y: startY + cursor };
        cursor += item.height;
        return next;
      }
      const tileWidth = 248;
      const fittedSize = fitExistingItemSize(item, { maxWidth: tileWidth, maxHeight: tileWidth, minWidth: 80, minHeight: 64 });
      if (index > 0 && index % 3 === 0) {
        gridX = startX;
        gridY += rowHeight;
        rowHeight = 0;
      }
      const next = {
        ...item,
        x: gridX,
        y: gridY,
        width: fittedSize.width,
        height: fittedSize.height,
      };
      gridX += fittedSize.width;
      rowHeight = Math.max(rowHeight, fittedSize.height);
      return next;
    });

    setBoardItems((current) => {
      if (!selectedIds) {
        const noteItems = items.filter((item) => !item.assetId);
        return {
          ...current,
          [board.id]: [...arranged, ...noteItems],
        };
      }

      const arrangedById = new Map(arranged.map((item) => [item.id, item]));
      return {
        ...current,
        [board.id]: (current[board.id] ?? []).map((item) => arrangedById.get(item.id) ?? item),
      };
    });
    setContextMenu(null);
  }

  function showItemMenu(event, itemId) {
    event.preventDefault();
    event.stopPropagation();
    floatingShellRef.current?.focus?.({ preventScroll: true });
    if (!selectedFloatingIds.has(itemId)) {
      setSelectedFloatingIds(new Set([itemId]));
    }
    setContextMenu({ x: event.clientX, y: event.clientY, itemId });
  }

  function deleteFloatingItems(itemIds) {
    if (!board.id) return;
    const deletingIds = new Set(itemIds);
    checkpointBoardItems(board.id);
    setBoardItems((current) => ({
      ...current,
      [board.id]: (current[board.id] ?? []).filter((item) => !deletingIds.has(item.id)),
    }));
    setSelectedFloatingIds(new Set());
    setContextMenu(null);
  }

  return (
    <main
      ref={floatingShellRef}
      tabIndex={0}
      className={classNames(
        "floating-shell",
        controlsVisible && "controls-visible",
        windowDragState && "window-dragging",
        panState && "viewport-panning",
        resizeState && "resizing-items",
        selectionBox && "selecting",
      )}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => scheduleHideFloatingControls(520)}
      onPointerDown={handleFloatingPointerDown}
      onPointerUp={stopWindowDrag}
      onWheel={handleFloatingWheel}
      onAuxClick={(event) => event.preventDefault()}
      onClick={() => setContextMenu(null)}
      onContextMenu={showArrangeMenu}
      onDoubleClick={addFloatingTextFromDoubleClick}
      onDragOver={handleFloatingDragOver}
      onDrop={handleFloatingDrop}
    >
      <div
        className="floating-hotzone"
        onPointerEnter={showFloatingControls}
        onPointerMove={showFloatingControls}
        onMouseEnter={showFloatingControls}
        aria-hidden="true"
      />
      <div className="floating-grip" onPointerEnter={showFloatingControls} onMouseEnter={showFloatingControls} onPointerLeave={hideFloatingControls}>
        <div className="floating-title">
          <strong>*{board.name || "Untitled"}</strong>
        </div>
        <div className="floating-actions">
          <button
            className={classNames("pin-button", alwaysOnTop && "active")}
            onClick={toggleAlwaysOnTop}
            title={alwaysOnTop ? "取消置顶" : "置顶显示"}
            aria-pressed={alwaysOnTop}
          >
            {alwaysOnTop ? <Pin size={15} /> : <PinOff size={15} />}
          </button>
          <span className="floating-zoom-label">{Math.round(zoom * 100)}%</span>
          <button onClick={() => changeFloatingZoom(-0.12)} title="缩小">
            <ZoomOut size={15} />
          </button>
          <button onClick={() => changeFloatingZoom(0.12)} title="放大">
            <ZoomIn size={15} />
          </button>
          <button onClick={() => window.referenceBoard?.minimizeWindow?.()} title="最小化">
            <Minus size={15} />
          </button>
          <button onClick={() => window.referenceBoard?.toggleMaximizeWindow?.()} title="最大化">
            <Square size={13} />
          </button>
          <button onClick={closeWindow}>
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="floating-canvas">
        <div
          ref={floatingSurfaceRef}
          className="floating-surface"
          style={{
            transform: viewportTransform(viewportOffset, zoom),
            "--selection-control-scale": String(1 / zoom),
            "--selection-outline-width": `${2 / zoom}px`,
            "--selection-stroke-width": `${1 / zoom}px`,
            "--selection-toolbar-gap": `${8 / zoom}px`,
          }}
        >
          {items.length === 0 ? (
            <div className="floating-empty">
              <Images size={34} />
              <p>这个白板还没有参考图</p>
            </div>
          ) : null}
          {items.map((item) => {
            const asset = item.assetId ? assetById.get(item.assetId) : null;
            const isFloatingSelected = selectedFloatingIds.has(item.id);
            if (item.type === "note") {
              return (
                <div
                  className={classNames("floating-note", isFloatingSelected && "selected", editingNoteId === item.id && "editing")}
                  key={item.id}
                  data-note-id={item.id}
                  style={{ left: item.x, top: item.y, width: item.width, height: item.height }}
                  onPointerDown={(event) => startFloatingDrag(event, item)}
                  onContextMenu={(event) => showItemMenu(event, item.id)}
                >
                  <textarea
                    value={item.text}
                    readOnly={editingNoteId !== item.id}
                    style={{
                      color: noteColorValue(item),
                      fontFamily: noteFontValue(item, availableNoteFonts),
                      fontSize: `${Number(item.fontSize) || 16}px`,
                    }}
                    onChange={(event) => updateFloatingText(item, event.target.value)}
                    onFocus={() => setEditingNoteId(item.id)}
                    onBlur={() => setEditingNoteId((current) => (current === item.id ? "" : current))}
                    onPointerDown={(event) => {
                      if (editingNoteId === item.id) {
                        event.stopPropagation();
                      } else {
                        event.preventDefault();
                      }
                    }}
                    onMouseDown={(event) => {
                      if (editingNoteId === item.id) event.stopPropagation();
                    }}
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      beginFloatingNoteEditing(item.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") event.currentTarget.blur();
                    }}
                    placeholder="输入文字"
                    spellCheck={false}
                    aria-label="编辑文本"
                  />
                  {isFloatingSelected && selectedFloatingIds.size === 1 && editingNoteId !== item.id ? (
                    <TextNodeToolbar
                      item={item}
                      onChange={(patch) => updateFloatingNoteStyle(item, patch)}
                      placeBelow={viewportOffset.y + item.y * zoom < 48}
                    />
                  ) : null}
                  {isFloatingSelected && selectedFloatingIds.size === 1 ? (
                    <div
                      className="selection-handles"
                      onPointerDown={(event) => {
                        if (event.defaultPrevented) return;
                        const handle = resizeHandleFromTarget(event.target);
                        if (handle) startFloatingResize(event, item, handle);
                      }}
                    >
                      {["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((handle) =>
                        handle === "se" ? (
                          <button
                            key={handle}
                            type="button"
                            className="selection-handle se item-resize-handle"
                            onPointerDown={(event) => startFloatingResize(event, item)}
                            onMouseDown={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                            }}
                            title="拖动缩放"
                            aria-label="拖动缩放"
                          />
                        ) : (
                          <span key={handle} className={`selection-handle ${handle}`} />
                        ),
                      )}
                    </div>
                  ) : null}
                </div>
              );
            }
            if (!asset) return null;
            return (
              <article
                className={classNames("floating-item", isAssetVideo(asset) && "is-video", isFloatingSelected && "selected")}
                key={item.id}
                style={{ left: item.x, top: item.y, width: item.width, height: item.height }}
                onPointerDown={(event) => startFloatingDrag(event, item)}
                onContextMenu={(event) => showItemMenu(event, item.id)}
              >
                <BoardMedia
                  asset={asset}
                  item={item}
                  zoom={zoom}
                  alt={asset.title}
                  onImageLoad={(event) => syncFloatingItemAspect(item, event.currentTarget)}
                  onVideoMetadata={(event) => syncFloatingItemAspect(item, event.currentTarget)}
                />
                {isFloatingSelected && selectedFloatingIds.size === 1 ? (
                  <div
                    className="selection-handles"
                    onPointerDown={(event) => {
                      if (event.defaultPrevented) return;
                      const handle = resizeHandleFromTarget(event.target);
                      if (handle) startFloatingResize(event, item, handle);
                    }}
                  >
                    {["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((handle) =>
                      handle === "se" ? (
                        <button
                          key={handle}
                          type="button"
                          className="selection-handle se item-resize-handle"
                          onPointerDown={(event) => startFloatingResize(event, item)}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          title="拖动缩放"
                          aria-label="拖动缩放"
                        />
                      ) : (
                        <span key={handle} className={`selection-handle ${handle}`} />
                      ),
                    )}
                  </div>
                ) : null}
              </article>
            );
          })}
          {floatingGroupSelectionBox ? (
            <div
              className="group-selection-frame"
              style={{
                left: floatingGroupSelectionBox.x,
                top: floatingGroupSelectionBox.y,
                width: floatingGroupSelectionBox.width,
                height: floatingGroupSelectionBox.height,
              }}
              onPointerDown={startFloatingGroupDrag}
              onContextMenu={(event) => showItemMenu(event, selectedFloatingItems[0].id)}
              onDoubleClick={(event) => event.stopPropagation()}
              title="拖动移动选中内容"
            >
              <div
                className="selection-handles"
                onPointerDown={(event) => {
                  const handle = resizeHandleFromTarget(event.target);
                  if (handle) startFloatingResize(event, selectedFloatingItems[0], handle);
                }}
              >
                {resizeHandleNames.map((handle) => (
                  <button
                    key={handle}
                    type="button"
                    className={`selection-handle ${handle} item-resize-handle`}
                    title="拖动缩放选中内容"
                    aria-label={`从${handle}方向缩放选中内容`}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {selectionBox ? (
        <div
          className="floating-selection-box"
          style={{ left: selectionBox.left, top: selectionBox.top, width: selectionBox.width, height: selectionBox.height }}
        />
      ) : null}
      {floatingPreviewAsset ? (
        <div
          className="image-preview-backdrop"
          role="dialog"
          aria-modal="true"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={() => setFloatingPreviewAssetId("")}
        >
          <section className="image-preview-modal" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
            <div className="image-preview-topbar">
              <div>
                <strong>{floatingPreviewAsset.title}</strong>
                <span>{floatingPreviewAsset.dimensions || floatingPreviewAsset.size} · 空格关闭</span>
              </div>
              <button type="button" onClick={() => setFloatingPreviewAssetId("")} aria-label="关闭预览" title="关闭预览">
                <X size={17} />
              </button>
            </div>
            <div className={classNames("image-preview-stage", isAssetVideo(floatingPreviewAsset) && "is-video")}>
              <div
                className="image-preview-viewport"
                style={
                  isAssetVideo(floatingPreviewAsset)
                    ? undefined
                    : { width: "calc(100% - 48px)", height: "calc(100% - 32px)", transform: "translate3d(-50%, -50%, 0)" }
                }
              >
                {isAssetVideo(floatingPreviewAsset) ? (
                  <div className="image-preview-video-frame">
                    <InlineVideoMedia asset={floatingPreviewAsset} alt={floatingPreviewAsset.title} preload="auto" autoPlay />
                  </div>
                ) : (
                  <MediaElement asset={floatingPreviewAsset} alt={floatingPreviewAsset.title} />
                )}
              </div>
            </div>
            <div className="image-preview-strip" />
          </section>
        </div>
      ) : null}
      {contextMenu ? (
        <div
          className="floating-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
        >
          {contextMenu.itemId ? (
            <>
              <button
                onClick={() =>
                  deleteFloatingItems(selectedFloatingIds.has(contextMenu.itemId) ? Array.from(selectedFloatingIds) : [contextMenu.itemId])
                }
              >
                {selectedFloatingIds.size > 1 && selectedFloatingIds.has(contextMenu.itemId) ? "删除选中" : "删除这张图"}
              </button>
              {floatingContextIsNote ? (
                <div className="note-style-panel">
                  <select
                    className="note-font-select"
                    value={noteFontValue(floatingContextItem, availableNoteFonts)}
                    onChange={(event) => updateFloatingNoteStyleFromMenu({ fontFamily: event.target.value })}
                    aria-label="字体"
                  >
                    {availableNoteFonts.map((option) => (
                      <option key={option.label} value={option.value} style={{ fontFamily: option.value }}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <div className="note-color-row" aria-label="文本颜色">
                    {noteColorOptions.map((color) => (
                      <button
                        key={color}
                        className={classNames(noteColorValue(floatingContextItem) === color && "active")}
                        style={{ "--note-color": color }}
                        onClick={() => updateFloatingNoteStyleFromMenu({ color })}
                        title="文本颜色"
                        aria-label={`文本颜色 ${color}`}
                      />
                    ))}
                    <input
                      className="note-custom-color"
                      type="color"
                      value={noteColorValue(floatingContextItem)}
                      onChange={(event) => updateFloatingNoteStyleFromMenu({ color: event.target.value })}
                      title="自定义颜色"
                      aria-label="自定义文字颜色"
                    />
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <button onClick={addFloatingTextFromMenu}>添加文本</button>
          )}
          <button onClick={() => arrangeFloating("grid")}>{selectedFloatingIds.size > 0 ? "网格排列选中" : "网格排列"}</button>
          <button onClick={() => arrangeFloating("row")}>{selectedFloatingIds.size > 0 ? "横向排列选中" : "横向排列"}</button>
          <button onClick={() => arrangeFloating("column")}>{selectedFloatingIds.size > 0 ? "纵向排列选中" : "纵向排列"}</button>
        </div>
      ) : null}
    </main>
  );
}
