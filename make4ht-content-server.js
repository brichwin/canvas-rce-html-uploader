#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import express from "express";
import cors from "cors";
import fg from "fast-glob";
import { JSDOM } from "jsdom";
import juice from "juice";
import mime from "mime-types";

const PORT = 3847;

// Root directory is the make4ht output folder passed on CLI.
const ROOT = path.resolve(process.argv[2] || ".");
const app = express();

app.use(cors({ origin: "*", methods: ["GET"] }));

function safeResolveUnderRoot(rel) {
  // Prevent path traversal. Only allow files under ROOT.
  const resolved = path.resolve(ROOT, rel);
  const normRoot = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (!(resolved + path.sep).startsWith(normRoot) && resolved !== ROOT) {
    throw new Error("Invalid path");
  }
  return resolved;
}

async function listHtmlFiles() {
  const patterns = ["**/*.html", "**/*.htm"];
  const entries = await fg(patterns, { cwd: ROOT, onlyFiles: true, dot: false });
  entries.sort((a, b) => a.localeCompare(b));
  return entries;
}

async function readFileText(filePath) {
  return fs.readFile(filePath, "utf8");
}

async function readFileBin(filePath) {
  return fs.readFile(filePath);
}

async function fileExists(filePath) {
  try {
    const st = await fs.stat(filePath);
    return st.isFile();
  } catch {
    return false;
  }
}

function removeEmptyTheoremParagraphs(dom2) {
  const { document } = dom2.window;
  const cards = document.querySelectorAll(".card");
  
  for (const card of cards) {
    if (card && card.lastElementChild && card.lastElementChild.tagName === 'P') {
      const text = (card.lastElementChild.innerText || '').replace(/&nbsp;|\u00A0/g, '').trim();
      if (text === "" && card.lastElementChild.childElementCount < 1) {
        card.lastElementChild.remove();
      }
    }
  }
}

async function inlineCssAndImages(htmlRelPath) {
  const htmlAbs = safeResolveUnderRoot(htmlRelPath);
  const htmlDir = path.dirname(htmlAbs);

  const originalHtml = await readFileText(htmlAbs);
  const dom = new JSDOM(originalHtml);
  const { document } = dom.window;

  // Collect CSS in document order: <link rel=stylesheet> and <style>
  let combinedCss = "";

  // Convert live NodeList to array to preserve order reliably.
  const cssNodes = Array.from(document.querySelectorAll('link[rel="stylesheet"], style'));
  for (const node of cssNodes) {
    if (node.tagName.toLowerCase() === "style") {
      combinedCss += "\n" + (node.textContent || "") + "\n";
      node.remove();
      continue;
    }

    // link rel=stylesheet
    const href = (node.getAttribute("href") || "").trim();
    if (!href) {
      node.remove();
      continue;
    }

    // Ignore remote CSS; keep it out rather than leaking network dependencies.
    if (/^https?:\/\//i.test(href)) {
      node.remove();
      continue;
    }

    const cssAbs = path.resolve(htmlDir, href);
    if (await fileExists(cssAbs)) {
      const cssText = await readFileText(cssAbs);
      combinedCss += "\n" + cssText + "\n";
    }
    node.remove();
  }

  // Rewrite <img src="..."> to data URLs (Base64)
  const warnings = [];
  const imgs = []; // Array.from(document.querySelectorAll("img"));
  for (const img of imgs) {
    const src = (img.getAttribute("src") || "").trim();
    if (!src || src.startsWith("data:")) continue;

    // Skip remote images; you can choose to fetch them, but that creates policy/safety complexity.
    if (/^https?:\/\//i.test(src)) {
      warnings.push(`Remote image left unchanged: ${src}`);
      continue;
    }

    const imgAbs = path.resolve(htmlDir, src);
    if (!(await fileExists(imgAbs))) {
      warnings.push(`Image not found: ${src}`);
      continue;
    }

    const bin = await readFileBin(imgAbs);
    const mt = mime.lookup(imgAbs) || "application/octet-stream";
    const b64 = bin.toString("base64");
    img.setAttribute("src", `data:${mt};base64,${b64}`);
  }

  // Serialize the current DOM (with CSS nodes removed and images rewritten) for inlining.
  const domHtml = dom.serialize();

  // Inline CSS rules into style="" attributes (Canvas strips <style> blocks).
  const inlinedHtml = juice(domHtml, {
    extraCss: combinedCss,
    applyStyleTags: true,
    removeStyleTags: true,
    preserveMediaQueries: false, // Canvas won't honor them anyway
    insertPreservedExtraCss: false
  });

  // Clean empty paragraphs and extract BODY innerHTML after inlining
  const dom2 = new JSDOM(inlinedHtml);
  removeEmptyTheoremParagraphs(dom2);
  const body = dom2.window.document.body;

  return {
    file: htmlRelPath,
    bodyHtml: body ? body.innerHTML : inlinedHtml,
    warnings
  };
}



app.get("/api/asset", async (req, res) => {
  const html = (req.query.html || "").toString();
  const assetPath = (req.query.path || "").toString();
  if (!html || !assetPath) return res.status(400).send("Missing html/path");

  try {
    const htmlAbs = safeResolveUnderRoot(html);
    const htmlDir = path.dirname(htmlAbs);

    // Resolve asset relative to the HTML file’s folder
    const assetAbs = path.resolve(htmlDir, assetPath);

    // Ensure resolved file is still under ROOT (prevents traversal)
    const normRoot = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
    if (!(assetAbs + path.sep).startsWith(normRoot) && assetAbs !== ROOT) {
      return res.status(400).send("Invalid asset path");
    }

    const buf = await fs.readFile(assetAbs);
    const ct = mime.lookup(assetAbs) || "application/octet-stream";
    res.setHeader("Content-Type", ct);
    res.send(buf);
  } catch (e) {
    res.status(404).send("Asset not found");
  }
});


// Home page: list files + bookmarklet
app.get("/", async (_req, res) => {
  const files = await listHtmlFiles();

  // Important: If Canvas is https, some browsers will block http://localhost fetches as mixed content.
  // Many allow localhost as a "secure context", but not all configurations do.
  // We keep it simple here, and document the workaround in README.
  const bookmarklet = `javascript:(()=>{try{const u='http://127.0.0.1:${PORT}/bookmarklet.js?'+Date.now();const s=document.createElement('script');s.src=u;s.async=true;document.body.appendChild(s);}catch(e){alert('Canvas uploader failed: '+e);}})();`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Canvas HTML Uploader</title></head>
<body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 24px;">
  <h1>Canvas HTML Uploader</h1>
  <p>Root: <code>${escapeHtml(ROOT)}</code></p>

  <h2>Install bookmarklet</h2>
  <p>Drag this link to your bookmarks bar:</p>
  <p><a href="${bookmarklet}" style="display:inline-block;padding:10px 14px;border:1px solid #333;border-radius:8px;text-decoration:none;">Upload to Canvas</a></p>

  <h2>Available HTML files</h2>
  <ul>
    ${files.map(f => `<li><code>${escapeHtml(f)}</code></li>`).join("")}
  </ul>

  <p style="margin-top:24px;color:#555;">
    If the bookmarklet cannot fetch from localhost due to browser mixed-content rules, run this server over HTTPS (recommended) or use a fully inlined bookmarklet.
  </p>
</body>
</html>`);
});

app.get("/api/files", async (_req, res) => {
  const files = await listHtmlFiles();
  res.json({ root: ROOT, files });
});

app.get("/api/content", async (req, res) => {
  const file = (req.query.file || "").toString();
  if (!file) return res.status(400).json({ error: "Missing ?file=" });

  try {
    const out = await inlineCssAndImages(file);
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

app.get("/bookmarklet.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.end(`(()=>{const BASE='http://127.0.0.1:${PORT}';

function log(...a){ try{ console.log('[CanvasUploader]', ...a); }catch{} }

async function fetchJson(url){
  const r = await fetch(url, { credentials: 'omit' });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  if(!r.ok){
    const msg = (data && (data.error || data.message)) ? (data.error || data.message) : ('HTTP ' + r.status);
    throw new Error(msg);
  }
  return data;
}

async function pickFile(){
  const j = await fetchJson(BASE + '/api/files');
  if(!j.files || !j.files.length) throw new Error('No HTML files found on local server.');
  const choice = prompt('Select file to upload:\\n\\n' + j.files.join('\\n') + '\\n\\nType exact path:', j.files[0]);
  if(!choice) throw new Error('Cancelled.');
  return choice;
}

function pickMode(){
  const v = (prompt('Insert mode? Type:\\n- replace (replace entire page)\\n- insert (insert at cursor)\\n','replace') || '')
    .trim().toLowerCase();
  return (v === 'insert' || v === 'i') ? 'insert' : 'replace';
}

function pickFolder(){
  const v = (prompt('Folder name for uploaded images (in Canvas Files):', 'latex_images') || '').trim();
  return v || 'latex_images';
}

function getEditor(){
  const t = window.tinymce;
  if(!t || !t.activeEditor) return null;
  const ed = t.activeEditor;
  if(ed.isHidden && ed.isHidden()) return null;
  return ed;
}

function isHttp(u){ return /^https?:\\/\\//i.test(u); }
function isSpecial(u){ return /^(data:|blob:)/i.test(u); }
function isLocalish(u){ return !!u && !isHttp(u) && !isSpecial(u); }

// Canvas API helpers (from chem-tool.js)
function getCourseId() {
  const m = location.pathname.match(/\\/courses\\/(\\d+)/);
  if (m) return m[1];
  if (window.ENV?.COURSE_ID) return String(window.ENV.COURSE_ID);
  return null;
}

function getCookie(name) {
  const m = document.cookie.match(
    new RegExp("(^|;\\\\s*)" + name.replace(/[-[\\]{}()*+?.,\\\\^$|#\\s]/g, "\\\\$&") + "=([^;]*)")
  );
  return m ? m[2] : null;
}

function getCsrfToken() {
  const meta =
    document.querySelector('meta[name="csrf-token"]') ||
    document.querySelector('meta[name="csrfToken"]') ||
    document.querySelector('meta[name="authenticity_token"]');

  if (meta?.content) return meta.content;
  if (window.ENV?.CSRF_TOKEN) return window.ENV.CSRF_TOKEN;
  if (window.ENV?.csrf_token) return window.ENV.csrf_token;

  const c = getCookie("_csrf_token");
  if (c) return decodeURIComponent(c);
  return null;
}

async function preflightCourseFileUpload(courseId, blob, filename, folderPath) {
  const csrf = getCsrfToken();
  const headers = {
    "Accept": "application/json",
    "X-Requested-With": "XMLHttpRequest"
  };
  if (csrf) headers["X-CSRF-Token"] = csrf;

  const body = new URLSearchParams();
  body.set("name", filename);
  body.set("size", String(blob.size));
  body.set("content_type", blob.type || "application/octet-stream");
  body.set("on_duplicate", "rename");
  if (folderPath) body.set("parent_folder_path", folderPath);
  if (csrf) body.set("authenticity_token", csrf);

  const resp = await fetch("/api/v1/courses/" + courseId + "/files", {
    method: "POST",
    credentials: "same-origin",
    headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: body.toString()
  });

  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!resp.ok) throw { status: resp.status, json, raw: text };
  return json;
}

async function uploadAndFinalize(preData, blob, filename) {
  const form = new FormData();
  for (const [k, v] of Object.entries(preData.upload_params)) form.append(k, v);
  form.append("file", blob, filename);

  const up = await fetch(preData.upload_url, {
    method: "POST",
    body: form,
    redirect: "manual"
  });

  const loc = up.headers.get("Location");
  if (loc) {
    const fin = await fetch(loc, {
      credentials: "same-origin",
      headers: { "Accept": "application/json" }
    });
    const finText = await fin.text();
    let finJson;
    try { finJson = JSON.parse(finText); } catch { finJson = { raw: finText }; }
    if (!fin.ok) throw { status: fin.status, json: finJson, raw: finText };
    return finJson;
  }

  const upText = await up.text();
  let upJson;
  try { upJson = JSON.parse(upText); } catch { upJson = { raw: upText }; }
  if (!up.ok) throw { status: up.status, json: upJson, raw: upText };
  return upJson;
}

function pickUrl(fileJson) {
  return fileJson?.url
    || fileJson?.download_url
    || fileJson?.preview_url
    || null;
}

async function uploadImageToCanvas(courseId, blob, filename, folderPath) {
  const preData = await preflightCourseFileUpload(courseId, blob, filename, folderPath);
  const fileJson = await uploadAndFinalize(preData, blob, filename);
  const url = pickUrl(fileJson);
  if (!url) throw new Error("Upload succeeded but no usable url found.");
  return url;
}

async function uploadImagesViaCanvasAPI(htmlContent, htmlFileRelPath, courseId, folderPath){
  // Parse the HTML content to find images
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlContent, 'text/html');
  const imgs = Array.from(doc.querySelectorAll('img'))
    .filter(img => isLocalish((img.getAttribute('src') || '').trim()));

  if(!imgs.length) return { updatedHtml: htmlContent, converted: 0, total: 0 };

  let converted = 0;

  for(const img of imgs){
    const src = (img.getAttribute('src') || '').trim();
    try{
      const assetUrl = BASE + '/api/asset?html=' + encodeURIComponent(htmlFileRelPath) +
                       '&path=' + encodeURIComponent(src);
      const r = await fetch(assetUrl, { credentials: 'omit' });
      if(!r.ok) throw new Error('asset fetch failed ' + r.status);

      const blob = await r.blob();
      const filename = (src.split('/').pop() || 'image').replace(/\\.[^.]+$/, '') + '_' + Date.now() + '.' + (src.split('.').pop() || 'png');

      log('Uploading image to Canvas:', filename);
      const canvasUrl = await uploadImageToCanvas(courseId, blob, filename, folderPath);
      
      img.setAttribute('src', canvasUrl);
      converted++;
      log('Image uploaded:', canvasUrl);
    }catch(e){
      console.warn('[CanvasUploader] Could not upload image:', src, e);
    }
  }

  // Return the updated HTML with new image URLs
  return { updatedHtml: doc.body.innerHTML, converted, total: imgs.length };
}

(async()=>{
  try{
    const file = await pickFile();
    const mode = pickMode();
    const folderPath = pickFolder();

    const courseId = getCourseId();
    if (!courseId) throw new Error('Could not detect courseId from URL (/courses/:id/…).');

    log('Fetching processed content for', file);
    const content = await fetchJson(BASE + '/api/content?file=' + encodeURIComponent(file));
    if(content.warnings && content.warnings.length){
      console.warn('[CanvasUploader] Warnings:', content.warnings);
    }

    const ed = getEditor();
    if(!ed) throw new Error('TinyMCE editor not detected. Click Edit and ensure the RCE is visible.');

    // Upload images BEFORE inserting content
    log('Uploading images to Canvas...');
    const up = await uploadImagesViaCanvasAPI(content.bodyHtml, file, courseId, folderPath);
    log('Images uploaded:', up);

    // Insert the content with updated image URLs
    ed.focus();
    ed.undoManager.transact(() => {
      if(mode === 'insert') ed.insertContent(up.updatedHtml, { format: 'html' });
      else ed.setContent(up.updatedHtml, { format: 'html' });
    });
    ed.nodeChanged();
    ed.setDirty(true);

    alert('Upload complete. Mode: ' + mode + (up.total ? ('; images uploaded: ' + up.converted + '/' + up.total) : ''));
  }catch(e){
    console.error(e);
    alert('Canvas upload failed: ' + (e && e.message ? e.message : e));
  }
})();})();`);
});



app.listen(PORT, "127.0.0.1", () => {
  console.log(`Canvas HTML Uploader running: http://127.0.0.1:${PORT}`);
  console.log(`Root directory: ${ROOT}`);
});

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
