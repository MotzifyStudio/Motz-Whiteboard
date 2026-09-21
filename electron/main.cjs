const { app, BrowserWindow, Menu, ipcMain, shell, screen, dialog, nativeImage, clipboard, protocol } = require("electron");
const { execFile, execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { fileURLToPath, pathToFileURL } = require("node:url");

const isDev = process.env.ELECTRON_DEV_SERVER_URL;
const floatingWindows = new Map();
const pluginBridgePorts = [39875, 39876];
let pluginBridgePort = pluginBridgePorts[0];
let mainWindowRef = null;
let mainRendererReady = false;
let pluginBridgeServer = null;
const pendingPluginCollections = [];
const pendingBoardFileResults = [];
const pendingBoardFilePaths = [];
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif", ".tif", ".tiff"]);
const videoExtensions = new Set([".mp4", ".mov", ".qt", ".m4v", ".webm", ".mkv", ".avi", ".wmv", ".flv", ".mpeg", ".mpg", ".3gp", ".3g2", ".ts", ".mts", ".ogv", ".ogm"]);
const mediaExtensions = new Set([...imageExtensions, ...videoExtensions]);
const appIconPath = path.join(__dirname, "..", "build", "icon.ico");
const defaultLibraryId = "library-default";
const boardFileMagic = Buffer.from("MOTZBOARD1\n", "utf8");
const maxBoardHeaderBytes = 64 * 1024 * 1024;
const boardClipboardPrefix = "MOTZ_BOARD_ITEMS:";
let installedFontFamiliesCache = null;

app.setName("MOTZ白板");
app.setPath("userData", process.env.MOTZ_USER_DATA_DIR || path.join(app.getPath("appData"), "MOTZ白板"));

// The renderer is served over HTTP while developing, so Chromium refuses direct
// file:// subresources. A dedicated protocol keeps referenced files usable in
// both development and packaged builds without disabling web security.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "motz-media",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

function installedFontFamilies() {
  if (installedFontFamiliesCache) return installedFontFamiliesCache;

  let families = [];
  if (process.platform === "win32") {
    try {
      const script = [
        "Add-Type -AssemblyName System.Drawing",
        "$fonts = New-Object System.Drawing.Text.InstalledFontCollection",
        "@($fonts.Families | ForEach-Object { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Name)) } | Sort-Object -Unique) | ConvertTo-Json -Compress",
      ].join("; ");
      const output = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      ).trim();
      const parsed = output ? JSON.parse(output.replace(/^\uFEFF/, "")) : [];
      const encodedFamilies = Array.isArray(parsed) ? parsed : [parsed];
      families = encodedFamilies.map((encodedFamily) => Buffer.from(String(encodedFamily || ""), "base64").toString("utf8"));
    } catch {
      families = [];
    }
  }

  installedFontFamiliesCache = Array.from(
    new Set(
      families
        .map((family) => String(family || "").trim())
        .filter((family) => family && !family.includes("\uFFFD")),
    ),
  ).sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
  return installedFontFamiliesCache;
}

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
}

function librarySettingsId(libraryId = "") {
  return String(libraryId || defaultLibraryId).trim() || defaultLibraryId;
}

function defaultLibraryRoot(libraryId = defaultLibraryId) {
  const id = librarySettingsId(libraryId);
  if (id === defaultLibraryId) return path.join(app.getPath("userData"), "library");
  return path.join(app.getPath("userData"), "libraries", sanitizePathPart(id));
}

function getLibraryRoot(libraryId = "") {
  const settings = readSettings();
  const id = librarySettingsId(libraryId || settings.activeLibraryId);
  const libraryRoots = settings.libraryRoots && typeof settings.libraryRoots === "object" ? settings.libraryRoots : {};
  const scopedRoot = typeof libraryRoots[id] === "string" ? libraryRoots[id].trim() : "";
  if (scopedRoot) return scopedRoot;
  const legacyRoot = id === defaultLibraryId && typeof settings.libraryRoot === "string" ? settings.libraryRoot.trim() : "";
  return legacyRoot || defaultLibraryRoot(id);
}

function activateLibraryRoot(library = {}) {
  const settings = readSettings();
  const id = librarySettingsId(library?.id);
  const nextSettings = {
    ...settings,
    activeLibraryId: id,
    libraryRoots: settings.libraryRoots && typeof settings.libraryRoots === "object" ? { ...settings.libraryRoots } : {},
  };
  const requestedRoot = typeof library?.root === "string" ? library.root.trim() : "";
  if (requestedRoot) {
    nextSettings.libraryRoots[id] = requestedRoot;
    if (id === defaultLibraryId) nextSettings.libraryRoot = requestedRoot;
  }
  const libraryRoot = requestedRoot || getLibraryRoot(id);
  fs.mkdirSync(libraryRoot, { recursive: true });
  writeSettings(nextSettings);
  return libraryRoot;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "本地图片";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function scanMediaFiles(directory) {
  const results = [];
  const stack = [directory];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.forEach((entry) => {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".motz-board-assets") return;
        stack.push(fullPath);
        return;
      }
      if (entry.isFile() && mediaExtensions.has(path.extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    });
  }

  return results.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function isImagePath(filePath) {
  return imageExtensions.has(path.extname(filePath || "").toLowerCase());
}

function isVideoPath(filePath) {
  return videoExtensions.has(path.extname(filePath || "").toLowerCase());
}

function normalizeFileCheckPath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^file:\/\//i.test(text)) {
    try {
      return fileURLToPath(text);
    } catch {
      return "";
    }
  }
  return text;
}

function mediaUrlForPath(filePath) {
  const normalizedPath = normalizeFileCheckPath(filePath);
  if (!normalizedPath) return "";
  return `motz-media://local/${Buffer.from(path.resolve(normalizedPath), "utf8").toString("base64url")}`;
}

function mediaPathFromUrl(requestUrl) {
  try {
    const url = new URL(requestUrl);
    if (url.protocol !== "motz-media:" || url.hostname !== "local") return "";
    const token = url.pathname.replace(/^\/+/, "");
    const filePath = Buffer.from(token, "base64url").toString("utf8");
    const resolvedPath = path.resolve(filePath);
    return mediaExtensions.has(path.extname(resolvedPath).toLowerCase()) && fs.existsSync(resolvedPath) ? resolvedPath : "";
  } catch {
    return "";
  }
}

// Electron 只能写自定义格式，写不出标准的 CF_HDROP（RegisterClipboardFormat("CF_HDROP")
// 拿到的是另一个 id），所以单选视频时借 PowerShell 把整份文件写进系统剪贴板。
function powerShellStringLiteral(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function writeWindowsFileClipboard(filePath, text = "") {
  return new Promise((resolve) => {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$data = New-Object System.Windows.Forms.DataObject",
      "$files = New-Object System.Collections.Specialized.StringCollection",
      `$files.Add(${powerShellStringLiteral(filePath)})`,
      "$data.SetFileDropList($files)",
      ...(text ? [`$data.SetText(${powerShellStringLiteral(text)})`] : []),
      "[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)",
    ].join("; ");
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 10000 },
      (error) => resolve(!error),
    );
  });
}

// 单选本地视频：剪贴板里放整份视频文件，其他应用粘贴得到的就是视频本身。
async function writeBoardFileClipboard(payload) {
  const filePath = normalizeFileCheckPath(payload?.filePath);
  const serialized = typeof payload?.serialized === "string" ? payload.serialized : "";
  if (!filePath || !fs.existsSync(filePath)) return false;
  if (process.platform !== "win32") return false;
  return writeWindowsFileClipboard(filePath, serialized ? `${boardClipboardPrefix}${serialized}` : "");
}

function writeBoardClipboardPayload(payload) {
  try {
    const serialized = typeof payload?.serialized === "string" ? payload.serialized : "";
    if (!serialized) return false;

    const clipboardPayload = { text: `${boardClipboardPrefix}${serialized}` };
    const imageBytes = payload?.imageBytes;
    const buffer = imageBytes ? Buffer.from(imageBytes) : null;
    if (buffer?.length) {
      const decoded = nativeImage.createFromBuffer(buffer);
      if (!decoded.isEmpty()) clipboardPayload.image = decoded;
    } else {
      const imagePath = normalizeFileCheckPath(payload?.imagePath);
      if (imagePath && fs.existsSync(imagePath) && isImagePath(imagePath)) {
        const image = nativeImage.createFromPath(imagePath);
        if (!image.isEmpty()) clipboardPayload.image = image;
      }
    }
    clipboard.write(clipboardPayload);
    return true;
  } catch {
    return false;
  }
}

function sanitizePathPart(value) {
  return String(value || "素材库").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "素材库";
}

function ensureLibraryDir(folderName = "未分类") {
  const libraryDir = path.join(getLibraryRoot(), sanitizePathPart(folderName));
  fs.mkdirSync(libraryDir, { recursive: true });
  return libraryDir;
}

function uniqueLibraryPath(sourcePath, folderName) {
  const targetDir = ensureLibraryDir(folderName);
  const parsed = path.parse(sourcePath);
  const baseName = sanitizePathPart(parsed.name);
  const ext = parsed.ext || ".png";
  let targetPath = path.join(targetDir, `${baseName}${ext}`);
  let index = 1;

  while (fs.existsSync(targetPath)) {
    targetPath = path.join(targetDir, `${baseName}-${index}${ext}`);
    index += 1;
  }

  return targetPath;
}

function uniqueLibraryPathFromName(fileName, folderName, fallbackExt = ".png") {
  const targetDir = ensureLibraryDir(folderName);
  const parsed = path.parse(fileName || "web-image.png");
  const baseName = sanitizePathPart(parsed.name || "web-image");
  const ext = mediaExtensions.has(parsed.ext.toLowerCase()) ? parsed.ext : fallbackExt;
  let targetPath = path.join(targetDir, `${baseName}${ext}`);
  let index = 1;

  while (fs.existsSync(targetPath)) {
    targetPath = path.join(targetDir, `${baseName}-${index}${ext}`);
    index += 1;
  }

  return targetPath;
}

function readImageDimensions(filePath) {
  try {
    const image = nativeImage.createFromPath(filePath);
    const size = image.getSize();
    return size.width > 0 && size.height > 0 ? size : null;
  } catch {
    return null;
  }
}

function imageThumbnailCacheDir() {
  const cacheDir = path.join(app.getPath("userData"), "thumbnail-cache-v1");
  fs.mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

function createImageThumbnail(filePath, requestedMaxDimension = 640) {
  const normalizedPath = normalizeFileCheckPath(filePath);
  if (!normalizedPath || !isImagePath(normalizedPath) || !fs.existsSync(normalizedPath)) return null;

  const stats = fs.statSync(normalizedPath);
  if (!stats.isFile()) return null;
  const maxDimension = [640, 1280, 2048, 3072].find((value) => Number(requestedMaxDimension) <= value) || 3072;
  const cacheKey = crypto
    .createHash("sha1")
    .update(`${path.resolve(normalizedPath)}|${stats.size}|${stats.mtimeMs}|${maxDimension}|v1`)
    .digest("hex");
  const cacheDir = imageThumbnailCacheDir();
  const cachedJpegPath = path.join(cacheDir, `${cacheKey}.jpg`);
  const cachedPngPath = path.join(cacheDir, `${cacheKey}.png`);
  const cachedPath = fs.existsSync(cachedJpegPath) ? cachedJpegPath : fs.existsSync(cachedPngPath) ? cachedPngPath : "";

  if (cachedPath) {
    return { source: normalizedPath, thumbnail: pathToFileURL(cachedPath).toString(), maxDimension };
  }

  const image = nativeImage.createFromPath(normalizedPath);
  if (image.isEmpty()) return null;
  const size = image.getSize();
  if (!(size.width > 0) || !(size.height > 0)) return null;
  if (Math.max(size.width, size.height) <= maxDimension) {
    return { source: normalizedPath, thumbnail: pathToFileURL(normalizedPath).toString(), maxDimension };
  }
  const scale = maxDimension / Math.max(size.width, size.height);
  const thumbnail = image.resize({
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
    quality: maxDimension > 640 ? "best" : "good",
  });
  const hasAlpha = new Set([".png", ".gif", ".webp", ".avif", ".tif", ".tiff"]).has(path.extname(normalizedPath).toLowerCase());
  const outputPath = hasAlpha ? cachedPngPath : cachedJpegPath;
  const buffer = hasAlpha ? thumbnail.toPNG() : thumbnail.toJPEG(maxDimension > 640 ? 90 : 84);
  fs.writeFileSync(outputPath, buffer);
  return { source: normalizedPath, thumbnail: pathToFileURL(outputPath).toString(), maxDimension };
}

function createLibraryAsset(targetPath, index = 0, type = "导入", originalSource = "", note = "已复制到软件素材库。", tags = ["本地"], extra = {}) {
  const stats = fs.statSync(targetPath);
  const importedAt = new Date().toLocaleString("zh-CN", { hour12: false });
  const dimensions = readImageDimensions(targetPath);

  return {
    id: `library-${Date.now()}-${index}-${crypto.randomUUID()}`,
    title: path.basename(targetPath, path.extname(targetPath)),
    size: formatBytes(stats.size),
    type,
    image: pathToFileURL(targetPath).toString(),
    mediaKind: "image",
    tags,
    folder: extra.folder || "",
    source: targetPath,
    originalSource: originalSource || targetPath,
    libraryCopy: true,
    note,
    created: importedAt,
    ...(dimensions
      ? {
          pixelWidth: dimensions.width,
          pixelHeight: dimensions.height,
          dimensions: `${dimensions.width} x ${dimensions.height}`,
        }
      : {}),
    ...extra,
  };
}

function createVideoLibraryAsset(
  targetPath,
  index = 0,
  type = "导入",
  originalSource = "",
  note = "已复制到软件素材库。",
  tags = ["视频", "本地"],
  extra = {},
) {
  const stats = fs.statSync(targetPath);
  const importedAt = new Date().toLocaleString("zh-CN", { hour12: false });
  const mediaUrl = pathToFileURL(targetPath).toString();

  return {
    id: `video-${Date.now()}-${index}-${crypto.randomUUID()}`,
    title: path.basename(targetPath, path.extname(targetPath)),
    size: formatBytes(stats.size),
    type,
    image: mediaUrl,
    mediaUrl,
    mediaKind: "video",
    tags: Array.from(new Set(["视频", ...tags])),
    folder: extra.folder || "",
    source: targetPath,
    originalSource: originalSource || targetPath,
    libraryCopy: true,
    note,
    created: importedAt,
    ...extra,
  };
}

function isPathInside(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function uniqueSiblingPath(sourcePath, nextTitle) {
  const parsed = path.parse(sourcePath);
  const baseName = sanitizePathPart(nextTitle || parsed.name);
  const ext = parsed.ext || ".png";
  let targetPath = path.join(parsed.dir, `${baseName}${ext}`);
  let index = 1;

  while (fs.existsSync(targetPath) && path.resolve(targetPath) !== path.resolve(sourcePath)) {
    targetPath = path.join(parsed.dir, `${baseName}-${index}${ext}`);
    index += 1;
  }

  return targetPath;
}

function copyImageToLibrary(sourcePath, folderName, index = 0, type = "导入") {
  const targetPath = uniqueLibraryPath(sourcePath, folderName);
  fs.copyFileSync(sourcePath, targetPath);
  return createLibraryAsset(targetPath, index, type, sourcePath, "已复制到软件素材库。", ["本地"], { folder: folderName });
}

function copyVideoToLibrary(sourcePath, folderName, index = 0, type = "导入") {
  const targetPath = uniqueLibraryPath(sourcePath, folderName);
  fs.copyFileSync(sourcePath, targetPath);
  return createVideoLibraryAsset(targetPath, index, type, sourcePath, "已复制到软件素材库。", ["本地"], { folder: folderName });
}

function referenceMediaFromPath(sourcePath, folderName, index = 0, type = "本地引用") {
  const extra = {
    folder: folderName,
    libraryCopy: false,
    referencedSource: true,
  };
  if (isVideoPath(sourcePath)) {
    return createVideoLibraryAsset(
      sourcePath,
      index,
      type,
      sourcePath,
      "引用电脑中的原始视频，移动或删除原文件后需要重新定位。",
      ["视频", "本地", "引用"],
      extra,
    );
  }
  return createLibraryAsset(
    sourcePath,
    index,
    type,
    sourcePath,
    "引用电脑中的原始图片，移动或删除原文件后需要重新定位。",
    ["本地", "引用"],
    extra,
  );
}

function mediaKindForPath(filePath) {
  return isVideoPath(filePath) ? "video" : isImagePath(filePath) ? "image" : "";
}

function parseApproxBytes(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)$/i);
  if (!match) return 0;
  const units = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };
  return Number(match[1]) * units[match[2].toUpperCase()];
}

function relativeLibraryFolder(filePath) {
  const libraryRoot = getLibraryRoot();
  if (!isPathInside(libraryRoot, filePath)) return "";
  const relativeDir = path.relative(libraryRoot, path.dirname(filePath));
  if (!relativeDir || relativeDir === ".") return "";
  return relativeDir
    .split(path.sep)
    .map((part) => sanitizePathPart(part))
    .filter(Boolean)
    .join(" / ");
}

function createAssetPatchFromPath(filePath) {
  const stats = fs.statSync(filePath);
  const mediaKind = mediaKindForPath(filePath);
  const mediaUrl = pathToFileURL(filePath).toString();
  const patch = {
    source: filePath,
    image: mediaUrl,
    mediaKind,
    mediaUrl: mediaKind === "video" ? mediaUrl : "",
    size: formatBytes(stats.size),
    libraryCopy: isPathInside(getLibraryRoot(), filePath),
  };

  if (mediaKind === "image") {
    const dimensions = readImageDimensions(filePath);
    if (dimensions) {
      patch.pixelWidth = dimensions.width;
      patch.pixelHeight = dimensions.height;
      patch.dimensions = `${dimensions.width} x ${dimensions.height}`;
    }
  }

  return {
    filePath,
    suggestedTitle: path.basename(filePath, path.extname(filePath)),
    patch,
  };
}

function scoreMediaCandidate(candidatePath, entry, oldPath) {
  const requestedKind = entry?.mediaKind === "video" ? "video" : "image";
  if (mediaKindForPath(candidatePath) !== requestedKind) return Number.NEGATIVE_INFINITY;

  let score = 0;
  const candidate = path.parse(candidatePath);
  const old = path.parse(oldPath || "");
  const candidateName = candidate.name.toLowerCase();
  const oldName = old.name.toLowerCase();
  const title = String(entry?.title || "").trim().toLowerCase();

  if (candidate.ext.toLowerCase() === old.ext.toLowerCase()) score += 14;
  if (candidateName === oldName) score += 80;
  if (title && candidateName === title) score += 45;
  if (title && (candidateName.includes(title) || title.includes(candidateName))) score += 22;

  try {
    const stats = fs.statSync(candidatePath);
    const expectedBytes = parseApproxBytes(entry?.size);
    if (expectedBytes > 0) {
      const delta = Math.abs(stats.size - expectedBytes);
      const ratio = delta / Math.max(expectedBytes, stats.size, 1);
      if (ratio < 0.015) score += 35;
      else if (ratio < 0.08) score += 18;
    }
    score += Math.min(6, stats.mtimeMs / 10 ** 13);
  } catch {
    return Number.NEGATIVE_INFINITY;
  }

  if (requestedKind === "image" && Number(entry?.pixelWidth) > 0 && Number(entry?.pixelHeight) > 0) {
    const dimensions = readImageDimensions(candidatePath);
    if (dimensions?.width === Number(entry.pixelWidth) && dimensions?.height === Number(entry.pixelHeight)) {
      score += 90;
    }
  }

  return score;
}

function findReplacementMediaPath(oldPath, entry) {
  if (!oldPath) return "";
  const directory = path.dirname(oldPath);
  if (!directory || !fs.existsSync(directory)) return "";

  let candidates = [];
  try {
    candidates = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((item) => item.isFile())
      .map((item) => path.join(directory, item.name))
      .filter((filePath) => mediaKindForPath(filePath) === (entry?.mediaKind === "video" ? "video" : "image"));
  } catch {
    return "";
  }

  if (candidates.length === 0) return "";
  if (candidates.length === 1) return candidates[0];

  const scored = candidates
    .map((filePath) => ({ filePath, score: scoreMediaCandidate(filePath, entry, oldPath) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  if (!best) return "";

  const isStrongMatch = best.score >= 70 && (!second || best.score - second.score >= 8);
  return isStrongMatch ? best.filePath : "";
}

function resolveMediaReference(entry) {
  const originalPath = normalizeFileCheckPath(entry?.path);
  if (!originalPath) return { id: entry?.id, status: "missing", path: entry?.path || "" };

  if (fs.existsSync(originalPath)) {
    try {
      if (entry?.mediaKind === "video" && !entry?.referencedSource && !isPathInside(getLibraryRoot(), originalPath) && !entry?.boardFileAsset) {
        const copied = copyVideoToLibrary(originalPath, entry?.folder || "", 0, entry?.type || "视频迁移");
        return {
          id: entry?.id,
          status: "relinked",
          path: entry?.path,
          filePath: copied.source,
          suggestedTitle: copied.title,
          patch: {
            source: copied.source,
            image: copied.image,
            mediaUrl: copied.mediaUrl,
            mediaKind: "video",
            size: copied.size,
            libraryCopy: true,
            originalSource: entry?.originalSource || originalPath,
            note: entry?.note || "已将旧版视频引用复制到软件素材库。",
          },
        };
      }
      return { id: entry?.id, status: "exists", path: entry?.path, ...createAssetPatchFromPath(originalPath) };
    } catch {
      return { id: entry?.id, status: "missing", path: entry?.path };
    }
  }

  const replacementPath = findReplacementMediaPath(originalPath, entry);
  if (!replacementPath) return { id: entry?.id, status: "missing", path: entry?.path || originalPath };

  try {
    if (entry?.mediaKind === "video" && !isPathInside(getLibraryRoot(), replacementPath) && !entry?.boardFileAsset) {
      const copied = copyVideoToLibrary(replacementPath, entry?.folder || "", 0, entry?.type || "视频迁移");
      return {
        id: entry?.id,
        status: "relinked",
        path: entry?.path,
        filePath: copied.source,
        suggestedTitle: copied.title,
        patch: {
          source: copied.source,
          image: copied.image,
          mediaUrl: copied.mediaUrl,
          mediaKind: "video",
          size: copied.size,
          libraryCopy: true,
          originalSource: entry?.originalSource || originalPath,
          note: entry?.note || "已将旧版视频引用复制到软件素材库。",
        },
      };
    }
    return { id: entry?.id, status: "relinked", path: entry?.path, ...createAssetPatchFromPath(replacementPath) };
  } catch {
    return { id: entry?.id, status: "missing", path: entry?.path || originalPath };
  }
}

function createIndexedAssetFromLibraryPath(filePath, index = 0) {
  const folderName = relativeLibraryFolder(filePath);
  if (isVideoPath(filePath)) {
    return createVideoLibraryAsset(filePath, index, "库内文件", filePath, "从素材库文件夹刷新识别。", ["本地"], { folder: folderName });
  }
  return createLibraryAsset(filePath, index, "库内文件", filePath, "从素材库文件夹刷新识别。", ["本地"], { folder: folderName });
}

function importPathsToLibrary(filePaths, folderName = "未分类", type = "导入", importMode = "copy") {
  const shouldReference = importMode === "reference";
  return filePaths
    .filter((filePath) => isImagePath(filePath) || isVideoPath(filePath))
    .map((filePath, index) => {
      try {
        if (shouldReference) {
          return referenceMediaFromPath(filePath, folderName, index, type === "导入" ? "本地引用" : type);
        }
        if (isVideoPath(filePath)) {
          return copyVideoToLibrary(filePath, folderName, index, type);
        }
        return copyImageToLibrary(filePath, folderName, index, type);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function extensionFromContentType(contentType = "") {
  const normalized = contentType.split(";")[0].trim().toLowerCase();
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/avif": ".avif",
    "image/tiff": ".tif",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-matroska": ".mkv",
    "video/x-msvideo": ".avi",
    "video/x-ms-wmv": ".wmv",
    "video/x-flv": ".flv",
    "video/mpeg": ".mpeg",
    "video/3gpp": ".3gp",
    "video/3gpp2": ".3g2",
    "video/mp2t": ".ts",
    "video/ogg": ".ogv",
  };
  return map[normalized] || "";
}

function fileNameFromUrl(remoteUrl, contentType = "", index = 0) {
  let fileName = "";
  try {
    const url = new URL(remoteUrl);
    fileName = decodeURIComponent(path.basename(url.pathname || ""));
  } catch {
    fileName = "";
  }

  const parsed = path.parse(fileName || "");
  const contentExt = extensionFromContentType(contentType);
  const ext = mediaExtensions.has(parsed.ext.toLowerCase()) ? parsed.ext : contentExt || ".png";
  const mediaLabel = videoExtensions.has(ext.toLowerCase()) ? "web-video" : "web-image";
  return `${parsed.name || `${mediaLabel}-${Date.now()}-${index}`}${ext}`;
}

function fileNameFromUpload(fileName, contentType = "", index = 0) {
  const parsed = path.parse(String(fileName || "").trim());
  const contentExt = extensionFromContentType(contentType);
  const ext = mediaExtensions.has(parsed.ext.toLowerCase()) ? parsed.ext : contentExt || ".png";
  const mediaLabel = videoExtensions.has(ext.toLowerCase()) ? "local-video" : "local-image";
  return `${sanitizePathPart(parsed.name || `${mediaLabel}-${Date.now()}-${index}`)}${ext}`;
}

function parseImageDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i);
  if (!match) return null;

  const contentType = match[1].toLowerCase();
  const ext = extensionFromContentType(contentType);
  if (!ext) return null;

  const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (buffer.length === 0) return null;
  return { buffer, contentType };
}

function importImageDataUrlToLibrary(item, folderName, index = 0) {
  const parsed = parseImageDataUrl(item?.dataUrl);
  if (!parsed) throw new Error("Unsupported image data");

  const sourceUrl = String(item?.url || "").trim();
  const originalSource = String(item?.pageUrl || sourceUrl || "").trim();
  const fileName =
    String(item?.fileName || "").trim() ||
    fileNameFromUrl(sourceUrl || `plugin-image-${Date.now()}-${index}.png`, parsed.contentType, index);

  return writeImageBufferToLibrary(
    parsed.buffer,
    fileName,
    folderName,
    index,
    "浏览器插件",
    originalSource || sourceUrl,
    "通过浏览器插件收藏并备份到素材库。",
    ["网页", "插件"],
    { remoteSource: sourceUrl },
  );
}

function writeImageBufferToLibrary(buffer, fileName, folderName, index, type, originalSource, note, tags, extra = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const { storageFolder = folderName, ...assetExtra } = extra;
  const requestedExt = path.extname(fileName || "").toLowerCase();
  const mediaKind = videoExtensions.has(requestedExt) ? "video" : "image";
  const targetPath = uniqueLibraryPathFromName(fileName, storageFolder, mediaKind === "video" ? requestedExt : ".png");
  fs.writeFileSync(targetPath, buffer);
  if (mediaKind === "video") {
    return createVideoLibraryAsset(targetPath, index, type, originalSource, note, tags, { ...assetExtra, folder: folderName });
  }
  return createLibraryAsset(targetPath, index, type, originalSource, note, tags, { ...assetExtra, folder: folderName });
}

function cloneSerializable(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function boardAssetMetadata(asset) {
  const metadata = cloneSerializable(asset, {});
  delete metadata.image;
  delete metadata.mediaUrl;
  delete metadata.source;
  return metadata;
}

function boardImageSourcePath(asset) {
  const candidates = [asset?.source, asset?.image, asset?.originalSource];
  for (const candidate of candidates) {
    const filePath = normalizeFileCheckPath(candidate);
    if (filePath && fs.existsSync(filePath) && isImagePath(filePath)) return filePath;
  }
  return "";
}

function boardVideoSourcePath(asset) {
  const candidates = [asset?.source, asset?.mediaUrl, asset?.image, asset?.originalSource];
  for (const candidate of candidates) {
    const filePath = normalizeFileCheckPath(candidate);
    if (filePath && fs.existsSync(filePath) && isVideoPath(filePath)) return filePath;
  }
  return "";
}

function makeBoardAssetFileName(asset, sourcePath, index, mediaKind = "image") {
  const sourceExt = path.extname(sourcePath || "").toLowerCase();
  const allowedExtensions = mediaKind === "video" ? videoExtensions : imageExtensions;
  const ext = allowedExtensions.has(sourceExt) ? sourceExt : mediaKind === "video" ? ".mp4" : ".png";
  const title = sanitizePathPart(asset?.title || `白板${mediaKind === "video" ? "视频" : "图片"}-${index + 1}`);
  return `${title}${ext}`;
}

function writeAll(fileDescriptor, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const bytesWritten = fs.writeSync(fileDescriptor, buffer, offset, buffer.length - offset);
    if (bytesWritten <= 0) throw new Error("无法写入白板文件");
    offset += bytesWritten;
  }
}

function appendFileToDescriptor(fileDescriptor, sourcePath) {
  const sourceDescriptor = fs.openSync(sourcePath, "r");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    let position = 0;
    while (true) {
      const bytesRead = fs.readSync(sourceDescriptor, buffer, 0, buffer.length, position);
      if (bytesRead <= 0) break;
      writeAll(fileDescriptor, buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    fs.closeSync(sourceDescriptor);
  }
}

function writeEmbeddedMediaToLibrary(sourceDescriptor, entry, options = {}) {
  const length = Number(entry?.length);
  const dataPosition = Number(entry?.dataPosition);
  if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(dataPosition) || dataPosition < 0) return null;

  const {
    folderName = "",
    storageFolder = folderName,
    index = 0,
    type = "白板文件",
    mediaKind = entry?.mediaKind === "video" ? "video" : "image",
    originalSource = "",
    note = "从 MOTZ 白板文件导入。",
    tags = [],
    extra = {},
  } = options;
  const fallbackExt = mediaKind === "video" ? ".mp4" : ".png";
  const fallbackName = `白板${mediaKind === "video" ? "视频" : "图片"}-${index + 1}${fallbackExt}`;
  const targetPath = uniqueLibraryPathFromName(entry?.fileName || fallbackName, storageFolder, fallbackExt);
  const targetDescriptor = fs.openSync(targetPath, "w");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);

  try {
    let copied = 0;
    while (copied < length) {
      const bytesToRead = Math.min(buffer.length, length - copied);
      const bytesRead = fs.readSync(sourceDescriptor, buffer, 0, bytesToRead, dataPosition + copied);
      if (bytesRead <= 0) throw new Error("白板文件中的素材数据不完整");
      writeAll(targetDescriptor, buffer.subarray(0, bytesRead));
      copied += bytesRead;
    }
  } catch (error) {
    fs.closeSync(targetDescriptor);
    try {
      fs.unlinkSync(targetPath);
    } catch {
      // Preserve the extraction error.
    }
    throw error;
  }
  fs.closeSync(targetDescriptor);

  const assetExtra = { ...extra, folder: folderName };
  if (mediaKind === "video") {
    return createVideoLibraryAsset(targetPath, index, type, originalSource, note, tags, assetExtra);
  }
  return createLibraryAsset(targetPath, index, type, originalSource, note, tags, assetExtra);
}

function writeBoardPackage(filePath, payload) {
  const board = cloneSerializable(payload?.board, null);
  const items = cloneSerializable(payload?.items, []);
  const requestedAssets = Array.isArray(payload?.assets) ? payload.assets : [];
  if (!board || !Array.isArray(items)) throw new Error("无效的白板数据");

  const embedded = [];
  const assets = requestedAssets.map((asset, index) => {
    const metadata = boardAssetMetadata(asset);
    const mediaKind = asset?.mediaKind === "video" ? "video" : "image";
    const sourcePath = mediaKind === "video" ? boardVideoSourcePath(asset) : boardImageSourcePath(asset);
    if (!sourcePath) {
      return {
        ...metadata,
        mediaKind,
        embeddedIndex: -1,
      };
    }

    const descriptor = {
      assetId: String(asset.id || ""),
      fileName: makeBoardAssetFileName(asset, sourcePath, index, mediaKind),
      mediaKind,
      length: fs.statSync(sourcePath).size,
      sourcePath,
    };
    const embeddedIndex = embedded.length;
    embedded.push(descriptor);
    return {
      ...metadata,
      mediaKind,
      embeddedIndex,
    };
  });

  const header = {
    format: "motz-board",
    version: 2,
    exportedAt: new Date().toISOString(),
    board,
    items,
    assets,
    embedded: embedded.map(({ sourcePath: _sourcePath, ...descriptor }) => descriptor),
  };
  const headerBuffer = Buffer.from(JSON.stringify(header), "utf8");
  if (headerBuffer.length > maxBoardHeaderBytes) throw new Error("白板数据过大");

  const lengthBuffer = Buffer.allocUnsafe(4);
  lengthBuffer.writeUInt32LE(headerBuffer.length, 0);
  const descriptor = fs.openSync(filePath, "w");
  try {
    writeAll(descriptor, boardFileMagic);
    writeAll(descriptor, lengthBuffer);
    writeAll(descriptor, headerBuffer);
    embedded.forEach((entry) => {
      appendFileToDescriptor(descriptor, entry.sourcePath);
    });
  } finally {
    fs.closeSync(descriptor);
  }

  return {
    imageCount: assets.filter((asset) => asset.mediaKind !== "video" && asset.embeddedIndex >= 0).length,
    videoCount: assets.filter((asset) => asset.mediaKind === "video" && asset.embeddedIndex >= 0).length,
    missingImageCount: assets.filter((asset) => asset.mediaKind !== "video" && asset.embeddedIndex < 0).length,
    missingVideoCount: assets.filter((asset) => asset.mediaKind === "video" && asset.embeddedIndex < 0).length,
    videoReferenceCount: 0,
  };
}

function readExactBuffer(fileDescriptor, length, position) {
  if (!Number.isSafeInteger(length) || length < 0 || length > 1024 * 1024 * 1024) {
    throw new Error("白板文件中的素材大小无效");
  }
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const bytesRead = fs.readSync(fileDescriptor, buffer, offset, length - offset, position + offset);
    if (bytesRead <= 0) throw new Error("白板文件不完整");
    offset += bytesRead;
  }
  return buffer;
}

function readBoardPackage(filePath) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const stats = fs.fstatSync(descriptor);
    const prefixLength = boardFileMagic.length + 4;
    if (stats.size < prefixLength) throw new Error("不是有效的 MOTZ 白板文件");

    const magic = readExactBuffer(descriptor, boardFileMagic.length, 0);
    if (!magic.equals(boardFileMagic)) throw new Error("不是有效的 MOTZ 白板文件");

    const headerLengthBuffer = readExactBuffer(descriptor, 4, boardFileMagic.length);
    const headerLength = headerLengthBuffer.readUInt32LE(0);
    if (headerLength <= 0 || headerLength > maxBoardHeaderBytes || prefixLength + headerLength > stats.size) {
      throw new Error("白板文件头无效");
    }

    const headerBuffer = readExactBuffer(descriptor, headerLength, prefixLength);
    const header = JSON.parse(headerBuffer.toString("utf8"));
    if (
      header?.format !== "motz-board" ||
      ![1, 2].includes(header?.version) ||
      !header.board ||
      !Array.isArray(header.items) ||
      !Array.isArray(header.assets)
    ) {
      throw new Error("不支持的 MOTZ 白板文件");
    }

    const embedded = Array.isArray(header.embedded) ? header.embedded : [];
    const embeddedEntries = [];
    let dataPosition = prefixLength + headerLength;
    embedded.forEach((entry) => {
      const length = Number(entry?.length);
      if (!Number.isSafeInteger(length) || length < 0 || dataPosition + length > stats.size) {
        throw new Error("白板文件中的素材数据不完整");
      }
      embeddedEntries.push({ ...entry, dataPosition });
      dataPosition += length;
    });

    const folderName = "";
    const boardStorageFolder = ".motz-board-assets";
    const idMap = new Map();
    let missingVideoCount = 0;
    let missingImageCount = 0;
    const assets = header.assets
      .map((asset, index) => {
        const oldId = String(asset?.id || "");
        const tags = Array.from(new Set([...(Array.isArray(asset?.tags) ? asset.tags : []), "白板文件"]));

        if (asset?.mediaKind === "video") {
          const embeddedIndex = Number(asset?.embeddedIndex);
          const entry = Number.isInteger(embeddedIndex) ? embeddedEntries[embeddedIndex] : null;
          if (entry) {
            const imported = writeEmbeddedMediaToLibrary(descriptor, entry, {
              folderName,
              storageFolder: boardStorageFolder,
              index,
              type: "白板文件",
              mediaKind: "video",
              originalSource: asset.originalSource || "",
              note: asset.note || "从 MOTZ 白板文件导入。",
              tags,
              extra: {
                remoteSource: asset.remoteSource || "",
                boardFileAsset: true,
                boardFileSource: filePath,
              },
            });
            if (imported) {
              const importedAsset = {
                ...asset,
                ...imported,
                title: asset.title || imported.title,
                tags,
                folder: folderName,
                boardFileAsset: true,
                boardFileSource: filePath,
              };
              if (oldId) idMap.set(oldId, importedAsset.id);
              return importedAsset;
            }
          }

          const sourcePath = boardVideoSourcePath(asset);
          let importedAsset;
          if (sourcePath && fs.existsSync(sourcePath) && isVideoPath(sourcePath)) {
            const targetPath = uniqueLibraryPath(sourcePath, boardStorageFolder);
            fs.copyFileSync(sourcePath, targetPath);
            importedAsset = {
              ...asset,
              ...createVideoLibraryAsset(
                targetPath,
                index,
                "白板文件",
                asset.originalSource || sourcePath,
                asset.note || "从旧版 MOTZ 白板路径引用恢复。",
                tags,
                {
                  folder: folderName,
                  boardFileAsset: true,
                  boardFileSource: filePath,
                },
              ),
              title: asset.title || path.basename(sourcePath, path.extname(sourcePath)),
              tags,
              folder: folderName,
              boardFileAsset: true,
              boardFileSource: filePath,
            };
          } else {
            missingVideoCount += 1;
            const mediaUrl = sourcePath ? pathToFileURL(sourcePath).toString() : "";
            importedAsset = {
              ...asset,
              id: `video-board-${Date.now()}-${index}-${crypto.randomUUID()}`,
              title: asset.title || `缺失视频-${index + 1}`,
              image: mediaUrl,
              mediaUrl,
              mediaKind: "video",
              source: sourcePath,
              originalSource: asset.originalSource || sourcePath,
              libraryCopy: false,
              type: "白板文件",
              tags,
              folder: folderName,
              boardFileAsset: true,
              boardFileSource: filePath,
              note: `${asset.note ? `${asset.note}\n` : ""}当前电脑未找到白板文件引用的视频。`,
            };
          }
          if (oldId) idMap.set(oldId, importedAsset.id);
          return importedAsset;
        }

        const embeddedIndex = Number(asset?.embeddedIndex);
        const entry = Number.isInteger(embeddedIndex) ? embeddedEntries[embeddedIndex] : null;
        if (!entry) {
          missingImageCount += 1;
          return null;
        }

        const imported = writeEmbeddedMediaToLibrary(descriptor, entry, {
          folderName,
          storageFolder: boardStorageFolder,
          index,
          type: "白板文件",
          mediaKind: "image",
          originalSource: asset.originalSource || "",
          note: asset.note || "从 MOTZ 白板文件导入。",
          tags,
          extra: {
            remoteSource: asset.remoteSource || "",
            boardFileAsset: true,
            boardFileSource: filePath,
          },
        });
        if (!imported) {
          missingImageCount += 1;
          return null;
        }

        const importedAsset = {
          ...asset,
          ...imported,
          title: asset.title || imported.title,
          tags,
          folder: folderName,
          boardFileAsset: true,
          boardFileSource: filePath,
        };
        if (oldId) idMap.set(oldId, importedAsset.id);
        return importedAsset;
      })
      .filter(Boolean);

    const importedItems = header.items
      .map((item, index) => {
        const nextItem = {
          ...item,
          id: `board-item-${Date.now()}-${index}-${crypto.randomUUID()}`,
        };
        if (!item?.assetId) return nextItem;
        const nextAssetId = idMap.get(String(item.assetId));
        return nextAssetId ? { ...nextItem, assetId: nextAssetId } : null;
      })
      .filter(Boolean);

    return {
      board: {
        ...header.board,
        id: `board-import-${Date.now()}-${crypto.randomUUID()}`,
        name: String(header.board.name || "导入白板").trim() || "导入白板",
      },
      items: importedItems,
      assets,
      folderName,
      collectionId: "board-assets",
      missingVideoCount,
      missingImageCount,
      videoReferenceCount: header.assets.filter((asset) => asset?.mediaKind === "video").length,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function runBoardPackageSelfTest() {
  const tempRoot = fs.mkdtempSync(path.join(app.getPath("temp"), "motz-board-test-"));
  const imagePath = path.join(tempRoot, "sample.png");
  const videoPath = path.join(tempRoot, "sample.mp4");
  const boardPath = path.join(tempRoot, "sample.motzboard");
  const imageBuffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const videoBuffer = Buffer.concat([Buffer.from("00000018667479706d703432", "hex"), crypto.randomBytes(6 * 1024 * 1024)]);

  try {
    fs.writeFileSync(imagePath, imageBuffer);
    fs.writeFileSync(videoPath, videoBuffer);
    const copiedVideo = importPathsToLibrary([videoPath], "self-test", "导入测试")[0];
    if (
      !copiedVideo?.libraryCopy ||
      !copiedVideo.source ||
      path.resolve(copiedVideo.source) === path.resolve(videoPath) ||
      !fs.readFileSync(copiedVideo.source).equals(videoBuffer)
    ) {
      throw new Error("Video import did not create a library copy");
    }
    const summary = writeBoardPackage(boardPath, {
      board: { id: "self-test-board", name: "Self test" },
      items: [
        { id: "item-image", assetId: "asset-image", x: 10, y: 20, w: 100, h: 100 },
        { id: "item-video", assetId: "asset-video", x: 120, y: 20, w: 160, h: 90 },
      ],
      assets: [
        { id: "asset-image", title: "Image", source: imagePath, image: pathToFileURL(imagePath).toString(), mediaKind: "image" },
        { ...copiedVideo, id: "asset-video", title: "Video" },
      ],
    });
    const opened = readBoardPackage(boardPath);
    const openedVideo = opened.assets.find((asset) => asset.mediaKind === "video");
    const openedImage = opened.assets.find((asset) => asset.mediaKind !== "video");
    if (summary.imageCount !== 1 || summary.videoCount !== 1 || opened.assets.length !== 2 || opened.items.length !== 2) {
      throw new Error("Board package counts did not round-trip");
    }
    if (!openedVideo?.source || !fs.existsSync(openedVideo.source) || !fs.readFileSync(openedVideo.source).equals(videoBuffer)) {
      throw new Error("Embedded video did not round-trip");
    }
    if (!openedImage?.source || !fs.existsSync(openedImage.source) || !fs.readFileSync(openedImage.source).equals(imageBuffer)) {
      throw new Error("Embedded image did not round-trip");
    }
    return { ok: true, videoLibraryCopy: true, ...summary, openedAssets: opened.assets.length, openedItems: opened.items.length };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function boardFilePathFromArgs(args) {
  const candidate = (Array.isArray(args) ? args : [])
    .map((value) => String(value || "").trim().replace(/^"(.*)"$/, "$1"))
    .find((value) => value.toLowerCase().endsWith(".motzboard"));
  return candidate ? path.resolve(candidate) : "";
}

function openBoardPackageResult(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) throw new Error("找不到这个白板文件");
    return { ok: true, canceled: false, filePath, ...readBoardPackage(filePath) };
  } catch (error) {
    return { ok: false, canceled: false, filePath, reason: error?.message || "打开白板文件失败" };
  }
}

function flushBoardFileResults() {
  if (!mainRendererReady || !mainWindowRef || mainWindowRef.isDestroyed() || mainWindowRef.webContents.isLoading()) return;
  while (pendingBoardFileResults.length > 0) {
    mainWindowRef.webContents.send("board-file-opened", pendingBoardFileResults.shift());
  }
}

function dispatchBoardFilePath(filePath) {
  const result = openBoardPackageResult(filePath);
  if (!mainRendererReady || !mainWindowRef || mainWindowRef.isDestroyed() || mainWindowRef.webContents.isLoading()) {
    pendingBoardFileResults.push(result);
    return;
  }
  mainWindowRef.webContents.send("board-file-opened", result);
  if (mainWindowRef.isMinimized()) mainWindowRef.restore();
  mainWindowRef.show();
  mainWindowRef.focus();
}

async function downloadImageToLibrary(remoteUrl, folderName, index = 0, originalSource = "") {
  const url = new URL(remoteUrl);
  if (!["http:", "https:"].includes(url.protocol)) return null;

  const headers = {
    "User-Agent": "Mozilla/5.0 MOTZ-Whiteboard/0.3",
  };
  if (/^https?:\/\//i.test(originalSource) && originalSource !== remoteUrl) {
    headers.Referer = originalSource;
  }

  const response = await fetch(url.toString(), { headers });
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);

  const contentType = response.headers.get("content-type") || "";
  const urlExt = path.extname(url.pathname).toLowerCase();
  const isVideo = contentType.toLowerCase().startsWith("video/") || videoExtensions.has(urlExt);
  const isImage = contentType.toLowerCase().startsWith("image/") || imageExtensions.has(urlExt);
  if (!isVideo && !isImage) {
    throw new Error(`Not a supported media response: ${contentType || "unknown"}`);
  }

  const fileName = fileNameFromUrl(remoteUrl, contentType, index);
  const targetPath = uniqueLibraryPathFromName(fileName, folderName, isVideo ? ".mp4" : ".png");
  try {
    if (!response.body) throw new Error("Download response has no body");
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(targetPath));

    if (!isVideo) {
      const decoded = nativeImage.createFromPath(targetPath);
      const decodedSize = decoded.getSize();
      if (!(decodedSize.width > 0 && decodedSize.height > 0)) {
        throw new Error(`Not a decodable image response: ${contentType || "unknown"}`);
      }
    }
  } catch (error) {
    try {
      if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    } catch {
      // Preserve the download error.
    }
    throw error;
  }

  if (isVideo) {
    return createVideoLibraryAsset(
      targetPath,
      index,
      "网页视频",
      originalSource || remoteUrl,
      "从网页拖入并备份到软件素材库。",
      ["网页", "视频"],
      { remoteSource: remoteUrl, folder: folderName },
    );
  }
  return createLibraryAsset(
    targetPath,
    index,
    "网页图片",
    originalSource || remoteUrl,
    "从网页拖入并备份到软件素材库。",
    ["网页"],
    { remoteSource: remoteUrl, folder: folderName },
  );
}

function loadApp(window, query = {}) {
  if (isDev) {
    const url = new URL(isDev);
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
    window.loadURL(url.toString());
  } else {
    window.loadFile(path.join(__dirname, "..", "dist", "index.html"), { query });
  }
}

function showWindowWithFade(window) {
  window.setOpacity(0);
  window.show();

  let opacity = 0;
  const timer = setInterval(() => {
    if (window.isDestroyed()) {
      clearInterval(timer);
      return;
    }

    opacity = Math.min(1, opacity + 0.12);
    window.setOpacity(opacity);
    if (opacity >= 1) clearInterval(timer);
  }, 16);
}

function writePluginResponse(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "7200",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function normalizePluginItem(item) {
  const url = String(item?.url || item?.src || item?.imageUrl || "").trim();
  const dataUrl = String(item?.dataUrl || "").trim();
  const hasRemoteUrl = /^https?:\/\//i.test(url);
  const hasImageData = /^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl);
  if (!hasRemoteUrl && !hasImageData) return null;
  const pageUrl = String(item?.pageUrl || item?.originalSource || item?.sourcePage || "").trim();
  return {
    url,
    dataUrl: hasImageData ? dataUrl : "",
    fileName: String(item?.fileName || "").slice(0, 220),
    mimeType: String(item?.mimeType || "").slice(0, 80),
    pageUrl: /^https?:\/\//i.test(pageUrl) ? pageUrl : "",
    title: String(item?.title || "").slice(0, 160),
    alt: String(item?.alt || "").slice(0, 160),
  };
}

function publicPluginItems(items) {
  return items.map(({ dataUrl, ...item }) => item);
}

function flushPluginCollections() {
  if (!mainWindowRef || mainWindowRef.isDestroyed() || mainWindowRef.webContents.isLoading()) return;
  while (pendingPluginCollections.length > 0) {
    mainWindowRef.webContents.send("plugin-collect", pendingPluginCollections.shift());
  }
}

function dispatchPluginCollection(payload) {
  if (!mainWindowRef || mainWindowRef.isDestroyed() || mainWindowRef.webContents.isLoading()) {
    pendingPluginCollections.push(payload);
    return true;
  }
  mainWindowRef.webContents.send("plugin-collect", payload);
  return true;
}

async function importPluginItemsToLibrary(items, folderName = "") {
  const importedAssets = [];
  const errors = [];

  for (const [index, item] of items.entries()) {
    try {
      const asset = item.dataUrl
        ? importImageDataUrlToLibrary(item, folderName, index)
        : await downloadImageToLibrary(item.url, folderName, index, item.pageUrl || item.url);
      if (asset) {
        importedAssets.push({
          ...asset,
          originalSource: item.pageUrl || asset.originalSource || item.url,
          remoteSource: item.url,
          type: "浏览器插件",
          tags: Array.from(new Set([...(asset.tags ?? []), "网页", "插件"])),
          note: "通过浏览器插件收藏并备份到素材库。",
        });
      }
    } catch (error) {
      errors.push({
        url: item.url,
        error: error?.message || "Download failed",
      });
    }
  }

  return { importedAssets, errors };
}

function readRequestBody(request, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function startPluginBridgeServer(portIndex = 0) {
  if (pluginBridgeServer) return;
  pluginBridgePort = pluginBridgePorts[portIndex] || pluginBridgePorts[0];

  pluginBridgeServer = http.createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      writePluginResponse(response, 204, {});
      return;
    }

    const requestUrl = new URL(request.url || "/", `http://127.0.0.1:${pluginBridgePort}`);
    if (request.method === "GET" && requestUrl.pathname === "/status") {
      writePluginResponse(response, 200, { ok: true, app: "MOTZ", port: pluginBridgePort });
      return;
    }

    if (request.method !== "POST" || requestUrl.pathname !== "/collect") {
      writePluginResponse(response, 404, { ok: false, error: "Not found" });
      return;
    }

    try {
      const body = JSON.parse(await readRequestBody(request, 128 * 1024 * 1024));
      const items = (Array.isArray(body?.items) ? body.items : [body]).map(normalizePluginItem).filter(Boolean).slice(0, 24);
      if (items.length === 0) {
        writePluginResponse(response, 400, { ok: false, error: "No supported image URL" });
        return;
      }

      const target = body?.target === "board" ? "board" : "library";
      const folderName = String(body?.folderName || "").trim();
      const { importedAssets, errors } = await importPluginItemsToLibrary(items, folderName);
      if (importedAssets.length === 0) {
        writePluginResponse(response, 502, {
          ok: false,
          error: errors[0]?.error || "Image download failed",
          errors,
        });
        return;
      }

      dispatchPluginCollection({
        source: "browser-extension",
        target,
        items: publicPluginItems(items),
        assets: importedAssets,
        folderName,
        errors,
        receivedAt: Date.now(),
      });
      writePluginResponse(response, 200, {
        ok: true,
        accepted: items.length,
        imported: importedAssets.length,
        failed: errors.length,
      });
    } catch (error) {
      writePluginResponse(response, 400, { ok: false, error: error?.message || "Bad request" });
    }
  });

  pluginBridgeServer.listen(pluginBridgePort, "127.0.0.1");
  pluginBridgeServer.on("error", (error) => {
    console.warn("MOTZ plugin bridge failed:", error?.message || error);
    pluginBridgeServer = null;
    if (error?.code === "EADDRINUSE" && portIndex + 1 < pluginBridgePorts.length) {
      startPluginBridgeServer(portIndex + 1);
    }
  });
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1360,
    height: 820,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    backgroundColor: "#202222",
    icon: appIconPath,
    title: "MOTZ白板",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  mainRendererReady = false;
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    flushPluginCollections();
    flushBoardFileResults();
  });

  mainWindow.webContents.on("did-finish-load", () => {
    flushPluginCollections();
    flushBoardFileResults();
  });
  mainWindow.on("closed", () => {
    if (mainWindowRef === mainWindow) mainWindowRef = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindowRef = mainWindow;
  loadApp(mainWindow);
}

function createFloatingWindow(boardId) {
  const existing = floatingWindows.get(boardId);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }

  const floatingWindow = new BrowserWindow({
    width: 920,
    height: 620,
    minWidth: 360,
    minHeight: 260,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    hasShadow: false,
    thickFrame: false,
    backgroundColor: "#111312",
    icon: appIconPath,
    title: "MOTZ白板 浮窗",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  floatingWindows.set(boardId, floatingWindow);
  floatingWindow.once("ready-to-show", () => showWindowWithFade(floatingWindow));
  floatingWindow.on("closed", () => floatingWindows.delete(boardId));
  loadApp(floatingWindow, { floating: "1", board: boardId });
}

const initialBoardFilePath = boardFilePathFromArgs(process.argv.slice(1));
const hasSingleInstanceLock = app.requestSingleInstanceLock({ boardFilePath: initialBoardFilePath });

if (!hasSingleInstanceLock) {
  app.exit(0);
} else {
  app.on("second-instance", (_event, commandLine, _workingDirectory, additionalData) => {
    const boardFilePath = boardFilePathFromArgs(commandLine) || String(additionalData?.boardFilePath || "");
    if (boardFilePath) dispatchBoardFilePath(boardFilePath);
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      if (mainWindowRef.isMinimized()) mainWindowRef.restore();
      mainWindowRef.show();
      mainWindowRef.focus();
    }
  });

  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    if (app.isReady()) {
      dispatchBoardFilePath(filePath);
    } else {
      pendingBoardFilePaths.push(filePath);
    }
  });
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  if (process.argv.includes("--self-test-board-package")) {
    try {
      console.log(JSON.stringify(runBoardPackageSelfTest()));
      app.exit(0);
    } catch (error) {
      console.error(error?.stack || error?.message || String(error));
      app.exit(1);
    }
    return;
  }
  protocol.registerFileProtocol("motz-media", (request, callback) => {
    const filePath = mediaPathFromUrl(request.url);
    callback(filePath ? { path: filePath } : { error: -6 });
  });
  Menu.setApplicationMenu(null);
  startPluginBridgeServer();
  ipcMain.on("renderer-ready", (event) => {
    if (!mainWindowRef || mainWindowRef.isDestroyed() || event.sender !== mainWindowRef.webContents) return;
    mainRendererReady = true;
    flushBoardFileResults();
  });
  ipcMain.handle("open-floating-board", (_event, boardId) => {
    createFloatingWindow(String(boardId || "b1"));
    return true;
  });
  ipcMain.handle("close-floating-window", (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner) owner.close();
    return true;
  });
  ipcMain.handle("window-minimize", (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner) owner.minimize();
    return true;
  });
  ipcMain.handle("window-toggle-maximize", (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner?.isMaximized()) {
      owner.unmaximize();
    } else {
      owner?.maximize();
    }
    return true;
  });
  ipcMain.handle("window-close", (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner) owner.close();
    return true;
  });
  ipcMain.handle("window-is-always-on-top", (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    return owner?.isAlwaysOnTop() ?? false;
  });
  ipcMain.handle("window-set-always-on-top", (event, value) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) return false;
    if (value) {
      owner.setAlwaysOnTop(true, "screen-saver");
      owner.moveTop();
    } else {
      owner.setAlwaysOnTop(false);
    }
    return owner.isAlwaysOnTop();
  });
  ipcMain.handle("window-drag-begin", (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) return null;
    const cursor = screen.getCursorScreenPoint();
    const bounds = owner.getBounds();
    return {
      offsetX: cursor.x - bounds.x,
      offsetY: cursor.y - bounds.y,
    };
  });
  ipcMain.handle("window-drag-move", (event, drag) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || !drag) return false;
    const cursor = screen.getCursorScreenPoint();
    owner.setPosition(Math.round(cursor.x - drag.offsetX), Math.round(cursor.y - drag.offsetY), false);
    return true;
  });
  ipcMain.handle("list-system-fonts", () => installedFontFamilies());
  ipcMain.handle("get-library-root", (_event, libraryId = "") => {
    const libraryRoot = getLibraryRoot(libraryId);
    fs.mkdirSync(libraryRoot, { recursive: true });
    return libraryRoot;
  });
  ipcMain.handle("get-media-url", (_event, filePath) => mediaUrlForPath(filePath));
  ipcMain.handle("activate-library", (_event, library = {}) => {
    return activateLibraryRoot(library);
  });
  ipcMain.handle("choose-library-root", async (event, libraryId = "") => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const id = librarySettingsId(libraryId || readSettings().activeLibraryId);
    const result = await dialog.showOpenDialog(owner, {
      title: "选择素材库保存位置",
      defaultPath: getLibraryRoot(id),
      properties: ["openDirectory", "createDirectory"],
    });

    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true, libraryRoot: getLibraryRoot(id) };
    }

    const libraryRoot = result.filePaths[0];
    fs.mkdirSync(libraryRoot, { recursive: true });
    const settings = readSettings();
    const nextSettings = {
      ...settings,
      activeLibraryId: id,
      libraryRoots: settings.libraryRoots && typeof settings.libraryRoots === "object" ? { ...settings.libraryRoots, [id]: libraryRoot } : { [id]: libraryRoot },
    };
    if (id === defaultLibraryId) nextSettings.libraryRoot = libraryRoot;
    writeSettings(nextSettings);
    return { canceled: false, libraryRoot };
  });
  ipcMain.handle("save-board-file", async (event, payload = {}) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const boardName = sanitizePathPart(payload?.board?.name || "未命名白板");
    const result = await dialog.showSaveDialog(owner, {
      title: "另存 MOTZ 白板文件",
      defaultPath: `${boardName}.motzboard`,
      filters: [{ name: "MOTZ 白板文件", extensions: ["motzboard"] }],
    });

    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const filePath = result.filePath.toLowerCase().endsWith(".motzboard") ? result.filePath : `${result.filePath}.motzboard`;

    try {
      const summary = writeBoardPackage(filePath, payload);
      return { ok: true, canceled: false, filePath, ...summary };
    } catch (error) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // Keep the original export error.
      }
      return { ok: false, canceled: false, reason: error?.message || "保存白板文件失败" };
    }
  });
  ipcMain.handle("open-board-file", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(owner, {
      title: "打开 MOTZ 白板文件",
      properties: ["openFile"],
      filters: [{ name: "MOTZ 白板文件", extensions: ["motzboard"] }],
    });

    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    const filePath = result.filePaths[0];
    return openBoardPackageResult(filePath);
  });
  ipcMain.handle("import-image-files", async (event, folderName = "未分类", importMode = "copy") => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(owner, {
      title: "选择参考素材",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Supported media", extensions: Array.from(mediaExtensions).map((ext) => ext.replace(".", "")) },
        { name: "Images", extensions: Array.from(imageExtensions).map((ext) => ext.replace(".", "")) },
        { name: "Videos", extensions: Array.from(videoExtensions).map((ext) => ext.replace(".", "")) },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, assets: [] };
    }

    return {
      canceled: false,
      folderName,
      assets: importPathsToLibrary(result.filePaths, folderName, "导入", importMode),
    };
  });
  ipcMain.handle("import-image-paths", (_event, filePaths, folderName = "未分类", typeLabel = "导入", importMode = "copy") => {
    return {
      canceled: false,
      folderName,
      assets: importPathsToLibrary(Array.isArray(filePaths) ? filePaths : [], folderName, typeLabel || "导入", importMode),
    };
  });
  ipcMain.handle("import-image-data", (_event, items, folderName = "未分类") => {
    const importedAssets = (Array.isArray(items) ? items : [])
      .map((item, index) => {
        try {
          const buffer = Buffer.from(item?.buffer ?? []);
          return writeImageBufferToLibrary(
            buffer,
            fileNameFromUpload(item?.name, item?.type, index),
            folderName,
            index,
            item?.typeLabel || "网页拖拽",
            item?.originalSource || item?.remoteSource || "",
            item?.note || "从网页拖入并备份到软件素材库。",
            item?.tags || ["网页"],
            { remoteSource: item?.remoteSource || "" },
          );
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    return {
      canceled: false,
      folderName,
      assets: importedAssets,
    };
  });
  ipcMain.handle("import-image-urls", async (_event, urls, folderName = "未分类", originalSource = "") => {
    const importedAssets = [];

    for (const [index, remoteUrl] of (Array.isArray(urls) ? urls : []).entries()) {
      try {
        const asset = await downloadImageToLibrary(remoteUrl, folderName, index, originalSource);
        if (asset) importedAssets.push(asset);
      } catch {
        // Keep importing the rest of the dragged URLs if one host blocks downloads.
      }
    }

    return {
      canceled: false,
      folderName,
      assets: importedAssets,
    };
  });
  ipcMain.handle("rename-library-asset", (_event, sourcePath, nextTitle) => {
    const cleanTitle = sanitizePathPart(nextTitle);
    if (!sourcePath || !cleanTitle) return { ok: false };

    const resolvedSource = path.resolve(sourcePath);
    if (!isPathInside(getLibraryRoot(), resolvedSource) || !fs.existsSync(resolvedSource)) {
      return { ok: false, reason: "not-library-copy" };
    }

    const targetPath = uniqueSiblingPath(resolvedSource, cleanTitle);
    if (path.resolve(targetPath) !== resolvedSource) {
      fs.renameSync(resolvedSource, targetPath);
    }

    const stats = fs.statSync(targetPath);
    const dimensions = readImageDimensions(targetPath);
    const mediaKind = mediaKindForPath(targetPath);
    const mediaUrl = pathToFileURL(targetPath).toString();
    return {
      ok: true,
      asset: {
        title: path.basename(targetPath, path.extname(targetPath)),
        source: targetPath,
        image: mediaUrl,
        mediaKind,
        mediaUrl: mediaKind === "video" ? mediaUrl : "",
        size: formatBytes(stats.size),
        libraryCopy: true,
        ...(dimensions
          ? {
              pixelWidth: dimensions.width,
              pixelHeight: dimensions.height,
              dimensions: `${dimensions.width} x ${dimensions.height}`,
            }
          : {}),
      },
    };
  });
  ipcMain.handle("delete-library-files", (_event, filePaths, libraryId = "") => {
    const libraryRoot = getLibraryRoot(libraryId);
    const deleted = [];
    const missing = [];
    const failed = [];
    const uniquePaths = Array.from(new Set(Array.isArray(filePaths) ? filePaths : []));

    uniquePaths.forEach((filePath) => {
      const normalizedPath = normalizeFileCheckPath(filePath);
      if (!normalizedPath || !isPathInside(libraryRoot, normalizedPath)) {
        failed.push({ filePath, reason: "not-library-file" });
        return;
      }
      if (!fs.existsSync(normalizedPath)) {
        missing.push(normalizedPath);
        return;
      }
      try {
        if (!fs.statSync(normalizedPath).isFile()) {
          failed.push({ filePath: normalizedPath, reason: "not-file" });
          return;
        }
        fs.unlinkSync(normalizedPath);
        deleted.push(normalizedPath);
      } catch (error) {
        failed.push({ filePath: normalizedPath, reason: error?.message || "delete-failed" });
      }
    });

    return { deleted, missing, failed };
  });
  ipcMain.handle("show-item-in-folder", (_event, filePath) => {
    if (typeof filePath === "string" && fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath);
      return true;
    }
    return false;
  });
  ipcMain.on("start-native-file-drag", (event, filePaths) => {
    const normalizedPaths = Array.from(new Set((Array.isArray(filePaths) ? filePaths : [filePaths]).map(normalizeFileCheckPath).filter(Boolean))).filter(
      (filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile(),
    );
    try {
      if (normalizedPaths.length === 0) return;

      const iconSource = normalizedPaths.find(isImagePath) || appIconPath;
      let dragIcon = nativeImage.createFromPath(iconSource);
      if (dragIcon.isEmpty()) dragIcon = nativeImage.createFromPath(appIconPath);
      if (!dragIcon.isEmpty()) {
        const size = dragIcon.getSize();
        dragIcon = size.width >= size.height
          ? dragIcon.resize({ width: 96, quality: "good" })
          : dragIcon.resize({ height: 96, quality: "good" });
      }
      event.sender.startDrag({ file: normalizedPaths[0], files: normalizedPaths, icon: dragIcon });
    } finally {
      if (!event.sender.isDestroyed()) event.sender.send("native-file-drag-ended");
    }
  });
  ipcMain.on("write-board-clipboard", (event, payload) => {
    event.returnValue = writeBoardClipboardPayload(payload);
  });
  // 多选复制出来的拼图由渲染进程合成，PNG 字节走异步通道避免阻塞渲染进程。
  ipcMain.handle("write-board-clipboard-image", (_event, payload) => writeBoardClipboardPayload(payload));
  ipcMain.handle("write-board-clipboard-file", (_event, payload) => writeBoardFileClipboard(payload));
  ipcMain.handle("check-media-paths", (_event, filePaths) => {
    const uniquePaths = Array.from(new Set(Array.isArray(filePaths) ? filePaths : []));
    return Object.fromEntries(
      uniquePaths.map((filePath) => {
        const normalizedPath = normalizeFileCheckPath(filePath);
        return [filePath, Boolean(normalizedPath && fs.existsSync(normalizedPath))];
      }),
    );
  });
  ipcMain.handle("resolve-media-references", (_event, entries) => {
    return {
      items: (Array.isArray(entries) ? entries : []).map(resolveMediaReference),
    };
  });
  ipcMain.handle("get-media-thumbnails", async (_event, entries) => {
    const results = [];
    const failures = [];
    const requestedEntries = Array.isArray(entries) ? entries.slice(0, 96) : [];
    for (const [index, entry] of requestedEntries.entries()) {
      try {
        const result = createImageThumbnail(entry?.source, entry?.maxDimension);
        if (result) results.push({ ...result, id: entry?.id || "" });
      } catch (error) {
        failures.push({ id: entry?.id || "", reason: error?.message || "thumbnail-failed" });
      }
      if (index % 2 === 1) await new Promise((resolve) => setImmediate(resolve));
    }
    return { items: results, failures };
  });
  ipcMain.handle("scan-library-media", () => {
    const libraryRoot = getLibraryRoot();
    if (!fs.existsSync(libraryRoot)) return { libraryRoot, assets: [] };
    const assets = scanMediaFiles(libraryRoot)
      .map((filePath, index) => {
        try {
          return createIndexedAssetFromLibraryPath(filePath, index);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return { libraryRoot, assets };
  });
  ipcMain.handle("import-image-folder", async (event, importMode = "copy") => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(owner, {
      title: "选择包含参考素材的文件夹",
      properties: ["openDirectory"],
    });

    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true, assets: [] };
    }

    const folderPath = result.filePaths[0];
    const folderName = path.basename(folderPath);
    const files = scanMediaFiles(folderPath);
    const importedAssets = importPathsToLibrary(files, folderName, "本地文件夹", importMode).map((asset) => ({
      ...asset,
      tags: asset.mediaKind === "video" ? ["本地文件夹", "视频", ...(importMode === "reference" ? ["引用"] : [])] : ["本地文件夹", ...(importMode === "reference" ? ["引用"] : [])],
      note:
        importMode === "reference"
          ? "从本地文件夹自动检索并引用原文件。"
          : "从本地文件夹自动检索并复制到软件素材库。",
    }));

    return {
      canceled: false,
      folderName,
      folderPath,
      assets: importedAssets,
    };
  });
  createWindow();
  if (initialBoardFilePath) pendingBoardFilePaths.unshift(initialBoardFilePath);
  Array.from(new Set(pendingBoardFilePaths.splice(0))).forEach(dispatchBoardFilePath);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
